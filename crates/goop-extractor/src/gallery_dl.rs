use goop_core::{
    is_cookie_db_error, EventSink, GoopError, Interrupt, JobId, JobSignals, ProgressEvent,
    SidecarEvent, WarningCode,
};
use goop_sidecar::BinaryResolver;
use std::collections::HashSet;
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
/// folder gallery-dl wrote into; `file_count` and `bytes` cover the files
/// it named on stdout as belonging to this URL, whether it fetched them
/// this run or found them already there.
#[derive(Debug)]
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
            debrid: None,
            extractor: Some(crate::classify::ExtractorChoice::GalleryDl),
        })
    }

    /// Download every file at `url` into `req.output_dir`. Returns the
    /// folder path + total bytes + count once gallery-dl exits 0.
    /// Cancellation kills the child process and removes any partial
    /// `.part` files gallery-dl left behind.
    ///
    /// On a cookie-DB read failure (Chrome v127+ DPAPI lock, missing
    /// browser, etc.) when `req.cookies_from_browser` was set, retries
    /// once without `--cookies-from-browser` and emits a
    /// `SidecarEvent::Warning` so the UI can toast the user. Cancellation
    /// short-circuits the retry.
    ///
    /// This warns once per call, which is NOT once per dispatch — we may
    /// run as dispatch's fallback after yt-dlp already warned about the
    /// same locked cookie DB, or be re-run by the retry layer. Collapsing
    /// those repeats is `WarnOnceSink`'s job, installed by
    /// `backend::dispatch_with_policy` — don't add a guard here.
    ///
    /// `pub(crate)` on purpose: callers must come through
    /// `backend::dispatch`, which installs that `WarnOnceSink`. A direct
    /// call would silently bypass it.
    pub(crate) async fn download(
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
                    code: WarningCode::CookieFallback,
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
            // The tally is built from the paths gallery-dl reports on
            // stdout, so pin the two config keys that decide what lands
            // there — a user-level gallery-dl config can set either, and we
            // don't pass `--config-ignore`:
            //
            //   mode=pipe  what it picks anyway when stdout is not a
            //              terminal. "terminal" would shorten long paths to
            //              a width we don't have; "null" prints nothing.
            //   skip=true  the default. `false` drops the `# <path>` line
            //              for a file already on disk — which on a re-run of
            //              a complete album is every file it has.
            //
            // gallery-dl's own skip-existing behaviour is deliberately left
            // in effect: it is what makes a paused or retried album re-run
            // cheap (finished files are skipped, the in-flight `.part` is
            // resumed).
            //
            // Deliberately NOT `--quiet`. It sets the log level to ERROR,
            // and gallery-dl forces `output.mode=null` for any level at or
            // above WARNING — after `-o` has been applied, so it cannot be
            // pinned back. It silences the very lines this reads. Default
            // INFO logging costs nothing in exchange: a successful run
            // writes nothing to stderr, and a failing one is bounded by the
            // tail window below.
            //
            // `probe_once` still passes `--quiet` and still reads stdout,
            // which is not a contradiction: `-j` runs a different job type
            // that writes its JSON to stdout directly, bypassing the output
            // module this flag disables.
            .arg("-o")
            .arg("output.mode=pipe")
            .arg("-o")
            .arg("output.skip=true")
            // And pin the ENCODING of that stream, not just what goes on it.
            //
            // gallery-dl reconfigures its own stdout with `errors="replace"`
            // and leaves the encoding to Python, which for a redirected
            // stream is the locale's — the ANSI codepage on Windows. Any
            // character outside it is written as `?`, so a CJK, Cyrillic or
            // emoji filename arrives here as a path that does not exist. The
            // tally stats it, misses, and silently drops the file; with a
            // whole album mangled the run reports "no extractable content"
            // while every file sits on disk.
            //
            // Reproduced against gallery-dl 1.32.3 under `PYTHONIOENCODING=cp1252`:
            // `…__日本語テスト.jpg` printed as `…__??????.jpg`, and correctly
            // with this pin. Goes through gallery-dl's own config rather than
            // `PYTHONUTF8=1`, which a PyInstaller build may ignore.
            //
            // The old directory walk never read a printed byte and was immune,
            // so this is the cost of moving to identity — pay it here.
            .arg("-o")
            .arg("output.stdout=utf-8");
        if with_cookies {
            if let Some(browser) = validated_browser(req.cookies_from_browser.as_deref()) {
                cmd.arg("--cookies-from-browser").arg(browser);
            }
        }
        cmd.arg(&req.url)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let started = std::time::Instant::now();
        let mut child: Child = cmd.spawn()?;
        // invariant: stdout was requested with Stdio::piped above.
        let stdout = child.stdout.take().expect("stdout was piped");
        // invariant: stderr was requested with Stdio::piped above.
        let stderr = child.stderr.take().expect("stderr was piped");
        let mut out_reader = BufReader::new(stdout).lines();
        let mut err_reader = BufReader::new(stderr).lines();

        // The files this run is answerable for, by identity rather than by
        // timestamp. gallery-dl names every file it fetched or skipped, so
        // this URL's tally stays this URL's even though every extract job
        // shares one downloads folder by default. Sizing them is deferred
        // to after the child exits — see `tally_reported`.
        //
        // Grows with the album and is not capped: one path per file, so a
        // 50k-image profile crawl costs single-digit MB. Bounding it would
        // mean choosing which files not to count.
        let mut reported: HashSet<PathBuf> = HashSet::new();
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
                    return Err(finish_interrupt(int, output_dir));
                }
                line = out_reader.next_line(), if !out_done => {
                    match line {
                        Ok(Some(l)) => {
                            // One reportable line per file gallery-dl
                            // handled. New ones drive progress; the set is
                            // what the post-exit tally is computed from.
                            match reported_output(&l, output_dir) {
                                Some(path) => if reported.insert(path) {
                                    self.sink.emit_progress(ProgressEvent {
                                        job_id,
                                        percent: 0.0,
                                        eta_secs: None,
                                        speed_hr: None,
                                        stage: format!(
                                            "downloaded {} file(s)",
                                            reported.len()
                                        ),
                                        encoder: None,
                                    });
                                },
                                // Only blank lines are expected here. Log
                                // the rest: a line we can't place is the
                                // one symptom of a stdout contract that has
                                // shifted under us, and the tally goes to
                                // zero without it ever being visible.
                                None if !l.trim().is_empty() => tracing::debug!(
                                    line = %l,
                                    dir = %output_dir.display(),
                                    "gallery-dl named a path outside the output directory"
                                ),
                                None => {}
                            }
                        }
                        Ok(None) => out_done = true,
                        // Same treatment as stderr below: tokio has already
                        // consumed the bad bytes, so skip the line and keep
                        // reading. Do NOT propagate — an early return here
                        // leaves the child unreaped and still writing into
                        // the user's folder while the retry layer starts a
                        // second one on the same URL and directory.
                        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {}
                        // A real IO error won't clear on the next poll.
                        Err(_) => out_done = true,
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
        // Authoritative count: the files gallery-dl named, sized now that
        // it has exited. Skipped files count as much as fetched ones — a
        // re-run of a complete album is all skips, and the album is still
        // there. That is what makes re-running a link to pick up new posts
        // succeed when there are none, which is the normal way to use these
        // sites.
        let reported_count = reported.len();
        let (file_count, bytes) = tokio::task::spawn_blocking(move || tally_reported(&reported))
            .await
            .map_err(std::io::Error::other)?;
        if file_count == 0 {
            // gallery-dl exited 0 having named no file that is on disk —
            // the URL probed cleanly but had no extractable content
            // (private album, empty user profile, etc.). Whatever else is
            // in the output folder belongs to some other URL and cannot
            // stand in for this one.
            //
            // `reported` separates "said nothing" (the honest empty album)
            // from "named files that aren't there", which is the shape a
            // config surprise takes — a per-extractor `base-directory`
            // beating the root one `--directory` sets, say. Both reach the
            // user as the same message, so leave a trail here.
            tracing::warn!(
                reported = reported_count,
                dir = %output_dir.display(),
                "gallery-dl exited 0 with nothing to tally"
            );
            return Err(GoopError::SubprocessFailed {
                binary: "gallery-dl".into(),
                stderr: "URL valid but no extractable content".into(),
            });
        }
        Ok(GalleryDlResult {
            output_path: output_dir.to_string_lossy().into_owned(),
            bytes,
            file_count,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }
}

/// gallery-dl's marker for "this file was already on disk, so I left it
/// alone". Same two characters on every platform.
const SKIP_PREFIX: &str = "# ";

/// Resolve one line of gallery-dl's stdout to the output file it names, or
/// `None` if the line does not name one.
///
/// Under `output.mode=pipe` gallery-dl prints exactly one line per file it
/// handled: the path alone for a file it fetched, `# ` + the path for one
/// it skipped as already present. Both belong to the URL being downloaded,
/// which is the whole point — a tally built from these cannot pick up the
/// file a concurrent job, or last week's job, wrote into the same folder.
///
/// Anything resolving outside `output_dir` is dropped. gallery-dl was
/// handed it as `--directory`, so a path that escapes it is not a line we
/// understand, and a filename is ultimately remote-controlled data. The
/// containment test is lexical, not resolved — a path leaving the tree
/// through a symlink would pass — which is enough here because the only
/// thing done with the result is `metadata()`.
///
/// The comparison holds on Windows because gallery-dl prints the path it
/// built from the `--directory` we gave it, not a re-resolved one, so both
/// sides carry the same verbatim prefix that `canonical_output_dir` put
/// there.
fn reported_output(line: &str, output_dir: &std::path::Path) -> Option<PathBuf> {
    let raw = line.strip_prefix(SKIP_PREFIX).unwrap_or(line);
    if raw.trim().is_empty() {
        return None;
    }
    // Not trimmed: the reader has already removed the line terminator, and
    // a trailing space is a legal filename character. `join` takes an
    // absolute `raw` as-is and resolves a relative one against the output
    // directory, which is the behaviour we want for both.
    let path = output_dir.join(raw);
    let escapes = path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir));
    (!escapes && path.starts_with(output_dir)).then_some(path)
}

