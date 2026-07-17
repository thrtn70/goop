use goop_core::{
    is_cookie_db_error, EventSink, GoopError, Interrupt, JobId, JobSignals, ProgressEvent,
    SidecarEvent,
};
use goop_sidecar::BinaryResolver;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::ytdlp::{ExtractRequest, UrlProbe, STDERR_DRAIN_GRACE};

/// Browsers gallery-dl is willing to read cookies from. Same allowlist
/// as `ytdlp::SUPPORTED_BROWSERS` — the two extractors share the
/// `--cookies-from-browser` flag and accept identical browser names.
/// Defense-in-depth: validate even though the IPC layer already
/// validates against `goop_config::SUPPORTED_BROWSERS`.
const SUPPORTED_BROWSERS: &[&str] = &[
    "brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale",
];

fn validated_browser(name: Option<&str>) -> Option<&'static str> {
    let n = name?;
    SUPPORTED_BROWSERS.iter().copied().find(|b| *b == n)
}

/// Wrapper around the bundled gallery-dl sidecar. Same shape as `YtDlp`:
/// borrows a `BinaryResolver` and an `EventSink`. Probe is a static
/// method so callers can introspect a URL without constructing the
/// instance.
pub struct GalleryDl<'a> {
    resolver: &'a BinaryResolver,
    sink: Arc<dyn EventSink>,
}

/// Result of a gallery-dl `extract` call. `output_path` points at the
/// folder gallery-dl wrote into; `file_count` is the number of files
/// actually downloaded (parsed from gallery-dl's stderr).
pub struct GalleryDlResult {
    pub output_path: String,
    pub bytes: u64,
    pub file_count: u32,
    pub duration_ms: u64,
}

impl<'a> GalleryDl<'a> {
    pub fn new(resolver: &'a BinaryResolver, sink: Arc<dyn EventSink>) -> Self {
        Self { resolver, sink }
    }

    /// Probe a URL with `gallery-dl --simulate -j`. Returns minimal
    /// metadata Goop's UI shows in the URL preview.
    ///
    /// gallery-dl's `-j` JSON output is an array of `[type, url, info]`
    /// triples — we walk it once to pick out a representative title and
    /// count items. Most extractors set `info["title"]` for collection
    /// objects (type 2) and individual file metadata for type 3.
    ///
    /// On a cookie-DB read failure (Chrome v127+ DPAPI lock, missing
    /// browser, etc.), retries silently without `--cookies-from-browser`.
    /// The retry is silent because `probe` has no event sink to surface
    /// a warning through; in the typical flow the user sees the warning
    /// when the actual `download` retries. Best-effort: if the download
    /// path doesn't reproduce the cookie failure, no warning lands —
    /// the user just silently proceeds without cookies, which is
    /// acceptable since the extract still succeeds.
    pub async fn probe(
        resolver: &BinaryResolver,
        url: &str,
        cookies_from_browser: Option<&str>,
    ) -> Result<UrlProbe, GoopError> {
        let bin = resolver.resolve("gallery-dl")?;
        let first = Self::probe_once(&bin.path, url, cookies_from_browser).await;
        match first {
            Err(GoopError::SubprocessFailed { ref stderr, .. })
                if cookies_from_browser.is_some() && is_cookie_db_error(stderr) =>
            {
                // Silent retry without cookies. Probe is sinkless — the
                // download step will emit the user-facing warning toast.
                Self::probe_once(&bin.path, url, None).await
            }
            other => other,
        }
    }

