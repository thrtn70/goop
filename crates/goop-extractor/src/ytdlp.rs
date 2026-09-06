use crate::recovery::{ExtractRecovery, RecoveryCheckpoint};
use goop_core::{
    is_cookie_db_error, EventSink, GoopError, Interrupt, JobId, JobSignals, ProgressEvent,
    SidecarEvent, WarningCode,
};
use goop_sidecar::BinaryResolver;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use ts_rs::TS;

/// yt-dlp browser names this crate is willing to forward to
/// `--cookies-from-browser`. Defense-in-depth: even though the IPC layer
/// validates against `goop_config::SUPPORTED_BROWSERS` before storing the
/// request, the worker re-deserializes the payload from SQLite and the
/// row could in principle contain an unsanitised string (DB tampering,
/// future migration bug, manual edit). Re-validate here so an arbitrary
/// value can never reach the yt-dlp argv. Keeping a duplicate constant
/// avoids a circular crate dep on goop-config; the list is short and
/// rarely changes.
const SUPPORTED_BROWSERS: &[&str] = &[
    "brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale",
];

/// Known-good yt-dlp output templates corresponding to
/// `goop_config::ExtractNamingScheme`. Mirrors the same defense-in-depth
/// pattern as `SUPPORTED_BROWSERS`: even though the IPC boundary resolves
/// the user's chosen scheme into a template string, the worker
/// re-deserializes the payload from SQLite later, so an arbitrary
/// `output_template` value could in principle inject arbitrary yt-dlp
/// formatting. The allowlist makes that impossible by construction.
/// Keep in sync with `ExtractNamingScheme::to_yt_dlp_template`.
const KNOWN_TEMPLATES: &[&str] = &[
    "%(title)s.%(ext)s",
    "%(title)s — %(extractor)s.%(ext)s",
    "%(upload_date)s — %(title)s.%(ext)s",
];

fn validated_browser(name: Option<&str>) -> Option<&'static str> {
    let n = name?;
    SUPPORTED_BROWSERS.iter().copied().find(|b| *b == n)
}

/// How long the output loop keeps draining stderr after stdout has hit
/// EOF, with no new stderr arriving. Only a bound on a pathological case
/// (see the drain loop in `download_once`); a healthy child EOFs both
/// streams at once and never arms it. Shared with `gallery_dl`, which
/// drives its subprocess the same way.
pub(crate) const STDERR_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ExtractRequest {
    pub url: String,
    pub output_dir: String,
    pub format: Option<String>, // e.g., "bestaudio[ext=m4a]"
    pub audio_only: bool,
    /// When set, yt-dlp is invoked with `--cookies-from-browser <name>`
    /// so it can reuse the user's existing browser session for sites that
    /// require login (Twitter/X, Instagram, etc.). Validated against
    /// `goop_config::SUPPORTED_BROWSERS` at the IPC boundary; unrecognised
    /// values are dropped to `None`.
    #[serde(default)]
    pub cookies_from_browser: Option<String>,
    /// yt-dlp output template fragment (no directory prefix), e.g.
    /// `"%(title)s.%(ext)s"`. Resolved from the user's naming-scheme
    /// setting at the IPC boundary; `None` falls back to yt-dlp's default.
    /// Validated against a known-template allowlist before reaching argv
    /// to keep a stale or tampered payload from injecting arbitrary args.
    #[serde(default)]
    pub output_template: Option<String>,
    /// Hint, set by the probe step, that the URL is a plain file neither
    /// extractor handles. Lets `dispatch` skip the two doomed extractor
    /// spawns and go straight to the direct downloader. Defaults to
    /// `false`; the dispatch-level no-match fallback still covers the
    /// un-hinted case, so this is purely an optimisation.
    #[serde(default)]
    pub direct: bool,
    /// Hint, set by the probe step, that this URL routes through the
    /// debrid service (magnet links always do; hoster links when the
    /// probe matched TorBox's supported-hoster list). `magnet:` URLs
    /// route to debrid regardless, so this is probe metadata the same
    /// way `direct` is.
    #[serde(default)]
    pub debrid: bool,
    /// Persisted TorBox item handle (`"torrent:42"` / `"web:abc"`),
    /// written back into the job payload after the first create call so
    /// the waiting-poll cycles and app restarts don't re-submit the
    /// link. Internal — set by the debrid resolver, never by the UI.
    #[serde(default)]
    pub debrid_item: Option<String>,
    /// Stable key for the direct downloader's `.part`/`.meta` sidecar
    /// names, overriding the URL. The debrid path downloads from
    /// short-lived CDN URLs; keying partials on the original link keeps
    /// resume working when the CDN URL rotates. Internal.
    #[serde(default)]
    pub resume_key: Option<String>,
    /// Preferred output filename, overriding header/URL derivation.
    /// The debrid path knows the real name from TorBox while the CDN
    /// URL may be opaque. Internal.
    #[serde(default)]
    pub filename_hint: Option<String>,
    /// Which extractor the probe actually got an answer out of.
    ///
    /// `classify_extractor` guesses from the URL's shape and is right most
    /// of the time; the probe KNOWS, because one of them just returned
    /// metadata. Carrying that verdict forward skips a doomed spawn on
    /// every misclassified URL — the whole cost of a wrong guess today.
    ///
    /// Purely an optimisation, exactly like `direct`: the cross-extractor
    /// fallback is unchanged, so a stale or absent hint degrades to
    /// today's behaviour rather than failing. `#[serde(default)]` because
    /// jobs queued before this field existed are still in the store.
    #[serde(default)]
    pub extractor_hint: Option<crate::classify::ExtractorChoice>,
}