/// Size up the files this run reported. Returns `(count, total_bytes)`.
///
/// Deferred until after the child exits on purpose. gallery-dl prints a
/// path as it finalises the file, and the rename behind that can still be
/// settling when the event loop reads the line — the TOCTOU race the
/// previous directory-walk tally was written to avoid. Once the process is
/// gone every rename it was going to do is done, so a single stat is
/// enough, and identity survives where a timestamp cutoff could not.
///
/// A reported path that is not a regular file by then goes uncounted: the
/// honest reading of "gallery-dl named this and it is not there".
fn tally_reported(reported: &HashSet<PathBuf>) -> (u32, u64) {
    let mut count = 0u32;
    let mut bytes = 0u64;
    for path in reported {
        let Ok(meta) = std::fs::metadata(path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        count += 1;
        bytes += meta.len();
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
/// Cancel: the user is done — remove recent `.part` partials. Pause: keep
/// them; a re-run skips finished files (gallery-dl's default), resumes the
/// in-flight `.part`, and reports the whole album either way, so the tally
/// covers what earlier attempts already fetched.
///
/// Caveat: resume relies on gallery-dl DEFAULTS (part files on, skip
/// enabled); a user-level gallery-dl config that disables either turns
/// resume into a re-download. Accepted for now — Goop doesn't pass
/// `--config-ignore`.
fn finish_interrupt(int: Interrupt, output_dir: &std::path::Path) -> GoopError {
    match int {
        Interrupt::Cancel => {
            cleanup_partials(output_dir);
            GoopError::Cancelled
        }
        Interrupt::Pause => GoopError::Paused,
    }
}

/// Remove the run's partials — the cancel-of-paused cleanup, callable from
/// outside a running download.
pub(crate) fn cleanup_run_artifacts(output_dir: &std::path::Path) {
    cleanup_partials(output_dir);
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
    fn finish_interrupt_pause_keeps_the_part_cancel_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("photo.jpg.part");
        std::fs::write(&part, b"x").unwrap();

        let err = finish_interrupt(Interrupt::Pause, dir.path());
        assert!(matches!(err, GoopError::Paused));
        assert!(part.exists(), "pause keeps the in-flight .part");

        let err = finish_interrupt(Interrupt::Cancel, dir.path());
        assert!(matches!(err, GoopError::Cancelled));
        assert!(!part.exists(), "cancel removes the .part");
    }

    #[test]
    fn reported_output_reads_fetched_and_skipped_lines() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path();

        // A fetched file, and the same file on a later run.
        let fetched = out.join("photo.jpg");
        assert_eq!(
            reported_output(&fetched.to_string_lossy(), out).as_ref(),
            Some(&fetched)
        );
        assert_eq!(
            reported_output(&format!("# {}", fetched.display()), out).as_ref(),
            Some(&fetched),
            "a skipped file is still one of this URL's files"
        );

        // A subdirectory an extractor made under --directory.
        let nested = out.join("album").join("01.jpg");
        assert_eq!(
            reported_output(&nested.to_string_lossy(), out).as_ref(),
            Some(&nested)
        );

        // Blank lines carry no file.
        assert_eq!(reported_output("", out), None);
        assert_eq!(reported_output("   ", out), None);
        assert_eq!(reported_output(SKIP_PREFIX, out), None);
    }

    #[test]
    fn reported_output_refuses_paths_outside_the_output_dir() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path();
        assert_eq!(reported_output("/etc/passwd", out), None);
        assert_eq!(reported_output("../escaped.jpg", out), None);
        assert_eq!(
            reported_output(&format!("# {}/../escaped.jpg", out.display()), out),
            None,
            "a skip line gets the same treatment as a fetch line"
        );
    }

    #[test]
    fn tally_reported_sizes_only_what_is_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let one = dir.path().join("one.jpg");
        let two = dir.path().join("two.jpg");
        std::fs::write(&one, b"aaaa").unwrap();
        std::fs::write(&two, b"bb").unwrap();

        let reported = HashSet::from([
            one,
            two,
            // Named but gone by the time the process exited, and a
            // directory, which is not a download.
            dir.path().join("vanished.jpg"),
            dir.path().to_path_buf(),
        ]);
        let (count, bytes) = tally_reported(&reported);
        assert_eq!(count, 2);
        assert_eq!(bytes, 6);
    }

    #[test]
    fn tally_reported_counts_nothing_when_nothing_was_reported() {
        assert_eq!(tally_reported(&HashSet::new()), (0, 0));
    }

    #[test]
    fn cleanup_run_artifacts_removes_partials() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("photo.jpg.part");
        let keep = dir.path().join("photo.jpg");
        std::fs::write(&part, b"x").unwrap();
        std::fs::write(&keep, b"x").unwrap();
        cleanup_run_artifacts(dir.path());
        assert!(!part.exists());
        assert!(keep.exists(), "finished downloads are not cleanup targets");
    }
}