    async fn probe_once(
        bin_path: &std::path::Path,
        url: &str,
        cookies: Option<&str>,
    ) -> Result<UrlProbe, GoopError> {
        let mut cmd = Command::new(bin_path);
        cmd.args(["--simulate", "-j", "--quiet"]);
        if let Some(browser) = validated_browser(cookies) {
            cmd.arg("--cookies-from-browser").arg(browser);
        }
        cmd.arg(url);
        let out = cmd.output().await?;
        if !out.status.success() {
            // Store raw stderr; friendly_message is applied at the IPC
            // boundary so the dispatch layer can still inspect raw
            // markers (Unsupported URL, etc.) for fallback decisions.
            return Err(GoopError::SubprocessFailed {
                binary: "gallery-dl".into(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        let parsed: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
        let (title, count, thumbnail_url, uploader) = summarise_probe(&parsed);
        Ok(UrlProbe {
            url: url.to_string(),
            title: if title.is_empty() {
                format!("{count} item(s)")
            } else {
                title
            },
            uploader,
            duration_secs: None,
            thumbnail_url,
            // Image-host URLs don't have meaningful "format" choices the
            // way video URLs do; surface an empty list so the frontend
            // skips the format picker.
            formats: Vec::new(),
            direct: None,
        })
    }

    /// Download every file at `url` into `req.output_dir`. Returns the
    /// folder path + total bytes + count once gallery-dl exits 0.
    /// Cancellation kills the child process and removes any partial
    /// `.part` files gallery-dl left behind.
    ///
    /// On a cookie-DB read failure (Chrome v127+ DPAPI lock, missing
    /// browser, etc.) when `req.cookies_from_browser` was set, retries
    /// once without `--cookies-from-browser` and emits a one-shot
    /// `SidecarEvent::Warning` so the UI can toast the user. Cancellation
    /// short-circuits the retry.
    pub async fn download(
        &self,
        job_id: JobId,
        req: &ExtractRequest,
        signals: JobSignals,
    ) -> Result<GalleryDlResult, GoopError> {
        let bin = self.resolver.resolve("gallery-dl")?;
        let output_dir = canonical_output_dir(&req.output_dir)?;

        let first = self
            .download_once(
                job_id,
                req,
                &bin.path,
                &output_dir,
                signals.clone(),
                /* with_cookies: */ true,
            )
            .await;

        match first {
            Err(GoopError::SubprocessFailed { ref stderr, .. })
                if is_cookie_db_error(stderr)
                    && req.cookies_from_browser.is_some()
                    && signals.check().is_none() =>
            {
                let browser = req.cookies_from_browser.as_deref().unwrap_or("the browser");
                self.sink.emit_sidecar(SidecarEvent::Warning {
                    code: "cookie_fallback".into(),
                    message: format!(
                        "Couldn't read {browser} cookies — proceeded without. \
                         Close {browser} fully and retry to use logged-in cookies."
                    ),
                });
                self.download_once(
                    job_id,
                    req,
                    &bin.path,
                    &output_dir,
                    signals,
                    /* with_cookies: */ false,
                )
                .await
            }
            other => other,
        }
    }

    /// Single spawn + drive of gallery-dl. `with_cookies = false` omits
    /// the `--cookies-from-browser` flag regardless of
    /// `req.cookies_from_browser` — used by the retry path on cookie-DB
    /// read failures.
    async fn download_once(
        &self,
        job_id: JobId,
        req: &ExtractRequest,
        bin_path: &std::path::Path,
        output_dir: &std::path::Path,
        signals: JobSignals,
        with_cookies: bool,
    ) -> Result<GalleryDlResult, GoopError> {
        let mut cmd = Command::new(bin_path);
        cmd.arg("--directory")
            .arg(output_dir)
            // Skip per-extractor JSON metadata sidecars by default — the
            // user wants the media files, not gallery-dl bookkeeping.
            .arg("--no-mtime")
            .arg("-o")
            .arg("output.metadata=null")
            // Quiet INFO logs but keep the file-completion lines we need
            // for progress counting. gallery-dl's default skip-existing
            // behaviour is deliberately left in effect: it is what makes a
            // paused or retried album re-run cheap (finished files are
            // skipped, the in-flight `.part` is resumed).
            .arg("--quiet");
        if with_cookies {
            if let Some(browser) = validated_browser(req.cookies_from_browser.as_deref()) {
                cmd.arg("--cookies-from-browser").arg(browser);
            }
        }
        cmd.arg(&req.url)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let started = std::time::Instant::now();
        // The scan cutoff survives across pause/resume and retry re-runs
        // via an on-disk marker, so the post-exit tally counts the whole
        // album from the FIRST attempt's start — not just files touched by
        // this run. Without it, a resume of an already-complete album
        // would tally zero files and fail as "no extractable content".
        let marker_path = start_marker_path(output_dir, &req.url);
        let scan_cutoff = read_or_init_start_marker(&marker_path);
        let mut child: Child = cmd.spawn()?;
        // invariant: stdout was requested with Stdio::piped above.
        let stdout = child.stdout.take().expect("stdout was piped");
        // invariant: stderr was requested with Stdio::piped above.
        let stderr = child.stderr.take().expect("stderr was piped");
        let mut out_reader = BufReader::new(stdout).lines();
        let mut err_reader = BufReader::new(stderr).lines();

        // In-loop counting is best-effort — we use it only to drive
        // progress events. The authoritative file count + bytes total
        // comes from a post-exit directory scan (see `scan_outputs`
        // below) so we don't suffer from a TOCTOU race between
        // gallery-dl printing a path and the VFS materialising it.
        let mut in_loop_count: u32 = 0;
        let mut stderr_tail = String::new();
        // Sticky witness for the cookie-DB error. See ytdlp.rs for the
        // full rationale: stderr_tail is a ring-buffer; we capture the
        // first matching line so the retry guard in `download` can still
        // recognise the failure even if later stderr flushes the line
        // out of the tail window.
        let mut cookie_error_line: Option<String> = None;

        // Drain BOTH streams to EOF rather than stopping at stdout's. See
        // `ytdlp::download_once` for the full rationale: the loop is
        // biased toward stdout, so a child that closed stdout early would
        // otherwise end it with stderr never read, and every decision the
        // caller makes is a substring test over that stderr. The
        // `if !*_done` guards keep an EOF'd reader from spinning the loop.
        let mut out_done = false;
        let mut err_done = false;
        while !(out_done && err_done) {
            tokio::select! {
                // biased: a fired stop signal must win over further
                // subprocess output, deterministically — same discipline
                // as the direct downloader's loop.
                biased;
                int = signals.interrupted() => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return Err(finish_interrupt(int, output_dir, &marker_path));
                }
                line = out_reader.next_line(), if !out_done => {
                    match line? {
                        Some(l) => {
                            // gallery-dl with --quiet still prints completed
                            // file paths to stdout — one per line, no prefix.
                            // Count any non-empty line as a completion for
                            // progress purposes (the post-exit scan filters
                            // for actual files). Treating every non-empty
                            // line as a tick is intentional: an extractor
                            // emitting an unexpected non-path line gives a
                            // slightly inflated progress count, which is
                            // strictly less bad than a false-negative
                            // dropping a completed file from the tally.
                            let trimmed = l.trim();
                            if !trimmed.is_empty() {
                                in_loop_count += 1;
                                self.sink.emit_progress(ProgressEvent {
                                    job_id,
                                    percent: 0.0,
                                    eta_secs: None,
                                    speed_hr: None,
                                    stage: format!(
                                        "downloaded {in_loop_count} file(s)"
                                    ),
                                    encoder: None,
                                });
                            }
                        }
                        None => out_done = true,
                    }
                }
                line = err_reader.next_line(), if !err_done => {
                    match line {
                        Ok(Some(l)) => {
                            if cookie_error_line.is_none() && is_cookie_db_error(&l) {
                                cookie_error_line = Some(l.clone());
                            }
                            stderr_tail.push_str(&l);
                            stderr_tail.push('\n');
                            if stderr_tail.len() > 8192 {
                                // Walk forward to the next char boundary so a
                                // truncation in the middle of a multi-byte UTF-8
                                // sequence (CJK / emoji in extractor errors)
                                // doesn't panic at the slice.
                                let mut drop_to = stderr_tail.len() - 4096;
                                while drop_to < stderr_tail.len()
                                    && !stderr_tail.is_char_boundary(drop_to)
                                {
                                    drop_to += 1;
                                }
                                stderr_tail = stderr_tail[drop_to..].to_string();
                            }
                        }
                        Ok(None) => err_done = true,
                        // One undecodable line. tokio consumes the bad
                        // bytes before validating them, so the reader has
                        // already moved on — skip it and keep the rest of
                        // the message rather than dropping everything after
                        // the first bad byte. See `ytdlp::download_once`.
                        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {}
                        // A real IO error won't clear on the next poll.
                        Err(_) => err_done = true,
                    }
                }
                // Bounds the drain against a grandchild holding stderr open
                // past the child's exit. Inactivity window, reset by any
                // stderr line. See `ytdlp::download_once`.
                _ = tokio::time::sleep(STDERR_DRAIN_GRACE), if out_done && !err_done => {
                    tracing::warn!(
                        "gallery-dl stderr still open after stdout EOF; \
                         proceeding with the {} bytes collected so far",
                        stderr_tail.len()
                    );
                    err_done = true;
                }
            }
        }

        let status = child.wait().await?;
        if !status.success() {
            // Preserve the cookie-error signal even if the tail
            // truncated it out — prepend the captured line so the retry
            // guard in `download` can still recognise the failure.
            let stderr = match cookie_error_line {
                Some(ref line) if !is_cookie_db_error(&stderr_tail) => {
                    format!("{line}\n{stderr_tail}")
                }
                _ => stderr_tail,
            };
            return Err(GoopError::SubprocessFailed {
                binary: "gallery-dl".into(),
                stderr,
            });
        }
        // Authoritative count: walk the output directory for files
        // created/modified after the run started. Avoids the TOCTOU
        // race the in-loop is_file() check had where a freshly-renamed
        // file might not show up as a regular file by the time the
        // event-loop reads gallery-dl's stdout line for it.
        let (file_count, bytes) = scan_outputs(output_dir, scan_cutoff);
        if file_count == 0 {
            // gallery-dl exited 0 but the output dir has no new files —
            // likely the URL probed cleanly but had no extractable
            // content (private album, empty user profile, etc.). The
            // marker is kept so a manual retry still tallies from the
            // original start.
            return Err(GoopError::SubprocessFailed {
                binary: "gallery-dl".into(),
                stderr: "URL valid but no extractable content".into(),
            });
        }
        let _ = std::fs::remove_file(&marker_path);
        Ok(GalleryDlResult {
            output_path: output_dir.to_string_lossy().into_owned(),
            bytes,
            file_count,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }
}

/// Walk `output_dir` recursively for regular files modified at or after
/// `cutoff`. Returns `(count, total_bytes)`. Used as the authoritative
/// post-exit tally — robust against the in-loop `is_file()` race that
/// could mis-count files freshly renamed during the download. The cutoff
/// is the run's persisted start marker so pause/resume and retry re-runs
/// tally every file the album produced since the first attempt.
fn scan_outputs(output_dir: &std::path::Path, cutoff: std::time::SystemTime) -> (u32, u64) {
    let started_wall = cutoff;
    let mut count = 0u32;
    let mut bytes = 0u64;
    let mut stack: Vec<PathBuf> = vec![output_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            // Skip gallery-dl's `.part` partials and hidden bookkeeping
            // files (the run's start marker, the direct downloader's
            // sidecars) — none are user-facing outputs and both would
            // inflate the tally.
            if path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e == "part")
                || path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with('.'))
            {
                continue;
            }
            let recent = meta.modified().map(|m| m >= started_wall).unwrap_or(false);
            if recent {
                count += 1;
                bytes += meta.len();
            }
        }
    }
    (count, bytes)
}

/// Walk gallery-dl's `-j` JSON output and extract a representative
/// title, item count, first thumbnail URL, and uploader. The output
/// shape is `[[type, url, info], ...]` per gallery-dl's documentation.
/// Type 2 = collection metadata; type 3 = individual file. We prefer
/// the first collection title; fall back to the first file's title.
fn summarise_probe(parsed: &serde_json::Value) -> (String, usize, Option<String>, Option<String>) {
    let mut title = String::new();
    let mut thumbnail_url: Option<String> = None;
    let mut uploader: Option<String> = None;
    let mut count = 0usize;

    if let Some(arr) = parsed.as_array() {
        for triple in arr {
            let Some(triple) = triple.as_array() else {
                continue;
            };
            let Some(kind) = triple.first().and_then(|v| v.as_u64()) else {
                continue;
            };
            let Some(info) = triple.get(2) else { continue };
            match kind {
                2 if title.is_empty() => {
                    if let Some(t) = info.get("title").and_then(|v| v.as_str()) {
                        title = t.to_string();
                    }
                    if uploader.is_none() {
                        uploader = info
                            .get("user")
                            .or_else(|| info.get("uploader"))
                            .or_else(|| info.get("author"))
                            .and_then(|v| v.as_str())
                            .map(String::from);
                    }
                }
                3 => {
                    count += 1;
                    if title.is_empty() {
                        if let Some(t) = info.get("title").and_then(|v| v.as_str()) {
                            title = t.to_string();
                        }
                    }
                    if thumbnail_url.is_none() {
                        thumbnail_url = info
                            .get("thumbnail")
                            .or_else(|| info.get("preview"))
                            .and_then(|v| v.as_str())
                            .map(String::from);
                    }
                }
                _ => {}
            }
        }
    }
    (title, count, thumbnail_url, uploader)
}

fn canonical_output_dir(raw: &str) -> Result<PathBuf, GoopError> {
    let expanded = goop_core::path::expand(raw);
    let dir = std::fs::canonicalize(&expanded)?;
    if !dir.is_dir() {
        return Err(GoopError::Config(format!(
            "output path is not a directory: {}",
            expanded.display()
        )));
    }
    Ok(dir)
}

/// Best-effort cleanup of gallery-dl's `.part` files on cancel. Mirrors
/// the cleanup_partials helper in `ytdlp.rs`. Limited to files modified
/// in the last hour so we don't sweep stale partials from earlier runs.
/// Cancel: the user is done — remove recent `.part` partials and the
/// run's start marker. Pause: keep both; a re-run skips finished files
/// (gallery-dl's default), resumes the in-flight `.part`, and tallies
/// the album from the marker's original start time.
///
/// Caveat: resume relies on gallery-dl DEFAULTS (part files on, skip
/// enabled); a user-level gallery-dl config that disables either turns
/// resume into a re-download. Accepted for now — Goop doesn't pass
/// `--config-ignore`.
fn finish_interrupt(
    int: Interrupt,
    output_dir: &std::path::Path,
    marker_path: &std::path::Path,
) -> GoopError {
    match int {
        Interrupt::Cancel => {
            cleanup_partials(output_dir);
            let _ = std::fs::remove_file(marker_path);
            GoopError::Cancelled
        }
        Interrupt::Pause => GoopError::Paused,
    }
}

/// The per-URL start marker: unix-millis of the first attempt's start,
/// keyed by URL hash so concurrent albums in one folder don't collide.
fn start_marker_path(output_dir: &std::path::Path, url: &str) -> PathBuf {
    output_dir.join(format!(".{}.goopdl.t0", crate::direct::url_hash(url)))
}

/// How long a start marker stays trusted. A marker older than this is a
/// leftover from an abandoned run (the queue never sits on a paused or
/// failed job that long without the partials going stale too) — re-init
/// rather than tally a week of unrelated files into the album.
const START_MARKER_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 3600);

/// Read the persisted run-start time, or initialise it to now. Garbage
/// content, future timestamps, and stale markers all re-initialise.
fn read_or_init_start_marker(marker_path: &std::path::Path) -> std::time::SystemTime {
    let now = std::time::SystemTime::now();
    if let Ok(content) = std::fs::read_to_string(marker_path) {
        if let Ok(ms) = content.trim().parse::<u64>() {
            let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms);
            let fresh = now
                .duration_since(t)
                .map(|age| age <= START_MARKER_MAX_AGE)
                .unwrap_or(false);
            if fresh {
                return t;
            }
        }
    }
    let ms = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let _ = std::fs::write(marker_path, ms.to_string());
    now
}