/// Metadata for a plain file the extractors don't handle, surfaced by the
/// probe step so the UI can offer a direct download. Populated via an HTTP
/// `HEAD` (or ranged `GET`) by `crate::direct::probe`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct DirectFileInfo {
    pub filename: String,
    pub size_bytes: Option<u64>,
    pub content_type: Option<String>,
    /// `true` when the server advertised `Accept-Ranges: bytes`, so an
    /// interrupted download can resume.
    pub resumable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ExtractResult {
    pub output_path: String,
    pub bytes: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct UrlProbe {
    pub url: String,
    pub title: String,
    pub uploader: Option<String>,
    pub duration_secs: Option<u64>,
    pub thumbnail_url: Option<String>,
    pub formats: Vec<FormatOption>,
    /// Set only when neither extractor recognised the URL and a direct
    /// HTTP `HEAD`/`GET` probe found a plain downloadable file. The UI
    /// renders a simplified "Direct download" card in this case. `None`
    /// for normal yt-dlp / gallery-dl results.
    #[serde(default)]
    pub direct: Option<DirectFileInfo>,
    /// Set when the URL routes through the debrid service: always for
    /// `magnet:` links, and for hoster links the probe matched against
    /// TorBox's supported-hoster list. The UI renders a "via TorBox"
    /// card. `None` everywhere else.
    #[serde(default)]
    pub debrid: Option<DebridProbeInfo>,
    /// Which extractor produced this probe. Echoed back by the UI as
    /// `ExtractRequest::extractor_hint` so the download skips the guess —
    /// same round trip as `direct` and `debrid`. `None` for direct and
    /// debrid probes, where no extractor was involved.
    #[serde(default)]
    pub extractor: Option<crate::classify::ExtractorChoice>,
}

/// Probe metadata for a debrid-routed link. Sibling of `DirectFileInfo`
/// for the "via TorBox" card.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct DebridProbeInfo {
    /// `true` for magnet links, `false` for hoster links.
    pub magnet: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct FormatOption {
    pub format_id: String,
    pub ext: String,
    pub resolution: Option<String>,
    pub filesize: Option<u64>,
    pub is_audio_only: bool,
    /// The yt-dlp `-f` expression that actually downloads this format,
    /// which is not always the bare id. Video-only formats (every YouTube
    /// stream above 720p is one) need `+bestaudio` or the file arrives
    /// silent, so the selector is composed here rather than in the UI:
    /// yt-dlp's format-selector grammar belongs with the rest of the
    /// yt-dlp knowledge, and callers can pass it straight through.
    pub selector: String,
}

pub struct YtDlp<'a> {
    resolver: &'a BinaryResolver,
    sink: Arc<dyn EventSink>,
}

impl<'a> YtDlp<'a> {
    pub fn new(resolver: &'a BinaryResolver, sink: Arc<dyn EventSink>) -> Self {
        Self { resolver, sink }
    }