/// Re-download behaviour, driven end-to-end through a fake `gallery-dl`.
///
/// What the tally counts is decided by what the subprocess says, so these
/// drive the real loop rather than calling the helpers directly. The cases
/// that matter — a complete album re-run, a second URL in the same folder,
/// a resume — are only visible ACROSS runs, and the unit tests above,
/// which exercise the parse and the sizing separately, cannot see any of
/// them.
///
/// Unix-only: the fakes are `/bin/sh` scripts. The logic under test is
/// platform-independent.
#[cfg(all(test, unix))]
mod redownload_tests {
    use super::*;
    use goop_core::events::RecordingSink;
    use goop_core::{JobId, JobSignals};
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;
    use tempfile::TempDir;

    /// Argv the exec probe hands a fake to prove it can be run. gallery-dl
    /// is only ever passed URLs and its own flags, so nothing a real run
    /// sends can collide with it.
    const EXEC_PROBE_ARG: &str = "--goop-exec-probe";

    fn write_fake(dir: &std::path::Path, name: &str, body: &str) {
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        // The guard answers the probe and exits before reaching the body,
        // so probing costs nothing but a `/bin/sh` startup.
        write!(
            f,
            "#!/bin/sh\ncase \"$1\" in {EXEC_PROBE_ARG}) exit 0;; esac\n{body}"
        )
        .unwrap();
        drop(f);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        wait_until_executable(&path);
    }