/// Remove the URL's partials AND start marker — the full cancel-of-paused
/// cleanup, callable from outside a running download.
pub(crate) fn cleanup_run_artifacts(output_dir: &std::path::Path, url: &str) {
    cleanup_partials(output_dir);
    let _ = std::fs::remove_file(start_marker_path(output_dir, url));
}

fn cleanup_partials(output_dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(output_dir) else {
        return;
    };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(3600))
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    for entry in entries.flatten() {
        let path = entry.path();
        let is_partial = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e == "part");
        if !is_partial {
            continue;
        }
        let recent = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| m >= cutoff)
            .unwrap_or(false);
        if recent {
            if let Err(e) = std::fs::remove_file(&path) {
                tracing::debug!(path = %path.display(), error = %e, "failed to remove partial file");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validated_browser_accepts_known_names() {
        assert_eq!(validated_browser(Some("chrome")), Some("chrome"));
        assert_eq!(validated_browser(Some("firefox")), Some("firefox"));
        assert_eq!(validated_browser(Some("safari")), Some("safari"));
    }

    #[test]
    fn validated_browser_rejects_unknown_or_path_traversal() {
        assert_eq!(validated_browser(None), None);
        assert_eq!(validated_browser(Some("netscape")), None);
        // gallery-dl supports profile-suffix syntax; we reject it for
        // the same reason ytdlp.rs does — we don't expose profile
        // selection in the UI and the suffix can carry filesystem paths.
        assert_eq!(validated_browser(Some("chrome:../../tmp/evil")), None);
        assert_eq!(validated_browser(Some("firefox:default")), None);
        assert_eq!(validated_browser(Some("")), None);
        assert_eq!(validated_browser(Some(" chrome")), None);
    }

    #[test]
    fn summarise_probe_handles_collection_then_files() {
        let parsed = serde_json::json!([
            [2, "https://bunkr.cr/a/abc", {"title": "Sample Album", "user": "alice"}],
            [3, "https://media.bunkr.cr/01.jpg", {"thumbnail": "https://bunkr.cr/thumb/01.jpg"}],
            [3, "https://media.bunkr.cr/02.jpg", {}]
        ]);
        let (title, count, thumb, uploader) = summarise_probe(&parsed);
        assert_eq!(title, "Sample Album");
        assert_eq!(count, 2);
        assert_eq!(thumb.as_deref(), Some("https://bunkr.cr/thumb/01.jpg"));
        assert_eq!(uploader.as_deref(), Some("alice"));
    }

    #[test]
    fn summarise_probe_handles_files_only() {
        // A direct image URL has no collection wrapper — only type-3
        // entries. Fall back to the first file's title.
        let parsed = serde_json::json!([
            [3, "https://i.imgur.com/abc.jpg", {"title": "single image"}]
        ]);
        let (title, count, _, _) = summarise_probe(&parsed);
        assert_eq!(title, "single image");
        assert_eq!(count, 1);
    }

    #[test]
    fn summarise_probe_handles_empty() {
        let (title, count, thumb, uploader) = summarise_probe(&serde_json::json!([]));
        assert_eq!(title, "");
        assert_eq!(count, 0);
        assert!(thumb.is_none());
        assert!(uploader.is_none());
    }

    #[test]
    fn finish_interrupt_pause_keeps_part_and_marker_cancel_removes_both() {
        let dir = tempfile::tempdir().unwrap();
        let url = "https://example.com/album";
        let part = dir.path().join("photo.jpg.part");
        let marker = start_marker_path(dir.path(), url);
        std::fs::write(&part, b"x").unwrap();
        std::fs::write(&marker, "1000").unwrap();

        let err = finish_interrupt(Interrupt::Pause, dir.path(), &marker);
        assert!(matches!(err, GoopError::Paused));
        assert!(part.exists(), "pause keeps the in-flight .part");
        assert!(marker.exists(), "pause keeps the tally marker");

        let err = finish_interrupt(Interrupt::Cancel, dir.path(), &marker);
        assert!(matches!(err, GoopError::Cancelled));
        assert!(!part.exists(), "cancel removes the .part");
        assert!(!marker.exists(), "cancel removes the marker");
    }

    #[test]
    fn start_marker_init_read_and_staleness() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join(".abc.goopdl.t0");
        let now = std::time::SystemTime::now();

        // Missing: initialised to ~now and persisted.
        let t = read_or_init_start_marker(&marker);
        assert!(marker.exists());
        assert!(now.duration_since(t).unwrap_or_default().as_secs() < 5);

        // Valid recent value: returned as-is.
        let hour_ago = now - std::time::Duration::from_secs(3600);
        let ms = hour_ago
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        std::fs::write(&marker, ms.to_string()).unwrap();
        let t = read_or_init_start_marker(&marker);
        let drift = t
            .duration_since(hour_ago)
            .or_else(|_| hour_ago.duration_since(t))
            .unwrap();
        assert!(drift.as_millis() < 5, "persisted value round-trips");

        // Garbage content: re-initialised.
        std::fs::write(&marker, "not a number").unwrap();
        let t = read_or_init_start_marker(&marker);
        assert!(now.duration_since(t).unwrap_or_default().as_secs() < 5);

        // Stale (8 days old): re-initialised.
        let stale = now - std::time::Duration::from_secs(8 * 24 * 3600);
        let ms = stale
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        std::fs::write(&marker, ms.to_string()).unwrap();
        let t = read_or_init_start_marker(&marker);
        assert!(
            now.duration_since(t).unwrap_or_default().as_secs() < 5,
            "stale marker must not be trusted"
        );
    }

    #[test]
    fn scan_outputs_counts_from_cutoff_and_skips_bookkeeping_files() {
        let dir = tempfile::tempdir().unwrap();
        // Simulates a resumed run: the cutoff is an hour in the past (the
        // first attempt's start), files on disk were written since then.
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::write(dir.path().join("one.jpg"), b"aaaa").unwrap();
        std::fs::write(dir.path().join("two.jpg"), b"bb").unwrap();
        std::fs::write(dir.path().join("three.jpg.part"), b"cc").unwrap();
        std::fs::write(dir.path().join(".xyz.goopdl.t0"), b"123").unwrap();

        let (count, bytes) = scan_outputs(dir.path(), cutoff);
        assert_eq!(count, 2, "partials and hidden bookkeeping are skipped");
        assert_eq!(bytes, 6);
    }

    #[test]
    fn cleanup_run_artifacts_removes_partials_and_marker() {
        let dir = tempfile::tempdir().unwrap();
        let url = "https://example.com/album";
        let part = dir.path().join("photo.jpg.part");
        let marker = start_marker_path(dir.path(), url);
        std::fs::write(&part, b"x").unwrap();
        std::fs::write(&marker, "1000").unwrap();
        cleanup_run_artifacts(dir.path(), url);
        assert!(!part.exists());
        assert!(!marker.exists());
    }
}