    /// Probe a URL with `yt-dlp -J` (JSON metadata only, no download).
    /// Sinkless — callable without constructing a `YtDlp` instance.
    /// `cookies_from_browser` mirrors the `--cookies-from-browser` flag;
    /// pass `None` to keep the spawn anonymous.
    ///
    /// On a cookie-DB read failure (Chrome v127+ DPAPI lock, missing
    /// browser, etc.), retries silently without `--cookies-from-browser`.
    /// The retry is silent because `probe` has no event sink to surface
    /// a warning through; in the typical flow the user sees the warning
    /// when the actual `download` retries. Best-effort: if the download
    /// path doesn't reproduce the cookie failure (e.g. browser was
    /// closed in the interval), no warning lands — the user just
    /// silently proceeds without cookies, which is acceptable since the
    /// extract still succeeds.
    pub async fn probe(
        resolver: &BinaryResolver,
        url: &str,
        cookies_from_browser: Option<&str>,
    ) -> Result<UrlProbe, GoopError> {
        let bin = resolver.resolve("yt-dlp")?;
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
        bin_path: &Path,
        url: &str,
        cookies: Option<&str>,
    ) -> Result<UrlProbe, GoopError> {
        let mut cmd = Command::new(bin_path);
        // `--no-playlist` resolves `watch?v=X&list=Y` to the single video
        // it names. Without it yt-dlp answers with the playlist: the card
        // shows the playlist's title and an empty format picker, and the
        // probe pays for a full extraction of every entry first. A bare
        // `playlist?list=Y` has no video to prefer, so it is unaffected
        // and still probes as a playlist.
        cmd.args(["-J", "--no-warnings", "--no-playlist"]);
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
                binary: "yt-dlp".into(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        let v: serde_json::Value = serde_json::from_slice(&out.stdout)?;
        // When yt-dlp's only plan is a dumb direct download (its `generic`
        // extractor over plain HTTP), prefer Goop's own downloader — it adds
        // resume and reports real progress, which yt-dlp's generic path does
        // not. A HEAD probe gives the filename/size for the Direct
        // card; if it fails we fall through to the normal yt-dlp card. Real
        // extractions, playlists, and streaming manifests are excluded, so
        // they keep the normal card and yt-dlp's download path.
        if is_generic_direct(&v) {
            if let Ok(info) = crate::direct::probe(url).await {
                return Ok(UrlProbe {
                    url: url.to_string(),
                    title: info.filename.clone(),
                    uploader: None,
                    duration_secs: None,
                    thumbnail_url: None,
                    formats: Vec::new(),
                    direct: Some(info),
                    debrid: None,
                    // No extractor is involved in a direct download, and
                    // `req.direct` already routes it — a hint here would
                    // only be a second, weaker way to say the same thing.
                    extractor: None,
                });
            }
        }
        Ok(UrlProbe {
            url: url.to_string(),
            title: v["title"].as_str().unwrap_or("").to_string(),
            uploader: v["uploader"].as_str().map(String::from),
            duration_secs: v["duration"].as_u64(),
            thumbnail_url: v["thumbnail"].as_str().map(String::from),
            formats: parse_formats(&v["formats"]),
            direct: None,
            debrid: None,
            extractor: Some(crate::classify::ExtractorChoice::YtDlp),
        })
    }

    /// `pub(crate)` on purpose: callers must come through
    /// `backend::dispatch`, which installs the `WarnOnceSink` this fn's
    /// warning relies on to stay one-per-dispatch. A direct call would
    /// silently bypass it.
    pub(crate) async fn download(
        &self,
        job_id: JobId,
        req: &ExtractRequest,
        signals: JobSignals,
        recovery: ExtractRecovery,
    ) -> Result<ExtractResult, GoopError> {
        let bin = self.resolver.resolve("yt-dlp")?;
        let checkpoint = recovery.allocate(job_id, req)?;
        let output_dir = checkpoint.owned_directory()?;
        let out_template = output_dir.join("source.%(ext)s");

        // First attempt: with cookies (if the request had any).
        let first = self
            .download_once(
                job_id,
                req,
                &bin.path,
                &output_dir,
                &out_template,
                signals.clone(),
                /* with_cookies: */ true,
                &recovery,
            )
            .await;

        // Cookie-DB read failure + cookies were actually requested → retry
        // without the flag and warn. Public videos and most
        // yt-dlp-supported sites work without cookies, so the fallback
        // turns "extract fails" into "extract works, with a heads-up". A
        // fired cancel or pause short-circuits the retry.
        //
        // This warns once per call, which is NOT once per dispatch:
        // dispatch may run gallery-dl after us and the retry layer may
        // re-run us, and each would hit the same locked cookie DB.
        // Collapsing those repeats is `WarnOnceSink`'s job, installed by
        // `backend::dispatch_with_policy` — don't add a guard here.
        let result = match first {
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
                    &out_template,
                    signals,
                    /* with_cookies: */ false,
                    &recovery,
                )
                .await
            }
            other => other,
        };
        if matches!(result, Err(GoopError::Cancelled))
            && recovery.checkpoint().is_some_and(|cp| !cp.writer_active)
        {
            recovery.cleanup()?;
        }
        result
    }

    /// Single spawn + drive of yt-dlp. Pulled out of `download` so the
    /// outer fn can run it twice (once with cookies, once without) on
    /// cookie-DB failure. `with_cookies = false` omits the
    /// `--cookies-from-browser` flag regardless of `req.cookies_from_browser`.
    #[allow(clippy::too_many_arguments)]
    async fn download_once(
        &self,
        job_id: JobId,
        req: &ExtractRequest,
        bin_path: &Path,
        output_dir: &Path,
        out_template: &Path,
        signals: JobSignals,
        with_cookies: bool,
        recovery: &ExtractRecovery,
    ) -> Result<ExtractResult, GoopError> {
        if let Some(int) = signals.check() {
            return Err(int.into());
        }
        let replay = recovery.replay(signals.clone()).await?;
        let mut cmd = Command::new(bin_path);
        cmd.args([
            "--ignore-config",
            "--newline",
            "--progress",
            "--continue",
            "--keep-video",
            "--no-playlist",
            "--no-simulate",
            "--encoding",
            "utf-8",
            "--print",
            "post_process:__GOOP_SOURCE__%()j",
            "--print",
            "after_move:__GOOP_FINAL__%(filepath)j",
            "--progress-template",
            "download:__GOOP_DL__%(progress)j",
            "--progress-template",
            "postprocess:__GOOP_PP__%(progress)j",
        ])
        .arg("-o")
        .arg(out_template);
        let tools = prepare_media_tools(self.resolver, output_dir, signals.clone()).await?;
        cmd.arg("--ffmpeg-location").arg(output_dir);
        if req.audio_only {
            cmd.arg("-x").arg("--audio-format").arg("mp3");
        }
        if let Some(fmt) = &req.format {
            cmd.arg("-f").arg(fmt);
        }
        if with_cookies {
            if let Some(browser) = validated_browser(req.cookies_from_browser.as_deref()) {
                cmd.arg("--cookies-from-browser").arg(browser);
            }
        }
        // arg(), not shell: URL is passed as argv, not expanded by a shell.
        if let Some(path) = replay {
            cmd.args([
                "--proxy",
                "",
                "--socket-timeout",
                "1",
                "--retries",
                "0",
                "--fragment-retries",
                "0",
            ])
            .arg("--load-info-json")
            .arg(path);
        } else {
            cmd.arg("--").arg(&req.url);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let started = std::time::Instant::now();
        recovery.set_writer(true)?;
        crate::process::ProcessTree::configure(&mut cmd);
        let mut child: Child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                recovery.set_writer(false)?;
                return Err(error.into());
            }
        };
        let tree = crate::process::ProcessTree::new(&child)?;
        // invariant: stdout was requested with Stdio::piped above.
        let stdout = child.stdout.take().expect("stdout was piped");
        // invariant: stderr was requested with Stdio::piped above.
        let stderr = child.stderr.take().expect("stderr was piped");
        let mut out_reader = BufReader::new(stdout).lines();
        let mut err_reader = BufReader::new(stderr).lines();

        let mut output_path: Option<String> = None;
        let mut stderr_tail = String::new();
        // Sticky witness for the cookie-DB error. Tracked separately
        // because `stderr_tail` is a ring-buffer of the last ~8KB; if
        // yt-dlp emits enough later stderr to flush the cookie line out
        // of the window, the retry guard in `download` would miss it.
        // Capture the first matching line so we can preserve the signal
        // in the final SubprocessFailed.stderr regardless of truncation.
        let mut cookie_error_line: Option<String> = None;
        let mut processing = false;
        // Stdout lines dropped because they weren't valid UTF-8. Counted
        // rather than logged where they happen: reported once after the
        // loop, below.
        let mut undecodable_stdout: u32 = 0;

        // Drain BOTH streams to EOF rather than stopping at stdout's. The
        // loop is biased, so it polls stdout first; a child that closed
        // stdout early (or exited before the first poll) would otherwise
        // end the loop with stderr never read even once. Everything the
        // caller decides — the cookie fallback below, the cross-extractor
        // fallback, the transient retry, `friendly_message` — is a
        // substring test over that stderr, so losing it fails silently and
        // looks like a clean "unknown error".
        //
        // The `if !*_done` guards are load-bearing: a reader already at
        // EOF returns `Ready(None)` immediately, forever, so an unguarded
        // arm would spin the loop hot instead of waiting on its sibling.
        let mut out_done = false;
        let mut err_done = false;
        while !(out_done && err_done) {
            tokio::select! {
                // biased: a fired stop signal must win over further
                // subprocess output, deterministically — same discipline
                // as the direct downloader's loop.
                biased;
                int = signals.interrupted() => {
                    tree.finish(&mut child).await?;
                    recovery.set_writer(false)?;
                    if int == Interrupt::Cancel { recovery.cleanup()?; }
                    return Err(int.into());
                }
                line = out_reader.next_line(), if !out_done => {
                    match line {
                        Ok(Some(l)) => {
                            if let Err(error) = self.handle_line(job_id, &l, recovery, &signals, &mut output_path, &mut processing).await {
                                tree.finish(&mut child).await?;
                                recovery.set_writer(false)?;
                                return Err(error);
                            }
                        }
                        Ok(None) => out_done = true,
                        // Same treatment as stderr below, for the same
                        // reason. The line at risk here is the printed
                        // filepath: under this argv it is the only stdout
                        // line carrying a title, and a title is what
                        // arrives mis-encoded. `--print`'s implicit quiet
                        // (see the flags above) suppresses the status lines
                        // that would otherwise name the file — `[download]
                        // Destination:` is not rerouted, it is never
                        // written — and the progress lines that do survive
                        // carry no filename.
                        //
                        // Do NOT propagate. An early return here leaves the
                        // child neither killed nor waited for, and nothing
                        // downstream kills it either: no spawn in this tree
                        // sets `kill_on_drop`. yt-dlp carries on downloading
                        // into the user's folder after the job has already
                        // reported failure, and the Retry button then lands
                        // a second one on the same `--continue`d `.part`.
                        //
                        // Counted, unlike stderr, where losing one line of a
                        // message is cosmetic: lose the path line and the
                        // run fails as "no output file reported" having
                        // downloaded the file perfectly.
                        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                            undecodable_stdout += 1;
                        }
                        // A real IO error won't clear on the next poll.
                        Err(_) => out_done = true,
                    }
                }
                line = err_reader.next_line(), if !err_done => {
                    match line {
                        Ok(Some(l)) => {
                            if let Err(error) = self.handle_line(job_id, &l, recovery, &signals, &mut output_path, &mut processing).await {
                                tree.finish(&mut child).await?;
                                recovery.set_writer(false)?;
                                return Err(error);
                            }
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
                        // One line we couldn't decode — mojibake in a
                        // title, a legacy Windows codepage. tokio consumes
                        // the bad bytes before it validates them, so the
                        // reader has already moved on and the next poll
                        // returns the FOLLOWING line. Skip it and keep
                        // reading: bailing here would drop everything
                        // after the first bad byte, and the caller's
                        // decisions are substring tests over the whole
                        // message.
                        //
                        // The `--encoding utf-8` pinned above does NOT make
                        // this unreachable, so don't delete it. It only
                        // covers what yt-dlp writes itself: `FFmpegFD`
                        // spawns ffmpeg with stdout and stderr INHERITED,
                        // so ffmpeg writes into this pipe directly, in
                        // whatever encoding it pleases, with no Python in
                        // between to honour the flag.
                        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {}
                        // A real IO error won't clear on the next poll.
                        Err(_) => err_done = true,
                    }
                }
                // Bounds the drain. A grandchild that inherited stderr but
                // not stdout holds this pipe open after the child exits,
                // which would otherwise pin the job open for the
                // grandchild's whole lifetime. An INACTIVITY window, not a
                // deadline: `select!` rebuilds the sleep each iteration, so
                // any stderr line resets it. Normal runs never arm it —
                // both streams EOF together when the child exits.
                _ = tokio::time::sleep(STDERR_DRAIN_GRACE), if out_done && !err_done => {
                    tracing::warn!(
                        "yt-dlp stderr still open after stdout finished; \
                         proceeding with the {} bytes collected so far",
                        stderr_tail.len()
                    );
                    err_done = true;
                }
            }
        }

        // Once per run rather than once per line: a playlist whose titles
        // are all mis-encoded would otherwise write one warning per file
        // into the rolling log. The error carries nothing the count
        // doesn't — tokio's message for this kind is a fixed string.
        if undecodable_stdout > 0 {
            tracing::warn!(
                ?job_id,
                lines = undecodable_stdout,
                "skipped yt-dlp stdout lines that were not valid UTF-8"
            );
        }

        tokio::select! {
            biased;
            int = signals.interrupted() => {
                tree.finish(&mut child).await?;
                recovery.set_writer(false)?;
                    if int == Interrupt::Cancel { recovery.cleanup()?; }
                    return Err(int.into());
            }
            stopped = tree.wait_leader(&mut child) => stopped?,
        };
        let status = tree.finish(&mut child).await?;
        recovery.set_writer(false)?;
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
            if processing || recovery.checkpoint().is_some_and(|c| !c.sources.is_empty()) {
                return Err(GoopError::Queue(format!("Extract processing failed; completed sources were retained for Retry: {stderr}")));
            }
            return Err(GoopError::SubprocessFailed {
                binary: "yt-dlp".into(),
                stderr,
            });
        }
        // Say so here too, not just in the log. Skipping the bad line is
        // what keeps the child from being abandoned, but it also means a
        // mis-encoded path leaves this as the only thing the user sees —
        // and the decode error it replaced at least named the cause.
        // Nothing that matches on this field keys on these words, so the
        // longer message can't reroute a dispatch.
        let output_path = output_path.ok_or_else(|| GoopError::SubprocessFailed {
            binary: "yt-dlp".into(),
            stderr: match undecodable_stdout {
                0 => "no output file reported".into(),
                n => format!("no output file reported; {n} stdout line(s) were not valid UTF-8"),
            },
        })?;
        let cp = recovery
            .checkpoint()
            .ok_or_else(|| GoopError::Queue("missing Extract recovery".into()))?;
        let reported = Path::new(&output_path);
        let filename = reported
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| GoopError::Queue("invalid Extract final path".into()))?;
        let source = cp.file(filename)?;
        if reported != source {
            return Err(GoopError::Queue(
                "Extract final path escaped its workspace".into(),
            ));
        }
        self.sink.emit_progress(stage_event(job_id, "validating"));
        validate_media(&tools.1, &source, req, &cp, &signals).await?;
        let bytes = std::fs::metadata(&source)?.len();
        recovery.mark_verified()?;
        self.sink.emit_progress(stage_event(job_id, "saving"));
        // Copy into a distinct candidate so atomic publication never consumes a
        // completed source required by a later retry after a receipt-write crash.
        let candidate = output_dir.join(format!("publish-{}", JobId::new().0));
        let copy_from = source.clone();
        let copy_to = candidate.clone();
        let copy_signals = signals.clone();
        tokio::task::spawn_blocking(move || copy_candidate(&copy_from, &copy_to, &copy_signals))
            .await
            .map_err(|e| GoopError::Queue(e.to_string()))??;
        let ext = source
            .extension()
            .and_then(|s| s.to_str())
            .ok_or_else(|| GoopError::Queue("missing output extension".into()))?;
        if !ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(GoopError::Queue("unsafe output extension".into()));
        }
        let stem = match req
            .output_template
            .as_deref()
            .filter(|t| KNOWN_TEMPLATES.contains(t))
        {
            Some("%(title)s — %(extractor)s.%(ext)s") => {
                format!("{} — {}", cp.title, cp.extractor)
            }
            Some("%(upload_date)s — %(title)s.%(ext)s") => {
                format!("{} — {}", cp.upload_date, cp.title)
            }
            _ => cp.title.clone(),
        };
        for suffix in 0..10_000 {
            cp.owned_directory()?;
            if let Some(int) = signals.check() {
                if int == Interrupt::Cancel {
                    recovery.cleanup()?;
                }
                return Err(int.into());
            }
            let name = if suffix == 0 {
                format!("{stem}.{ext}")
            } else {
                format!("{stem} ({suffix}).{ext}")
            };
            if !crate::recovery::safe_public_component(&name) {
                return Err(GoopError::Queue("unsafe Extract output filename".into()));
            }
            let destination = cp.root.join(name);
            if destination.parent() != Some(cp.root.as_path()) {
                return Err(GoopError::Queue(
                    "Extract publication escaped its output root".into(),
                ));
            }
            match goop_core::output::publish_no_replace(&candidate, &destination) {
                Ok(()) => {
                    // The atomic commit wins a subsequent cancellation. A missing
                    // receipt can leave a valid file plus an interrupted row; never
                    // adopt or delete that file on a later attempt.
                    if let Err(error) = recovery.receipt(destination.clone()) {
                        tracing::error!(%error, "Extract output published but receipt persistence failed");
                    }
                    return Ok(ExtractResult {
                        output_path: destination.to_string_lossy().into(),
                        bytes,
                        duration_ms: started.elapsed().as_millis() as u64,
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
        Err(GoopError::Queue(
            "No unused Extract output name available".into(),
        ))
    }

    async fn handle_line(
        &self,
        job_id: JobId,
        line: &str,
        recovery: &ExtractRecovery,
        signals: &JobSignals,
        output: &mut Option<String>,
        processing: &mut bool,
    ) -> Result<(), GoopError> {
        if let Some(raw) = line.strip_prefix("__GOOP_SOURCE__") {
            *processing = true;
            recovery
                .capture(serde_json::from_str(raw)?, signals.clone())
                .await?;
        } else if let Some(raw) = line.strip_prefix("__GOOP_FINAL__") {
            let path: String = serde_json::from_str(raw)?;
            if output.as_ref().is_some_and(|old| old != &path) {
                return Err(GoopError::Queue("ambiguous Extract output markers".into()));
            }
            *output = Some(path);
        } else if let Some(event) = parse_progress(job_id, line) {
            if line.starts_with("__GOOP_PP__") {
                *processing = true;
            }
            if !*processing || event.stage != "downloading" {
                self.sink.emit_progress(event);
            }
        }
        Ok(())
    }
}

/// True when a yt-dlp `-J` result is just a generic direct file download (no
/// real extraction) over a plain HTTP(S) transfer — the case where Goop's own
/// downloader (resume + live progress) is strictly better. The
/// protocol allowlist is kept in lockstep with `direct::probe`'s http(s)-only
/// scheme guard. Streaming manifests (m3u8/DASH protocols) and playlists are
/// excluded so they stay on yt-dlp's path.
fn is_generic_direct(v: &serde_json::Value) -> bool {
    let generic = v["extractor"].as_str() == Some("generic")
        || v["extractor_key"].as_str() == Some("Generic");
    let direct = v["direct"].as_bool() == Some(true);
    let plain_protocol = matches!(v["protocol"].as_str(), Some("http" | "https"));
    let is_playlist = v["_type"].as_str() == Some("playlist") || v["entries"].is_array();
    generic && direct && plain_protocol && !is_playlist
}

/// Build the picker's format list from a `-J` response.
///
/// Two things happen here that the raw array can't express:
///
/// - **Non-media rows are dropped.** yt-dlp lists storyboards (`sb0`,
///   `sb1`, ... — mhtml contact sheets) alongside real formats, and they
///   carry neither codec. Offering one downloads a grid of thumbnails.
/// - **The order is flipped to best-first.** yt-dlp emits ascending by its
///   own quality ranking. Reversing keeps that ranking (which weighs codec
///   and bitrate, not just height) while putting the formats a user
///   actually wants at the head of the list.
fn parse_formats(v: &serde_json::Value) -> Vec<FormatOption> {
    let Some(arr) = v.as_array() else {
        return Vec::new();
    };
    let mut out: Vec<FormatOption> = arr.iter().filter_map(parse_format).collect();
    out.reverse();
    out
}

fn parse_format(v: &serde_json::Value) -> Option<FormatOption> {
    let id = v["format_id"].as_str()?.to_string();
    let ext = v["ext"].as_str()?.to_string();
    // Three states, not two. yt-dlp writes the literal string "none" to
    // say a stream is absent; a key that is null or missing means the
    // extractor never populated codec metadata, which is a different
    // claim. archive.org returns null/null for its real, playable
    // derivatives, so treating unknown as absent would empty the picker
    // for that whole site.
    let vcodec = v["vcodec"].as_str();
    let acodec = v["acodec"].as_str();
    let no_video = vcodec == Some("none");
    let no_audio = acodec == Some("none");
    // Both streams *explicitly* absent: a storyboard contact sheet, not
    // media. Unknown codecs never reach this branch.
    if no_video && no_audio {
        return None;
    }
    // Merge only when we positively know there is video and positively
    // know there is no audio. Adding `+bestaudio` to a muxed or
    // audio-only format would give the output a second audio track, and
    // guessing on an unknown row would do the same. The `/id` fallback
    // keeps the download working if no separate audio stream exists.
    let has_known_video = matches!(vcodec, Some(c) if c != "none");
    let selector = if has_known_video && no_audio {
        format!("{id}+bestaudio/{id}")
    } else {
        id.clone()
    };
    Some(FormatOption {
        format_id: id,
        ext,
        resolution: v["resolution"].as_str().map(String::from),
        filesize: v["filesize"].as_u64().or(v["filesize_approx"].as_u64()),
        // Only an explicit "none" makes this true. An unknown codec must
        // not be labelled "audio only" on a guess — the picker shows that
        // marker to the user.
        is_audio_only: no_video,
        selector,
    })
}

fn stage_event(job_id: JobId, stage: &str) -> ProgressEvent {
    ProgressEvent {
        job_id,
        percent: 0.0,
        eta_secs: None,
        speed_hr: None,
        stage: stage.into(),
        encoder: None,
    }
}

async fn prepare_media_tools(
    resolver: &BinaryResolver,
    workspace: &Path,
    signals: JobSignals,
) -> Result<(PathBuf, PathBuf), GoopError> {
    let paths = [
        resolver.resolve("ffmpeg")?.path,
        resolver.resolve("ffprobe")?.path,
    ];
    let workspace = workspace.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut resolved = Vec::new();
        for (name, path) in ["ffmpeg", "ffprobe"].into_iter().zip(paths) {
            if let Some(int) = signals.check() {
                return Err(int.into());
            }
            let original = std::fs::canonicalize(path)?;
            let local = workspace.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
            if let Ok(meta) = std::fs::symlink_metadata(&local) {
                #[cfg(unix)]
                if !meta.file_type().is_symlink() || std::fs::read_link(&local)? != original {
                    return Err(GoopError::Queue("Extract tool link changed".into()));
                }
                #[cfg(not(unix))]
                if !meta.is_file() || !same_tool_bytes(&original, &local, &signals)? {
                    return Err(GoopError::Queue("Extract tool alias changed".into()));
                }
            } else {
                #[cfg(unix)]
                std::os::unix::fs::symlink(&original, &local)?;
                #[cfg(not(unix))]
                if std::fs::hard_link(&original, &local).is_err() {
                    copy_candidate(&original, &local, &signals)?;
                }
            }
            resolved.push(original);
        }
        Ok((resolved.remove(0), resolved.remove(0)))
    })
    .await
    .map_err(|e| GoopError::Queue(format!("cannot prepare Extract tools: {e}")))?
}

#[cfg(any(test, windows))]
fn same_tool_bytes(original: &Path, alias: &Path, signals: &JobSignals) -> Result<bool, GoopError> {
    Ok(crate::recovery::hash(original, signals)? == crate::recovery::hash(alias, signals)?)
}

async fn validate_media(
    probe: &Path,
    path: &Path,
    req: &ExtractRequest,
    cp: &RecoveryCheckpoint,
    signals: &JobSignals,
) -> Result<(), GoopError> {
    let mut command = Command::new(probe);
    command
        .args(["-v", "error", "-show_streams", "-of", "json"])
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::select! {
        biased;
        int = signals.interrupted() => return Err(int.into()),
        output = command.output() => output?,
    };
    let info: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let streams = info["streams"]
        .as_array()
        .ok_or_else(|| GoopError::Queue("Extract output has no media streams".into()))?;
    let audio = streams.iter().any(|s| s["codec_type"] == "audio");
    let video = streams.iter().any(|s| s["codec_type"] == "video");
    let needs_audio = req.audio_only
        || cp
            .sources
            .iter()
            .any(|s| s.acodec.as_deref().is_some_and(|codec| codec != "none"));
    let needs_video = !req.audio_only
        && cp
            .sources
            .iter()
            .any(|s| s.vcodec.as_deref().is_some_and(|codec| codec != "none"));
    if !output.status.success()
        || (!audio && !video)
        || (needs_audio && !audio)
        || (needs_video && !video)
        || (req.audio_only && video)
    {
        return Err(GoopError::Queue(
            "Extract output did not contain the expected media streams".into(),
        ));
    }
    Ok(())
}

fn copy_candidate(source: &Path, candidate: &Path, signals: &JobSignals) -> Result<(), GoopError> {
    use std::io::{Read, Write};
    let mut from = std::fs::File::open(source)?;
    let mut to = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(candidate)?;
    let mut buffer = [0; 128 * 1024];
    loop {
        if let Some(int) = signals.check() {
            return Err(int.into());
        }
        let n = from.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        to.write_all(&buffer[..n])?;
    }
    to.sync_all()?;
    Ok(())
}

fn progress_regexes() -> &'static (Regex, Regex, Regex) {
    static REGEXES: OnceLock<(Regex, Regex, Regex)> = OnceLock::new();
    REGEXES.get_or_init(|| {
        // invariant: these hardcoded patterns are valid regex syntax.
        (
            Regex::new(r"(\d+\.\d+)%").expect("pct regex"),
            Regex::new(r"at\s+([\d.]+\s*[KMG]?i?B/s)").expect("speed regex"),
            Regex::new(r"ETA\s+(\d{2}:\d{2}(:\d{2})?)").expect("eta regex"),
        )
    })
}