    /// Blocks until `path` can actually be `exec`d, which is not the same
    /// moment as "we finished writing it".
    ///
    /// A second copy of the helper #66 added to `backend.rs`, deliberately
    /// rather than sharing one: consolidating them is a test-only refactor
    /// that would touch that PR's own regression test, and there is a third
    /// copy in `goop-tauri` that could not share it across crates anyway.
    /// Tracked separately.
    ///
    /// Same hazard #66 fixed in `backend.rs`, and the same test binary:
    /// Linux refuses to `execve` a file while any process holds it open for
    /// writing, and a sibling test spawning a sidecar forks a child that
    /// inherits a copy of our write descriptor which outlives our own close.
    /// `O_CLOEXEC` fires at the child's exec rather than its fork — the gap
    /// in between is the bug — and renaming does not help because the kernel
    /// counts writers per inode. Nothing reopens a fake for writing, so one
    /// successful exec proves the path stays runnable.
    fn wait_until_executable(path: &std::path::Path) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut backoff = std::time::Duration::from_millis(1);
        loop {
            let busy = match std::process::Command::new(path)
                .arg(EXEC_PROBE_ARG)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
            {
                Ok(_) => return,
                Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => e,
                Err(e) => panic!("fake {} could not be run at all: {e:?}", path.display()),
            };
            assert!(
                std::time::Instant::now() < deadline,
                "fake {} was still held open for writing after 10s: {busy:?}",
                path.display()
            );
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(std::time::Duration::from_millis(25));
        }
    }

    /// The stdout contract is a set of `-o` pins, and nothing was checking
    /// they are actually passed. Every one of them is load-bearing:
    /// `mode=pipe` decides the format the tally parses, `skip=true` decides
    /// whether an already-downloaded file is reported at all, and
    /// `stdout=utf-8` decides whether a non-ASCII path arrives intact or as
    /// `?`. A user-level gallery-dl config can set all three, and Goop does
    /// not pass `--config-ignore`.
    ///
    /// Reads the argv off a fake that dumps it, which is the only way to see
    /// what was actually spawned.
    #[tokio::test]
    async fn the_stdout_contract_is_pinned_on_the_command_line() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let argv = out.path().join("argv");
        // Dump argv, then behave like a run that downloaded nothing so the
        // call returns promptly.
        write_fake(
            bins.path(),
            "gallery-dl",
            &format!(
                "for a in \"$@\"; do echo \"$a\" >> '{}'; done\nexit 0\n",
                argv.display()
            ),
        );

        let _ = run(
            bins.path(),
            &request("https://example.com/album", out.path()),
        )
        .await;

        let sent = std::fs::read_to_string(&argv).unwrap_or_default();
        for pin in [
            "output.mode=pipe",
            "output.skip=true",
            "output.stdout=utf-8",
        ] {
            assert!(sent.contains(pin), "missing `-o {pin}` in argv:\n{sent}");
        }
        // `--quiet` sets the log level to ERROR, and gallery-dl forces
        // `output.mode=null` at WARNING and above AFTER `-o` is applied — so
        // it silences the very lines the tally is built from and cannot be
        // pinned back. Verified against 1.32.3: with `--quiet`, stdout is
        // empty even with `output.mode=pipe` set.
        assert!(
            !sent.lines().any(|a| a == "--quiet"),
            "--quiet would silence the stdout this tally reads:\n{sent}"
        );
    }

    /// Body of a fake gallery-dl that writes `downloads` into `--directory`
    /// and reports both lists on stdout the way the real tool does.
    ///
    /// The report format is gallery-dl's `PipeOutput`, which is what it
    /// selects whenever stdout is not a terminal — a bare absolute path per
    /// file it fetched, `# ` + the same path per file it skipped because the
    /// album is already on disk. Verified against gallery-dl 1.32.3; the
    /// `# ` prefix is the same on Windows.
    fn fake(downloads: &[&str], skips: &[&str]) -> String {
        let mut body = String::from(
            r#"dir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--directory" ]; then dir="$a"; fi
  prev="$a"
done
"#,
        );
        for name in downloads {
            body.push_str(&format!(
                "printf 'x' > \"$dir/{name}\"\necho \"$dir/{name}\"\n"
            ));
        }
        for name in skips {
            body.push_str(&format!("echo \"# $dir/{name}\"\n"));
        }
        body.push_str("exit 0\n");
        body
    }

    /// A first download: one new file.
    fn downloads(name: &str) -> String {
        fake(&[name], &[])
    }

    /// The second run against an album already on disk: gallery-dl's
    /// skip-existing behaviour. Writes nothing because there was nothing new
    /// to fetch, and says so, once per file it left alone.
    fn skips(name: &str) -> String {
        fake(&[], &[name])
    }

    /// A URL that probed cleanly but yields nothing — a private album, an
    /// empty profile. Exits 0 with no file and nothing to report.
    fn reports_nothing() -> String {
        fake(&[], &[])
    }

    fn request(url: &str, output_dir: &std::path::Path) -> ExtractRequest {
        ExtractRequest {
            url: url.into(),
            output_dir: output_dir.to_string_lossy().into_owned(),
            format: None,
            audio_only: false,
            cookies_from_browser: None,
            output_template: None,
            direct: false,
            debrid: false,
            debrid_item: None,
            resume_key: None,
            filename_hint: None,
            extractor_hint: None,
        }
    }

    async fn run_with_sink(
        bins: &std::path::Path,
        req: &ExtractRequest,
    ) -> (Result<GalleryDlResult, GoopError>, Arc<RecordingSink>) {
        let resolver = BinaryResolver::new(bins.to_path_buf());
        let sink = Arc::new(RecordingSink::new());
        let gd = GalleryDl::new(&resolver, sink.clone());
        let res = gd.download(JobId::new(), req, JobSignals::new()).await;
        (res, sink)
    }

    async fn run(
        bins: &std::path::Path,
        req: &ExtractRequest,
    ) -> Result<GalleryDlResult, GoopError> {
        run_with_sink(bins, req).await.0
    }

    /// The bug, as a test.
    ///
    /// Download an album, then ask for the same URL again. gallery-dl skips
    /// everything (it is all on disk) and exits 0 — the correct outcome, and
    /// what a user re-running a link to pick up new posts sees when there are
    /// none. Goop reports it as a failure.
    #[tokio::test]
    async fn re_downloading_a_complete_album_is_not_a_failure() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let url = "https://example.com/album";
        let req = request(url, out.path());

        write_fake(bins.path(), "gallery-dl", &downloads("photo.jpg"));
        let first = run(bins.path(), &req)
            .await
            .expect("the first run downloads");
        assert_eq!(first.file_count, 1);

        write_fake(bins.path(), "gallery-dl", &skips("photo.jpg"));
        let second = run(bins.path(), &req).await;

        assert!(
            second.is_ok(),
            "nothing new to fetch is not the same as nothing there: {second:?}"
        );
        assert_eq!(
            second.unwrap().file_count,
            1,
            "the album's files are still on disk and still belong to this URL"
        );
    }

    /// The tally needs nothing persisted between runs, so it leaves nothing
    /// in the user's downloads folder to persist it with.
    #[tokio::test]
    async fn a_run_leaves_no_bookkeeping_behind() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let url = "https://example.com/album";
        write_fake(bins.path(), "gallery-dl", &downloads("photo.jpg"));

        run(bins.path(), &request(url, out.path()))
            .await
            .expect("downloads");

        let left: Vec<_> = std::fs::read_dir(out.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec!["photo.jpg"], "the download, and nothing else");
    }

    /// Two albums, one downloads folder — which is the default, and the
    /// reason a tally cannot be a directory walk. A's count is A's files,
    /// whatever else happens to be sitting beside them.
    #[tokio::test]
    async fn a_shared_output_folder_does_not_cross_urls() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let a = "https://example.com/album-a";
        let b = "https://example.com/album-b";

        write_fake(bins.path(), "gallery-dl", &downloads("a.jpg"));
        run(bins.path(), &request(a, out.path())).await.expect("a");
        write_fake(bins.path(), "gallery-dl", &downloads("b.jpg"));
        run(bins.path(), &request(b, out.path())).await.expect("b");

        write_fake(bins.path(), "gallery-dl", &skips("a.jpg"));
        let again = run(bins.path(), &request(a, out.path()))
            .await
            .expect("succeeds");
        assert_eq!(
            again.file_count, 1,
            "A has one file; B's is in the same folder and is still not A's"
        );

        // The sharper edge: with nothing of its own left on disk and nothing
        // to report, A must fail honestly rather than pass on B's file.
        std::fs::remove_file(out.path().join("a.jpg")).unwrap();
        write_fake(bins.path(), "gallery-dl", &reports_nothing());
        let orphaned = run(bins.path(), &request(a, out.path())).await;
        assert!(
            orphaned.is_err(),
            "a URL that produced nothing cannot borrow B's file to succeed: \
             {orphaned:?}"
        );
    }

    /// The tripwire for the flag that started all this.
    ///
    /// The queue row's file count and the tally read the same stream, so
    /// anything that silences gallery-dl's stdout takes out both at once —
    /// silently, because an empty stdout looks exactly like an album with
    /// nothing in it. `--quiet` did precisely that: it sets the log level to
    /// ERROR, and gallery-dl forces `output.mode=null` at WARNING and above.
    /// Progress had been dead the whole time it was passed; the tally only
    /// survived because it walked the directory instead.
    #[tokio::test]
    async fn every_reported_file_shows_up_as_progress() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let url = "https://example.com/album";
        write_fake(bins.path(), "gallery-dl", &fake(&["two.jpg"], &["one.jpg"]));

        let (res, sink) = run_with_sink(bins.path(), &request(url, out.path())).await;
        res.expect("downloads");

        let stages: Vec<String> = sink
            .progress
            .lock()
            .iter()
            .map(|p| p.stage.clone())
            .collect();
        assert_eq!(
            stages,
            vec!["downloaded 1 file(s)", "downloaded 2 file(s)"],
            "one tick per file, skipped ones included"
        );
    }

    /// A resumed album is reported whole: the files earlier attempts already
    /// fetched come back as skips, and they are as much a part of the tally
    /// as the one this attempt finished.
    #[tokio::test]
    async fn a_resumed_album_tallies_what_earlier_attempts_fetched() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let url = "https://example.com/album";
        let req = request(url, out.path());

        write_fake(bins.path(), "gallery-dl", &downloads("one.jpg"));
        run(bins.path(), &req).await.expect("the first attempt");

        // The resume: one file already there, one newly fetched.
        write_fake(bins.path(), "gallery-dl", &fake(&["two.jpg"], &["one.jpg"]));
        let resumed = run(bins.path(), &req).await.expect("the resume");
        assert_eq!(resumed.file_count, 2, "the album, not just the new file");
        assert_eq!(resumed.bytes, 2, "sized whole, one byte per fake file");
    }

    /// The tally reads no clock, so there is no window it stops working
    /// outside of. An album whose files are old enough that any cutoff a
    /// timestamp-based tally could pick would exclude them still re-runs.
    #[tokio::test]
    async fn re_downloading_works_however_old_the_album_is() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let url = "https://example.com/album";
        let req = request(url, out.path());

        write_fake(bins.path(), "gallery-dl", &downloads("photo.jpg"));
        run(bins.path(), &req)
            .await
            .expect("the first run downloads");

        // Age the album a month, as a month of real time would.
        let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 86400);
        let f = std::fs::File::options()
            .write(true)
            .open(out.path().join("photo.jpg"))
            .unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(long_ago))
            .unwrap();

        write_fake(bins.path(), "gallery-dl", &skips("photo.jpg"));
        let second = run(bins.path(), &req).await;

        assert_eq!(
            second.expect("a month-old album still re-runs").file_count,
            1,
            "the album's file is reported for this URL however old it is"
        );
    }
}