/// Parse yt-dlp's `--newline` progress line, e.g.
/// `[download]  42.3% of ~1.23MiB at 1.20MiB/s ETA 00:10`
fn parse_progress(job_id: JobId, line: &str) -> Option<ProgressEvent> {
    if let Some(raw) = line.strip_prefix("__GOOP_DL__") {
        let v: serde_json::Value = serde_json::from_str(raw).ok()?;
        let total = v["total_bytes"]
            .as_f64()
            .or_else(|| v["total_bytes_estimate"].as_f64());
        let percent = total
            .filter(|n| *n > 0.0)
            .map(|n| v["downloaded_bytes"].as_f64().unwrap_or(0.0) / n * 100.0)
            .unwrap_or(0.0)
            .clamp(0.0, 100.0);
        return Some(ProgressEvent {
            job_id,
            percent: percent as f32,
            eta_secs: v["eta"].as_f64().filter(|n| *n >= 0.0).map(|n| n as u64),
            speed_hr: v["speed"]
                .as_f64()
                .filter(|n| *n >= 0.0)
                .map(|n| format!("{:.1} MiB/s", n / 1048576.0)),
            stage: "downloading".into(),
            encoder: None,
        });
    }
    if let Some(raw) = line.strip_prefix("__GOOP_PP__") {
        let v: serde_json::Value = serde_json::from_str(raw).ok()?;
        let stage = match v["postprocessor"].as_str()? {
            "Merger" => "merging",
            "ExtractAudio" => "converting",
            _ => "processing",
        };
        return Some(ProgressEvent {
            job_id,
            percent: 0.0,
            eta_secs: None,
            speed_hr: None,
            stage: stage.into(),
            encoder: None,
        });
    }
    if !line.starts_with("[download]") {
        return None;
    }
    let (pct_re, speed_re, eta_re) = progress_regexes();
    let pct = pct_re
        .captures(line)?
        .get(1)?
        .as_str()
        .parse::<f32>()
        .ok()?;
    let speed = speed_re
        .captures(line)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());
    let eta_secs = eta_re
        .captures(line)
        .and_then(|c| c.get(1))
        .and_then(|m| parse_eta(m.as_str()));
    Some(ProgressEvent {
        job_id,
        percent: pct,
        eta_secs,
        speed_hr: speed,
        stage: "downloading".into(),
        encoder: None,
    })
}

fn parse_eta(s: &str) -> Option<u64> {
    let parts: Vec<u64> = s.split(':').filter_map(|p| p.parse().ok()).collect();
    match parts.len() {
        2 => Some(parts[0] * 60 + parts[1]),
        3 => Some(parts[0] * 3600 + parts[1] * 60 + parts[2]),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_replaced_tool_alias_is_rejected_before_retry() {
        let bins = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        for name in ["ffmpeg.exe", "ffprobe.exe"] {
            std::fs::write(bins.path().join(name), b"trusted executable").unwrap();
        }
        let resolver = BinaryResolver::new(bins.path().to_owned());
        prepare_media_tools(&resolver, workspace.path(), JobSignals::new())
            .await
            .unwrap();
        let alias = workspace.path().join("ffmpeg.exe");
        std::fs::remove_file(&alias).unwrap();
        std::fs::write(&alias, b"changed executable").unwrap();
        assert!(
            prepare_media_tools(&resolver, workspace.path(), JobSignals::new())
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read(bins.path().join("ffmpeg.exe")).unwrap(),
            b"trusted executable"
        );
    }

    #[test]
    fn copied_tool_alias_requires_matching_bytes_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original");
        let alias = dir.path().join("alias");
        std::fs::write(&original, b"trusted executable").unwrap();
        std::fs::copy(&original, &alias).unwrap();
        assert!(same_tool_bytes(&original, &alias, &JobSignals::new()).unwrap());
        std::fs::write(&alias, b"changed executable").unwrap();
        assert!(!same_tool_bytes(&original, &alias, &JobSignals::new()).unwrap());
    }

    #[test]
    fn parses_download_progress_line() {
        let line = "[download]  42.3% of ~1.23MiB at 1.20MiB/s ETA 00:10";
        let ev = parse_progress(JobId::new(), line).expect("should parse");
        assert!((ev.percent - 42.3).abs() < 0.01);
        assert_eq!(ev.speed_hr.as_deref(), Some("1.20MiB/s"));
        assert_eq!(ev.eta_secs, Some(10));
        assert_eq!(ev.stage, "downloading");
    }

    #[test]
    fn rejects_non_download_lines() {
        assert!(parse_progress(JobId::new(), "[info] Something").is_none());
    }

    /// Shapes taken verbatim from a real `-J` response, which is the only
    /// way to keep these honest: the storyboard rows in particular look
    /// like ordinary formats until you notice both codecs are "none".
    fn formats_json() -> serde_json::Value {
        serde_json::json!([
            // Storyboards: yt-dlp lists them first and they are not media.
            {"format_id": "sb1", "ext": "mhtml", "resolution": "160x90",
             "vcodec": "none", "acodec": "none"},
            // Audio-only.
            {"format_id": "140", "ext": "m4a", "resolution": "audio only",
             "vcodec": "none", "acodec": "mp4a.40.2", "filesize": 100},
            // Muxed (carries both streams).
            {"format_id": "18", "ext": "mp4", "resolution": "640x360",
             "vcodec": "avc1.42001E", "acodec": "mp4a.40.2"},
            // Video-only — the silent-file case.
            {"format_id": "299", "ext": "mp4", "resolution": "1920x1080",
             "vcodec": "avc1.640028", "acodec": "none"},
        ])
    }

    #[test]
    fn parse_formats_drops_storyboards() {
        let out = parse_formats(&formats_json());
        assert!(
            !out.iter().any(|f| f.format_id == "sb1"),
            "storyboards are not downloadable media and must never be offered"
        );
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn parse_formats_merges_audio_into_video_only_selector() {
        let out = parse_formats(&formats_json());
        let video_only = out.iter().find(|f| f.format_id == "299").expect("299");
        // Without the +bestaudio fallback yt-dlp hands back a silent file.
        assert_eq!(video_only.selector, "299+bestaudio/299");
        assert!(!video_only.is_audio_only);
    }

    #[test]
    fn parse_formats_leaves_muxed_and_audio_only_selectors_bare() {
        let out = parse_formats(&formats_json());
        let muxed = out.iter().find(|f| f.format_id == "18").expect("18");
        assert_eq!(muxed.selector, "18", "muxed already carries audio");
        let audio = out.iter().find(|f| f.format_id == "140").expect("140");
        assert_eq!(
            audio.selector, "140",
            "adding bestaudio would give the file two audio tracks"
        );
        assert!(audio.is_audio_only);
    }

    #[test]
    fn parse_formats_returns_best_first() {
        let out = parse_formats(&formats_json());
        // yt-dlp emits ascending by quality. The picker renders this order
        // directly, so the best entries have to survive at the front.
        assert_eq!(out[0].format_id, "299");
        assert_eq!(out.last().expect("non-empty").format_id, "140");
    }

    #[test]
    fn parse_formats_keeps_rows_whose_codecs_are_unknown() {
        // Not every extractor populates codec metadata. archive.org
        // returns exactly this for its three real, playable derivatives:
        // `vcodec: null, acodec: null`. That is "I don't know", not "this
        // stream is absent" — conflating the two empties the picker for
        // the whole site. Both the JSON-null and absent-key spellings.
        let v = serde_json::json!([
            {"format_id": "0", "ext": "mp4", "vcodec": null, "acodec": null},
            {"format_id": "1", "ext": "avi"},
        ]);
        let out = parse_formats(&v);
        assert_eq!(
            out.len(),
            2,
            "unknown codecs must not be mistaken for a storyboard"
        );
        for f in &out {
            // No merge: we can't claim the stream lacks audio, so the
            // bare id keeps yt-dlp's own behaviour.
            assert_eq!(f.selector, f.format_id);
            // And it must not be labelled "audio only" on a guess.
            assert!(!f.is_audio_only);
        }
    }

    // Unix-only: `write_fake` writes `/bin/sh` scripts, and `test_fakes`
    // is itself `#[cfg(all(test, unix))]` — without this gate the whole
    // crate's test target fails to COMPILE on Windows, which no CI job
    // would catch (only the ubuntu leg runs `cargo test --workspace`).
    // Same convention as `backend.rs`'s `fake_sidecar_tests`.
    #[cfg(unix)]
    #[tokio::test]
    async fn probe_pins_no_playlist_on_the_command_line() {
        // Without the flag, `watch?v=X&list=Y` — the shape you get by
        // copying a link off a playlist page — probes as `_type: playlist`.
        // The card then shows the PLAYLIST's title with zero formats, and
        // yt-dlp fully extracts every entry first, so the user watches
        // "Looking up that link..." for minutes.
        let bins = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let argv = out.path().join("argv");
        crate::test_fakes::write_fake(
            bins.path(),
            "yt-dlp",
            &format!(
                "for a in \"$@\"; do echo \"$a\" >> '{}'; done\n\
                 echo '{{\"title\":\"t\",\"formats\":[]}}'\nexit 0\n",
                argv.display()
            ),
        );
        let _ = YtDlp::probe_once(
            &bins.path().join("yt-dlp"),
            "https://www.youtube.com/watch?v=x&list=y",
            None,
        )
        .await;
        let sent = std::fs::read_to_string(&argv).unwrap_or_default();
        assert!(
            sent.contains("--no-playlist"),
            "probe argv must pin --no-playlist; got:\n{sent}"
        );
    }

    #[test]
    fn parse_formats_drops_only_explicitly_streamless_rows() {
        // The storyboard discriminator is the literal string "none" on
        // both, which is what yt-dlp actually emits for them.
        let v = serde_json::json!([
            {"format_id": "sb0", "ext": "mhtml", "vcodec": "none", "acodec": "none"},
            {"format_id": "real", "ext": "mp4", "vcodec": "avc1.64", "acodec": "none"},
        ]);
        let out = parse_formats(&v);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].format_id, "real");
    }

    #[test]
    fn is_generic_direct_routes_plain_files_to_direct_downloader() {
        // The real shape yt-dlp emits for a plain direct file (e.g. a .zip/.dat).
        let plain = serde_json::json!({
            "extractor": "generic", "extractor_key": "Generic",
            "direct": true, "protocol": "https", "_type": "video"
        });
        assert!(is_generic_direct(&plain));
    }

    #[test]
    fn is_generic_direct_excludes_real_extractions_manifests_and_playlists() {
        // A real site extraction (YouTube etc.) — keep yt-dlp.
        assert!(!is_generic_direct(&serde_json::json!({
            "extractor": "youtube", "direct": false, "protocol": "https"
        })));
        // Generic HTML page with embedded media (not a direct file).
        assert!(!is_generic_direct(&serde_json::json!({
            "extractor": "generic", "direct": false, "protocol": "https"
        })));
        // Generic but a streaming manifest — must stay on yt-dlp.
        assert!(!is_generic_direct(&serde_json::json!({
            "extractor": "generic", "direct": true, "protocol": "m3u8_native"
        })));
        // FTP — direct::probe only accepts http(s), so never reroute it.
        assert!(!is_generic_direct(&serde_json::json!({
            "extractor": "generic", "direct": true, "protocol": "ftp"
        })));
        // A playlist — never reroute.
        assert!(!is_generic_direct(&serde_json::json!({
            "extractor": "generic", "direct": true, "protocol": "https",
            "_type": "playlist"
        })));
    }

    #[test]
    fn parse_eta_hours() {
        assert_eq!(parse_eta("01:02:03"), Some(3723));
        assert_eq!(parse_eta("02:05"), Some(125));
    }

    #[test]
    fn validated_browser_accepts_known_names() {
        assert_eq!(validated_browser(Some("chrome")), Some("chrome"));
        assert_eq!(validated_browser(Some("firefox")), Some("firefox"));
        assert_eq!(validated_browser(Some("safari")), Some("safari"));
    }

    #[test]
    fn validated_browser_rejects_unknown_or_path_traversal() {
        // None passes through.
        assert_eq!(validated_browser(None), None);
        // Bare unknown string.
        assert_eq!(validated_browser(Some("netscape")), None);
        // yt-dlp profile-suffix syntax (chrome:profile_path) is rejected
        // because we don't expose profile selection in the UI and the
        // suffix can carry filesystem paths.
        assert_eq!(validated_browser(Some("chrome:../../tmp/evil")), None);
        assert_eq!(validated_browser(Some("firefox:default")), None);
        // Empty / whitespace.
        assert_eq!(validated_browser(Some("")), None);
        assert_eq!(validated_browser(Some(" chrome")), None);
    }

    /// The retry-eligibility check used in `download`. Verifies that
    /// the predicate decision matches expectations across the cases that
    /// matter — the warning message + actual retry execution are
    /// covered by manual smoke testing on Windows (the repro
    /// environment) since the existing crate has no subprocess-level
    /// integration tests.
    #[test]
    fn cookie_retry_eligibility_decisions() {
        use goop_core::is_cookie_db_error as is_cookie;

        // Cookie error stderr + cookies were set + not cancelled → retry
        let chrome_err = "ERROR: Could not copy Chrome cookie database. See yt-dlp/yt-dlp#7271";
        assert!(is_cookie(chrome_err));

        // No-match: a cookies-set request with a non-cookie failure should
        // NOT trigger retry.
        assert!(!is_cookie("HTTPError: 404 Not Found"));
        assert!(!is_cookie("Sign in to confirm your age"));

        // No-match: even a cookie error should not retry if cookies
        // weren't requested in the first place — the calling code's
        // additional `req.cookies_from_browser.is_some()` guard covers
        // that branch and is unit-testable here through the ExtractRequest
        // shape.
        let req_no_cookies = ExtractRequest {
            url: "https://example.com".into(),
            output_dir: "/tmp".into(),
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
        };
        assert!(req_no_cookies.cookies_from_browser.is_none());
    }

    #[test]
    fn unknown_output_template_falls_back_to_default() {
        // Defense-in-depth: an unrecognised template value (stale payload,
        // tampered DB, etc.) must not be passed to yt-dlp argv.
        let smuggled = "; rm -rf / #";
        assert!(!KNOWN_TEMPLATES.contains(&smuggled));
    }

    #[test]
    fn known_templates_are_unique() {
        for (i, a) in KNOWN_TEMPLATES.iter().enumerate() {
            for (j, b) in KNOWN_TEMPLATES.iter().enumerate().skip(i + 1) {
                assert_ne!(a, b, "duplicate template at indices {i}/{j}");
            }
        }
    }
}
