//! Routing layer that picks between yt-dlp and gallery-dl based on the
//! URL's classifier output, then falls back to the OTHER extractor if the
//! chosen one either doesn't recognise the URL or is blocked by the site.
//!
//! The fallback rule itself lives in `goop_core::error`
//! (`warrants_other_extractor` / `both_failed`) rather than here, because
//! the probe path in `src-tauri/src/commands/extract.rs` has to make the
//! identical decision. Two hand-copied versions of it drifted once
//! already.
//!
//! `dispatch` is the only thing the IPC layer needs to call. Both
//! backends produce the same `BackendOutcome` shape so the caller can
//! convert to a `JobResult` without caring which extractor ran.

use goop_core::{
    both_failed, warrants_other_extractor, BothFailed, EventSink, GoopError, JobId, JobSignals,
    WarnOnceSink,
};
use goop_sidecar::BinaryResolver;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::classify::{classify_extractor, ExtractorChoice};
use crate::debrid::{self, DebridCtx, TorBoxClient};
use crate::gallery_dl::GalleryDl;
use crate::retry::{with_retry, RetryPolicy, DEFAULT_RETRY_POLICY};
use crate::ytdlp::{ExtractRequest, YtDlp};

/// Uniform result the IPC layer turns into a `JobResult`. `result_kind`
/// here is the corresponding `goop_core::ResultKind` variant — we keep
/// the dispatch crate decoupled from that enum by stringifying.
#[derive(Debug)]
pub struct BackendOutcome {
    pub output_path: String,
    pub bytes: u64,
    pub duration_ms: u64,
    /// `"file"` for yt-dlp single-file results, `"folder"` for
    /// gallery-dl folder-of-files results.
    pub result_kind: ResultKindTag,
    /// Number of files produced. `1` for `File`; `N` for `Folder`.
    pub file_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultKindTag {
    File,
    Folder,
}

/// Dispatch an extract request: classify the URL, run the chosen
/// extractor, and fall back to the OTHER one when the first either
/// doesn't recognise the URL or is refused by the site (401/403) — a
/// block describes the request, not the content, so the other extractor
/// may still be let through. Transient network failures are retried with
/// backoff (resuming from partial files); every other failure mode
/// (a real auth wall, rate limits on the subprocess paths, unsupported
/// input) propagates on the first attempt.
pub async fn dispatch(
    resolver: &BinaryResolver,
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
    debrid: Option<DebridCtx>,
) -> Result<BackendOutcome, GoopError> {
    dispatch_with_policy(
        resolver,
        sink,
        job_id,
        req,
        signals,
        &DEFAULT_RETRY_POLICY,
        debrid,
    )
    .await
}

/// Reported by an `UpdateHook` when the sidecar on disk actually changed.
/// `from` is `"unknown"` when the previous version couldn't be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryUpdated {
    pub from: String,
    pub to: String,
}

/// Asked to bring yt-dlp up to date after a failure that looks like the
/// binary is stale (`goop_core::is_stale_extractor_suspect`).
///
/// `Some` ONLY when different bytes are now on disk. That is the entire
/// justification for running the job again, so "checked, already current",
/// "another check is in flight", "throttled" and "the check failed" are all
/// `None` — each would otherwise buy a second identical spawn and a claim of
/// a retry that fixed nothing.
///
/// The hook owns its own throttling and its own kill switch. This layer asks
/// and believes the answer.
pub type UpdateHook =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Option<BinaryUpdated>> + Send>> + Send + Sync>;

/// The line appended to a second failure's raw stderr.
fn update_marker(u: &BinaryUpdated) -> String {
    format!(
        "[goop] yt-dlp auto-updated {} -> {}; retried once",
        u.from, u.to
    )
}

/// `dispatch`, plus one shot at fixing a stale yt-dlp.
///
/// Extractors rot on a schedule nobody controls: a site changes its player,
/// every installed yt-dlp starts failing on it, and upstream ships a fix
/// within days. The binary on disk does not move on its own, so the user's
/// half of that fix is noticing a Settings button exists. This closes the
/// loop for the one failure class where it is warranted — and only there,
/// because `is_stale_extractor_suspect` denies everything that is a fact
/// about the URL rather than about the binary.
///
/// Deliberately wrapped AROUND `dispatch` rather than folded into it:
///
/// - not inside `with_retry`, which would spend the transient budget on an
///   update check and could fire it several times per job;
/// - not in the scheduler, which is kind-agnostic and has no business
///   knowing what yt-dlp is.
///
/// The retried dispatch gets a fresh transient-retry budget. That is correct:
/// it is a different binary, so its network failures are not a continuation
/// of the first attempt's.
pub async fn dispatch_with_update_hook(
    resolver: &BinaryResolver,
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
    debrid: Option<DebridCtx>,
    hook: Option<UpdateHook>,
) -> Result<BackendOutcome, GoopError> {
    let err = match dispatch(
        resolver,
        sink.clone(),
        job_id,
        req,
        signals.clone(),
        debrid.clone(),
    )
    .await
    {
        Ok(outcome) => return Ok(outcome),
        Err(err) => err,
    };
    let Some(hook) = hook else {
        return Err(err);
    };
    // A fired signal (cancel OR pause) suppresses all of this, exactly as it
    // suppresses the cross-extractor fallback: the user asked this job to
    // stop, not to reach for the network on its way out.
    if signals.check().is_some() || !stale_suspect(&err) {
        return Err(err);
    }
    tracing::info!(?job_id, reason = %err, "failure looks stale; checking for a newer yt-dlp");
    let Some(updated) = hook().await else {
        tracing::info!(?job_id, "no newer yt-dlp; not retrying");
        return Err(err);
    };
    tracing::info!(?job_id, from = %updated.from, to = %updated.to, "yt-dlp updated; retrying once");
    // Checked again on the far side: an update is a download, and the user
    // can cancel during one.
    if signals.check().is_some() {
        return Err(err);
    }
    match dispatch(resolver, sink, job_id, req, signals, debrid).await {
        Ok(outcome) => Ok(outcome),
        Err(err2) => Err(note_update(err2, &updated)),
    }
}

fn stale_suspect(err: &GoopError) -> bool {
    match err {
        GoopError::SubprocessFailed { binary, stderr } => {
            goop_core::is_stale_extractor_suspect(binary, stderr)
        }
        _ => false,
    }
}

/// Append the update note to a second failure's raw text.
///
/// Appended, never prepended: `user_message` shows the raw stderr whenever no
/// friendly pattern matched, and burying the tool's own words under a line of
/// Goop's bookkeeping is the wrong way round for whoever has to read it.
///
/// Only `SubprocessFailed` is annotated. `Network`'s detail *is* its headline
/// (see `GoopError::detail`), so a note there would land in the message
/// itself; and the control-flow variants have no detail to carry it.
fn note_update(err: GoopError, updated: &BinaryUpdated) -> GoopError {
    match err {
        GoopError::SubprocessFailed { binary, stderr } => {
            let sep = if stderr.ends_with('\n') { "" } else { "\n" };
            GoopError::SubprocessFailed {
                stderr: format!("{stderr}{sep}{}", update_marker(updated)),
                binary,
            }
        }
        other => other,
    }
}

/// Platform-independent, unlike `fake_sidecar_tests` below — the note is
/// pure string work and its edges are worth pinning on Windows too.
#[cfg(test)]
mod note_update_tests {
    use super::*;

    fn updated() -> BinaryUpdated {
        BinaryUpdated {
            from: "2026.01.01".into(),
            to: "2026.08.09".into(),
        }
    }

    fn stderr_of(err: &GoopError) -> String {
        match err {
            GoopError::SubprocessFailed { stderr, .. } => stderr.clone(),
            other => panic!("expected SubprocessFailed, got {other:?}"),
        }
    }

    /// Real extractor stderr is line-buffered and arrives with a trailing
    /// newline, so the common path must not add a blank line.
    #[test]
    fn a_trailing_newline_is_not_doubled() {
        let err = note_update(
            GoopError::SubprocessFailed {
                binary: "yt-dlp".into(),
                stderr: "ERROR: boom\n".into(),
            },
            &updated(),
        );
        assert_eq!(
            stderr_of(&err),
            "ERROR: boom\n[goop] yt-dlp auto-updated 2026.01.01 -> 2026.08.09; retried once"
        );
    }

    /// A stderr tail truncated mid-stream has no trailing newline (the
    /// wrapper caps it at 8KiB on a char boundary). Without the separator
    /// the note would be glued onto the end of the tool's last word.
    #[test]
    fn a_truncated_tail_still_gets_its_own_line() {
        let err = note_update(
            GoopError::SubprocessFailed {
                binary: "yt-dlp".into(),
                stderr: "ERROR: boom".into(),
            },
            &updated(),
        );
        assert_eq!(
            stderr_of(&err),
            "ERROR: boom\n[goop] yt-dlp auto-updated 2026.01.01 -> 2026.08.09; retried once"
        );
    }

    /// The note must not turn a control-flow error into something the
    /// scheduler reads as a failure, and there is no raw text to carry it on
    /// anyway.
    #[test]
    fn control_flow_errors_are_left_alone() {
        for e in [
            GoopError::Cancelled,
            GoopError::Paused,
            GoopError::Network("connection reset".into()),
        ] {
            let before = format!("{e:?}");
            assert_eq!(format!("{:?}", note_update(e, &updated())), before);
        }
    }
}

/// Test seam: `dispatch` with an injectable retry policy so tests can
/// drive the backoff with millisecond delays against a mock server.
pub(crate) async fn dispatch_with_policy(
    resolver: &BinaryResolver,
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
    policy: &RetryPolicy,
    debrid: Option<DebridCtx>,
) -> Result<BackendOutcome, GoopError> {
    // Warnings are raised by whichever extractor hits the condition, but
    // this is the only layer that knows how many extractors ran and how
    // often the pipeline replayed: `with_retry` re-runs `dispatch_once`,
    // which may try both extractors. Two extractors hitting the same
    // locked cookie DB across five attempts is ONE fact, so collapse
    // repeats of a code to the first for the span of this dispatch.
    // Progress (including `with_retry`'s own backoff events) is untouched.
    //
    // Scoped to the dispatch, not the app: a resumed or manually retried
    // job comes back through here with a fresh wrapper and warns again,
    // which is intended — the user acted. Shadowing `sink` keeps the
    // unwrapped one from being used below by accident.
    let sink = WarnOnceSink::wrap(sink);
    with_retry(policy, &signals, &sink, job_id, || {
        dispatch_once(
            resolver,
            sink.clone(),
            job_id,
            req,
            signals.clone(),
            debrid.clone(),
        )
    })
    .await
}

/// One full attempt of the classify → primary → fallback → direct
/// pipeline. The retry wrapper re-runs this whole function, so an
/// attempt that failed transiently mid-fallback re-classifies cleanly.
/// The inner cookie-fallback and cross-extractor retries can't compound
/// with the transient retries: their trigger strings (cookie-DB errors,
/// "Unsupported URL", 401/403) are disjoint from the transient set —
/// asserted by `access_blocked_is_disjoint_from_the_transient_and_unsupported_sets`
/// in `goop_core::error`.
async fn dispatch_once(
    resolver: &BinaryResolver,
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
    debrid: Option<DebridCtx>,
) -> Result<BackendOutcome, GoopError> {
    // Debrid path: magnet links always (only a debrid service can turn
    // them into HTTP), plus hoster links the probe already matched.
    if req.debrid || debrid::is_magnet(&req.url) {
        let Some(ctx) = debrid.as_ref() else {
            return Err(GoopError::Queue(
                "This link needs the TorBox debrid service — add your TorBox API key in Settings"
                    .into(),
            ));
        };
        tracing::info!(?job_id, route = "debrid", "dispatch");
        return debrid::run(sink, job_id, req, signals, ctx).await;
    }
    // Fast path: the probe already determined this is a plain file neither
    // extractor handles, so skip the two doomed extractor spawns.
    if req.direct {
        tracing::info!(?job_id, route = "direct", "dispatch");
        return crate::direct::download(sink, job_id, req, signals).await;
    }
    let primary = classify_extractor(&req.url);
    tracing::info!(?job_id, extractor = ?primary, "dispatch");
    let err = match run_one(
        resolver,
        sink.clone(),
        job_id,
        req,
        signals.clone(),
        primary,
    )
    .await
    {
        Ok(outcome) => return Ok(outcome),
        Err(err) => err,
    };
    // A fired signal (cancel OR pause) suppresses the fallback: the user
    // asked this job to stop, not to try harder.
    if signals.check().is_some() || !warrants_other_extractor(&err) {
        return Err(err);
    }
    tracing::info!(
        ?job_id,
        from = ?primary,
        to = ?primary.other(),
        reason = %err,
        "falling back to the other extractor"
    );
    let err2 = match run_one(
        resolver,
        sink.clone(),
        job_id,
        req,
        signals.clone(),
        primary.other(),
    )
    .await
    {
        Ok(outcome) => return Ok(outcome),
        Err(err2) => err2,
    };
    if signals.check().is_some() {
        return Err(err2);
    }
    match both_failed(err, err2) {
        // Neither extractor recognised the URL: stream it directly. If even
        // the direct download fails, hand off to the debrid backend as a
        // last resort (a supported hoster link the probe didn't pre-match).
        BothFailed::TryDirect => {
            tracing::info!(
                ?job_id,
                "neither extractor claimed the URL; trying a direct download"
            );
            match crate::direct::download(sink.clone(), job_id, req, signals.clone()).await {
                Ok(outcome) => Ok(outcome),
                Err(err3) => debrid_last_resort(sink, job_id, req, signals, debrid, err3).await,
            }
        }
        BothFailed::Surface(e) => Err(e),
    }
}

/// Last-resort fallback for un-hinted hoster links: the whole
/// extractor → direct chain failed, so ask TorBox whether it supports
/// this host and route through it if so. Control-flow errors and an
/// absent key pass the original failure through untouched.
async fn debrid_last_resort(
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
    debrid: Option<DebridCtx>,
    err: GoopError,
) -> Result<BackendOutcome, GoopError> {
    if matches!(
        err,
        GoopError::Cancelled | GoopError::Paused | GoopError::WaitingExternal { .. }
    ) || signals.check().is_some()
    {
        return Err(err);
    }
    let Some(ctx) = debrid else {
        return Err(err);
    };
    let client = TorBoxClient::new(&ctx.api_base, &ctx.api_key);
    match client.hosters().await {
        Ok(matcher) if matcher.matches(&req.url) => {
            debrid::run(sink, job_id, req, signals, &ctx).await
        }
        _ => Err(err),
    }
}

async fn run_one(
    resolver: &BinaryResolver,
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
    backend: ExtractorChoice,
) -> Result<BackendOutcome, GoopError> {
    match backend {
        ExtractorChoice::YtDlp => {
            let yt = YtDlp::new(resolver, sink);
            let res = yt.download(job_id, req, signals).await?;
            Ok(BackendOutcome {
                output_path: res.output_path,
                bytes: res.bytes,
                duration_ms: res.duration_ms,
                result_kind: ResultKindTag::File,
                file_count: 1,
            })
        }
        ExtractorChoice::GalleryDl => {
            let gd = GalleryDl::new(resolver, sink);
            let res = gd.download(job_id, req, signals).await?;
            Ok(BackendOutcome {
                output_path: res.output_path,
                bytes: res.bytes,
                duration_ms: res.duration_ms,
                result_kind: ResultKindTag::Folder,
                file_count: res.file_count,
            })
        }
    }
}

/// Best-effort removal of every partial-download artifact a run may have
/// left behind for `req`: the direct downloader's hidden `.part`/`.meta`
/// sidecars, recent yt-dlp/gallery-dl `.part`/`.ytdl` files, and the
/// gallery-dl start marker. Used when a paused download is cancelled —
/// pause keeps partials by contract, and the worker that would normally
/// clean up on cancel already returned.
pub fn cleanup_partials_for(req: &ExtractRequest) {
    let expanded = goop_core::path::expand(&req.output_dir);
    let output_dir = std::fs::canonicalize(&expanded).unwrap_or(expanded);
    crate::direct::remove_partials(&output_dir, &req.url);
    crate::ytdlp::cleanup_partials(&output_dir, None);
    crate::gallery_dl::cleanup_run_artifacts(&output_dir, &req.url);
}

/// End-to-end dispatch tests driven by fake sidecars — shell scripts that
/// reproduce the stderr real yt-dlp / gallery-dl emit. They exist to pin
/// down how many cookie warnings ONE dispatch produces, which is a
/// property of how this module composes the extractors with the retry
/// wrapper and so is invisible to either extractor's own unit tests.
///
/// They assert on the warnings a plain `RecordingSink` receives, never on
/// `WarnOnceSink` itself, so they'd hold for any other implementation of
/// the same guarantee.
///
/// Unix-only: the fakes are `/bin/sh` scripts. The logic under test is
/// platform-independent, so the coverage gap on Windows is acceptable.
#[cfg(all(test, unix))]
mod fake_sidecar_tests {
    use super::*;
    use goop_core::events::RecordingSink;
    use goop_core::{SidecarEvent, WarningCode};
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tempfile::TempDir;

    /// Bails out the way a locked or unreadable browser cookie DB does,
    /// but only when `--cookies-from-browser` is on the argv — so the
    /// wrapper's no-cookie retry gets past it. Matches
    /// `goop_core::is_cookie_db_error`.
    const COOKIE_FAIL_WITH_COOKIES: &str = r#"
for a in "$@"; do
  if [ "$a" = "--cookies-from-browser" ]; then
    echo "ERROR: Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271" >&2
    exit 1
  fi
done
"#;

    /// A successful gallery-dl run: one file into whatever `--directory`
    /// it was handed. That file is what the post-exit scan tallies, so the
    /// run counts as real work rather than "no extractable content".
    ///
    /// The sleep is load-bearing, not padding. `scan_outputs` counts files
    /// whose mtime is at or after a cutoff sampled from a fine-grained
    /// `SystemTime::now()`, while Linux stamps mtimes from the kernel's
    /// coarse clock — a jiffy wide (4ms at the CONFIG_HZ_250 most distro
    /// kernels ship). A file written within a tick of the cutoff can carry
    /// an mtime just behind it and go uncounted, failing the run as "no
    /// extractable content". Real gallery-dl needs a network round-trip
    /// before the first file lands, so only an instantaneous fake can hit
    /// that window.
    ///
    /// The stdout line real gallery-dl prints per file only drives
    /// progress, so it is tolerated failing — the drain fake below has
    /// already closed stdout, and an unguarded `echo` to a closed fd would
    /// put a shell error on stderr, which is the one stream those tests
    /// care about.
    const GALLERY_DL_WRITES_ONE_FILE: &str = r#"
dir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--directory" ]; then dir="$a"; fi
  prev="$a"
done
sleep 0.05
printf 'x' > "$dir/photo.jpg"
echo "$dir/photo.jpg" 2>/dev/null || true
exit 0
"#;

    /// Millisecond backoff, so the retry tests spend no real time waiting.
    /// Shallower than `DEFAULT_RETRY_POLICY` (which allows 4 retries): 2
    /// retries is enough to prove the replay without three extra spawns.
    const FAST_RETRIES: RetryPolicy = RetryPolicy {
        max_retries: 2,
        base_delay: Duration::from_millis(1),
        max_delay: Duration::from_millis(1),
    };

    fn write_fake(dir: &std::path::Path, name: &str, body: &str) {
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        write!(f, "#!/bin/sh\n{body}").unwrap();
        drop(f);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn warning_codes(sink: &RecordingSink) -> Vec<WarningCode> {
        sink.sidecar
            .lock()
            .iter()
            .filter_map(|e| match e {
                SidecarEvent::Warning { code, .. } => Some(*code),
                _ => None,
            })
            .collect()
    }

    /// A yt-dlp that succeeds: writes one file and echoes its absolute path
    /// on stdout, which is how the wrapper learns what it produced (a line
    /// that doesn't start with `[` and names an existing path). The path is
    /// baked in at write time rather than parsed off argv — the wrapper's
    /// flag spelling is not what these tests are about.
    fn yt_dlp_succeeds(out: &std::path::Path) -> String {
        let f = out.join("video.mp4");
        let f = f.to_string_lossy();
        format!("printf 'x' > '{f}'\necho '{f}'\nexit 0\n")
    }

    /// Appends one line per run, so a test can count spawns rather than
    /// infer them from side effects.
    fn counting(counter: &std::path::Path, body: &str) -> String {
        format!("echo run >> '{}'\n{body}", counter.display())
    }

    fn runs(counter: &std::path::Path) -> usize {
        std::fs::read_to_string(counter)
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    /// Replaces a fake in place the way a real update does — via rename, so
    /// the new script lands on a fresh inode. Overwriting the file the
    /// previous spawn just exited from can still be ETXTBSY on Linux.
    fn replace_fake(dir: &std::path::Path, name: &str, body: &str) {
        write_fake(dir, "pending", body);
        std::fs::rename(dir.join("pending"), dir.join(name)).unwrap();
    }

    fn hook_returning(
        updated: Option<BinaryUpdated>,
        on_call: impl Fn() + Send + Sync + 'static,
    ) -> (UpdateHook, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let on_call = Arc::new(on_call);
        let h: UpdateHook = Arc::new(move || {
            let c = c.clone();
            let updated = updated.clone();
            let on_call = on_call.clone();
            Box::pin(async move {
                c.fetch_add(1, Ordering::SeqCst);
                on_call();
                updated
            })
        });
        (h, calls)
    }

    fn updated() -> BinaryUpdated {
        BinaryUpdated {
            from: "2026.01.01".into(),
            to: "2026.08.09".into(),
        }
    }

    /// yt-dlp's extractor internals failing against a changed player. Not
    /// transient, and not a no-match, so nothing else in the pipeline claims
    /// it: it reaches the update hook or it reaches the user.
    const STALE_FAILURE: &str =
        "echo 'ERROR: [youtube] abc: Unable to extract player response' >&2\nexit 1\n";

    fn request(url: &str, output_dir: &std::path::Path) -> ExtractRequest {
        ExtractRequest {
            url: url.into(),
            output_dir: output_dir.to_string_lossy().into_owned(),
            format: None,
            audio_only: false,
            cookies_from_browser: Some("chrome".into()),
            output_template: None,
            direct: false,
            debrid: false,
            debrid_item: None,
            resume_key: None,
            filename_hint: None,
        }
    }

    /// Regression: yt-dlp cookie-fails and declines the URL, dispatch
    /// falls back to gallery-dl, which cookie-fails too and then
    /// succeeds. The job works, so the user gets ONE heads-up — not one
    /// per extractor that happened to touch the same locked cookie DB.
    #[tokio::test]
    async fn cookie_warning_fires_once_when_the_fallback_extractor_also_cookie_fails() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        write_fake(
            bins.path(),
            "yt-dlp",
            &format!(
                "{COOKIE_FAIL_WITH_COOKIES}\
                 echo 'ERROR: Unsupported URL: https://example.com/x' >&2\n\
                 exit 1\n"
            ),
        );
        // Cookie-fails, then downloads one file into `--directory`.
        write_fake(
            bins.path(),
            "gallery-dl",
            &format!("{COOKIE_FAIL_WITH_COOKIES}{GALLERY_DL_WRITES_ONE_FILE}"),
        );

        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        let rec = Arc::new(RecordingSink::new());
        let req = request("https://example.com/x", out.path());

        let res = dispatch_with_policy(
            &resolver,
            rec.clone(),
            JobId::new(),
            &req,
            JobSignals::new(),
            &FAST_RETRIES,
            None,
        )
        .await;

        assert!(res.is_ok(), "gallery-dl should carry the job: {res:?}");
        assert_eq!(
            warning_codes(&rec),
            vec![WarningCode::CookieFallback],
            "both extractors cookie-failed; the user should hear it once"
        );
    }

    /// Regression: a transient failure sends `with_retry` around again,
    /// replaying the whole pipeline — including the cookie failure that
    /// opens every attempt. The warning still belongs to the job, not to
    /// the attempt.
    #[tokio::test]
    async fn cookie_warning_fires_once_across_transient_retries() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        // Cookie-fails, then hits a transient error the retry layer takes
        // as worth another attempt.
        write_fake(
            bins.path(),
            "yt-dlp",
            &format!(
                "{COOKIE_FAIL_WITH_COOKIES}\
                 echo 'ERROR: unable to download video data: Connection reset by peer' >&2\n\
                 exit 1\n"
            ),
        );
        // Never reached: a transient error is not a no-match, so dispatch
        // retries rather than falling back. Present so the resolver can't
        // silently pick up a real gallery-dl from $PATH.
        write_fake(
            bins.path(),
            "gallery-dl",
            "echo 'ERROR: Unsupported URL' >&2\nexit 1\n",
        );

        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        let rec = Arc::new(RecordingSink::new());
        let req = request("https://example.com/x", out.path());

        let err = dispatch_with_policy(
            &resolver,
            rec.clone(),
            JobId::new(),
            &req,
            JobSignals::new(),
            &FAST_RETRIES,
            None,
        )
        .await
        .expect_err("the fake yt-dlp always fails");

        // Check the error the replay is predicated on BEFORE counting the
        // replays: if the transient stderr never reached the retry layer,
        // `retries: 0` on its own says nothing about why.
        assert!(
            matches!(&err, GoopError::SubprocessFailed { stderr, .. }
                if stderr.contains("Connection reset by peer")),
            "the no-cookie attempt's transient stderr must reach the retry \
             layer for the replay to happen at all; got {err:?}"
        );
        let retries = rec
            .progress
            .lock()
            .iter()
            .filter(|p| p.stage.starts_with("retrying"))
            .count();
        assert_eq!(
            retries, 2,
            "policy allows 2 retries after the first attempt"
        );
        assert_eq!(
            warning_codes(&rec),
            vec![WarningCode::CookieFallback],
            "3 attempts each cookie-failed; the user should hear it once"
        );
    }

    /// The dedupe is scoped to one dispatch, not to the process: a job the
    /// user resumed or hit Retry on re-enters `dispatch` (see
    /// `goop_queue::scheduler::resume`, which re-queues paused downloads)
    /// and is entitled to say the cookie DB is still locked. Pinned
    /// because hoisting the wrapper up to the app-level sink would silence
    /// every warning after the first for a whole app run — and every other
    /// test here would still pass.
    #[tokio::test]
    async fn each_dispatch_warns_afresh_so_a_resumed_job_is_told_again() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        write_fake(
            bins.path(),
            "yt-dlp",
            &format!(
                "{COOKIE_FAIL_WITH_COOKIES}\
                 echo 'ERROR: Unsupported URL: https://example.com/x' >&2\n\
                 exit 1\n"
            ),
        );
        write_fake(
            bins.path(),
            "gallery-dl",
            &format!("{COOKIE_FAIL_WITH_COOKIES}{GALLERY_DL_WRITES_ONE_FILE}"),
        );

        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        // One sink across both dispatches — the app-level sink outlives any
        // single job, which is exactly why the wrapper must not.
        let rec = Arc::new(RecordingSink::new());
        let req = request("https://example.com/x", out.path());

        for _ in 0..2 {
            let res = dispatch_with_policy(
                &resolver,
                rec.clone(),
                JobId::new(),
                &req,
                JobSignals::new(),
                &FAST_RETRIES,
                None,
            )
            .await;
            assert!(res.is_ok(), "{res:?}");
        }

        assert_eq!(
            warning_codes(&rec),
            vec![WarningCode::CookieFallback, WarningCode::CookieFallback],
            "a second dispatch is a second user-initiated run: warn again"
        );
    }

    /// Regression for a stderr drain race, surfaced because these fakes
    /// exit far faster than real yt-dlp / gallery-dl (Python, slow to tear
    /// down). The extractors' output loop is `biased`, so it polls stdout
    /// before stderr; a child whose stdout was already at EOF made it
    /// `break` before stderr had been read even once, losing the message
    /// whole.
    ///
    /// Everything the wrappers decide is a substring test over that
    /// stderr, so dropping it silently disables ALL of: the cookie
    /// fallback, the cross-extractor fallback, the transient retry, and
    /// `friendly_message`. The children here close stdout up front and
    /// write stderr late, which forces the losing interleaving on every
    /// run rather than the ~4% the plain fakes hit.
    #[tokio::test]
    async fn stderr_is_read_even_when_the_child_closes_stdout_first() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        // `exec 1>&-` closes stdout before a byte of stderr exists, so the
        // stdout reader reports EOF on its very first poll.
        write_fake(
            bins.path(),
            "yt-dlp",
            &format!(
                "exec 1>&-\nsleep 0.2\n{COOKIE_FAIL_WITH_COOKIES}\
                 echo 'ERROR: Unsupported URL: https://example.com/x' >&2\n\
                 exit 1\n"
            ),
        );
        write_fake(
            bins.path(),
            "gallery-dl",
            &format!(
                "exec 1>&-\nsleep 0.2\n{COOKIE_FAIL_WITH_COOKIES}{GALLERY_DL_WRITES_ONE_FILE}"
            ),
        );

        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        let rec = Arc::new(RecordingSink::new());
        let req = request("https://example.com/x", out.path());

        let res = dispatch_with_policy(
            &resolver,
            rec.clone(),
            JobId::new(),
            &req,
            JobSignals::new(),
            &FAST_RETRIES,
            None,
        )
        .await;

        // Reaching gallery-dl at all proves yt-dlp's "Unsupported URL"
        // survived; the warning proves its cookie error did too.
        assert!(
            res.is_ok(),
            "stderr was dropped, so nothing fell back: {res:?}"
        );
        assert_eq!(warning_codes(&rec), vec![WarningCode::CookieFallback]);
    }

    /// Extractor stderr is not guaranteed UTF-8 — a mojibake title or a
    /// legacy Windows codepage puts undecodable bytes in the middle of an
    /// otherwise readable message. One bad line must not cost us the rest
    /// of it: every routing decision is a substring test over the whole
    /// stderr, so truncating at the first bad byte silently disables the
    /// fallbacks. Here the marker the dispatcher needs sits AFTER the bad
    /// line.
    ///
    /// Reads the verdict off WHICH binary failed rather than off a
    /// successful download: reaching gallery-dl at all is the proof, and
    /// that keeps the test clear of the filesystem entirely.
    #[tokio::test]
    async fn one_undecodable_stderr_line_does_not_swallow_the_rest() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        // A lone 0xff is not valid UTF-8 in any position.
        write_fake(
            bins.path(),
            "yt-dlp",
            "printf 'ERROR: bad title \\377\\n' >&2\n\
             echo 'ERROR: Unsupported URL: https://example.com/x' >&2\n\
             exit 1\n",
        );
        // Fails with a marker that is neither transient nor a no-match, so
        // it neither retries nor falls through to the direct downloader —
        // it just names itself in the error.
        write_fake(
            bins.path(),
            "gallery-dl",
            "echo 'ERROR: the fallback extractor ran' >&2\nexit 1\n",
        );

        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        let rec = Arc::new(RecordingSink::new());
        let mut req = request("https://example.com/x", out.path());
        // Isolate the decode path: no cookies, so nothing else can drive
        // the fallback.
        req.cookies_from_browser = None;

        let err = dispatch_with_policy(
            &resolver,
            rec.clone(),
            JobId::new(),
            &req,
            JobSignals::new(),
            &FAST_RETRIES,
            None,
        )
        .await
        .expect_err("the fake gallery-dl always fails");

        // Truncating at the bad line would leave yt-dlp's stderr without
        // "Unsupported URL", so dispatch would surface ITS error instead
        // of ever reaching gallery-dl.
        assert!(
            matches!(&err, GoopError::SubprocessFailed { stderr, .. }
                if stderr.contains("the fallback extractor ran")),
            "yt-dlp's 'Unsupported URL' came after the undecodable line and \
             must still drive the fallback; got {err:?}"
        );
    }

    // ---- update-and-retry-once ------------------------------------------

    /// Sets up a bins dir where yt-dlp fails the stale way and gallery-dl is
    /// a loud no-op, plus an output dir and a spawn counter for yt-dlp.
    fn stale_yt_dlp() -> (TempDir, TempDir, std::path::PathBuf) {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let counter = out.path().join("yt-dlp.runs");
        write_fake(bins.path(), "yt-dlp", &counting(&counter, STALE_FAILURE));
        // Present so the resolver can't pick a real gallery-dl off $PATH. A
        // stale failure is neither a no-match nor a block, so the
        // cross-extractor fallback never reaches it — if it ever runs, the
        // distinctive text says so.
        write_fake(
            bins.path(),
            "gallery-dl",
            "echo 'ERROR: the fallback extractor ran' >&2\nexit 1\n",
        );
        (bins, out, counter)
    }

    fn stale_request(out: &std::path::Path) -> ExtractRequest {
        let mut req = request("https://example.com/x", out);
        // No cookies: the no-cookie re-spawn is a different mechanism and
        // would double every spawn count below.
        req.cookies_from_browser = None;
        req
    }

    /// The whole point. yt-dlp fails in a way only a newer yt-dlp can fix,
    /// the hook installs one, and the second run carries the job — with no
    /// trace of the first failure, because there was nothing wrong with the
    /// request.
    #[tokio::test]
    async fn a_stale_failure_updates_yt_dlp_and_the_retry_carries_the_job() {
        let (bins, out, counter) = stale_yt_dlp();
        let bins_path = bins.path().to_path_buf();
        let success = yt_dlp_succeeds(out.path());
        let counter_for_hook = counter.clone();
        let (hook, calls) = hook_returning(Some(updated()), move || {
            replace_fake(
                &bins_path,
                "yt-dlp",
                &counting(&counter_for_hook, &success.clone()),
            );
        });

        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        let rec = Arc::new(RecordingSink::new());
        let req = stale_request(out.path());

        let res = dispatch_with_update_hook(
            &resolver,
            rec,
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
            Some(hook),
        )
        .await
        .expect("the updated yt-dlp succeeds");

        assert!(res.output_path.ends_with("video.mp4"), "{res:?}");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "one update check, not one per attempt"
        );
        assert_eq!(
            runs(&counter),
            2,
            "the original attempt and exactly one retry"
        );
    }

    /// A private video is a private video on every yt-dlp ever released.
    /// Asking GitHub about it on each such failure would be a request per
    /// job for nothing.
    #[tokio::test]
    async fn a_permanent_verdict_never_asks_for_an_update() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let counter = out.path().join("yt-dlp.runs");
        write_fake(
            bins.path(),
            "yt-dlp",
            &counting(
                &counter,
                "echo 'ERROR: [youtube] abc: Private video. Sign in if you have been granted access' >&2\nexit 1\n",
            ),
        );
        write_fake(
            bins.path(),
            "gallery-dl",
            "echo 'ERROR: the fallback extractor ran' >&2\nexit 1\n",
        );
        let (hook, calls) = hook_returning(Some(updated()), || {});

        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        let req = stale_request(out.path());
        let err = dispatch_with_update_hook(
            &resolver,
            Arc::new(RecordingSink::new()),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
            Some(hook),
        )
        .await
        .expect_err("a private video stays a failure");

        assert!(
            matches!(&err, GoopError::SubprocessFailed { stderr, .. } if stderr.contains("Private video")),
            "the user must still see the real verdict: {err:?}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0, "no update check");
        assert_eq!(runs(&counter), 1, "no second attempt");
    }

    /// "Checked, already current" is the common case once the binary is
    /// fresh. Nothing changed on disk, so a second run would spawn the same
    /// bytes against the same URL and fail identically — slower, and with a
    /// misleading claim of a retry attached.
    #[tokio::test]
    async fn no_update_means_no_second_attempt() {
        let (bins, out, counter) = stale_yt_dlp();
        let (hook, calls) = hook_returning(None, || {});

        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        let req = stale_request(out.path());
        let err = dispatch_with_update_hook(
            &resolver,
            Arc::new(RecordingSink::new()),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
            Some(hook),
        )
        .await
        .expect_err("the fake yt-dlp always fails");

        assert_eq!(calls.load(Ordering::SeqCst), 1, "the hook was asked");
        assert_eq!(
            runs(&counter),
            1,
            "but nothing changed, so nothing was retried"
        );
        let detail = err.detail().unwrap_or_default();
        assert!(
            !detail.contains("[goop]"),
            "no retry happened, so nothing should claim one: {detail}"
        );
    }

    /// The update landed and the job failed anyway. The failure is the
    /// user's to see, but so is the fact that Goop already tried the obvious
    /// fix — otherwise the advice "make sure yt-dlp is up to date" wastes
    /// their time. And it must stop there: one update, one retry, no loop.
    #[tokio::test]
    async fn a_second_stale_failure_is_marked_and_stops() {
        let (bins, out, counter) = stale_yt_dlp();
        let (hook, calls) = hook_returning(Some(updated()), || {});

        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        let req = stale_request(out.path());
        let err = dispatch_with_update_hook(
            &resolver,
            Arc::new(RecordingSink::new()),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
            Some(hook),
        )
        .await
        .expect_err("the fake yt-dlp always fails");

        assert_eq!(calls.load(Ordering::SeqCst), 1, "exactly one update check");
        assert_eq!(runs(&counter), 2, "exactly one retry — this must not loop");

        let detail = err
            .detail()
            .expect("a subprocess failure carries its stderr");
        assert!(
            detail.contains("Unable to extract player response"),
            "the original stderr must survive intact: {detail}"
        );
        assert!(
            detail
                .trim_end()
                .ends_with("[goop] yt-dlp auto-updated 2026.01.01 -> 2026.08.09; retried once"),
            "the note belongs after the tool's own words, not in front of \
             them: {detail}"
        );
    }

    /// Cancel means stop, not "stop after one more download and one more
    /// spawn". The signal is checked on both sides of the hook: before, so a
    /// job cancelled while failing never reaches for the network at all;
    /// after, because the update is itself a download the user can sit
    /// through and give up on.
    ///
    /// The assertion is on the error's identity, not on the spawn count.
    /// Dropping the post-hook check does NOT reliably change the count: the
    /// second dispatch spawns the child and the already-fired token kills it,
    /// usually before the shell reaches its first line — a race, and so
    /// useless as a guard. What does change is what the user is left with.
    /// Surfacing the real failure rather than manufacturing `Cancelled`
    /// follows `dispatch_once`, which makes the same call twice.
    #[tokio::test]
    async fn a_cancel_during_the_update_wins() {
        let (bins, out, counter) = stale_yt_dlp();
        let signals = JobSignals::new();
        let to_cancel = signals.clone();
        let (hook, calls) = hook_returning(Some(updated()), move || to_cancel.cancel.cancel());

        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        let req = stale_request(out.path());
        let err = dispatch_with_update_hook(
            &resolver,
            Arc::new(RecordingSink::new()),
            JobId::new(),
            &req,
            signals.clone(),
            None,
            Some(hook),
        )
        .await
        .expect_err("cancelled");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(
            matches!(&err, GoopError::SubprocessFailed { stderr, .. }
                if stderr.contains("Unable to extract player response")),
            "the cancel must pre-empt the retry, leaving the failure that \
             started all this — not a `Cancelled` from a doomed second \
             spawn; got {err:?}"
        );
        let detail = err.detail().unwrap_or_default();
        assert!(
            !detail.contains("[goop]"),
            "no retry happened, so nothing should claim one: {detail}"
        );
        let _ = counter;
    }

    /// The predicate refuses gallery-dl by name, but that only helps if the
    /// binary name reaching it is the one that actually failed. This drives
    /// the whole wiring: a gallery-dl-classified URL, gallery-dl failing
    /// with text that would look stale coming from yt-dlp, and no update
    /// check. Hardcoding `"yt-dlp"` in `stale_suspect` — or reading the
    /// wrong field — would make the yt-dlp updater run on gallery-dl's
    /// behalf, which it cannot help.
    #[tokio::test]
    async fn a_gallery_dl_failure_never_asks_for_a_yt_dlp_update() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        // Same stderr as the yt-dlp stale case, so only the binary differs.
        write_fake(
            bins.path(),
            "gallery-dl",
            "echo 'ERROR: [youtube] abc: Unable to extract player response' >&2\nexit 1\n",
        );
        // A stale failure is not a no-match, so the cross-extractor fallback
        // never reaches this. Present so nothing is picked off $PATH.
        write_fake(
            bins.path(),
            "yt-dlp",
            "echo 'ERROR: the fallback extractor ran' >&2\nexit 1\n",
        );
        let (hook, calls) = hook_returning(Some(updated()), || {});

        // imgur classifies to gallery-dl as primary.
        let mut req = request("https://imgur.com/gallery/abc", out.path());
        req.cookies_from_browser = None;

        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        let err = dispatch_with_update_hook(
            &resolver,
            Arc::new(RecordingSink::new()),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
            Some(hook),
        )
        .await
        .expect_err("the fake gallery-dl always fails");

        assert!(
            matches!(&err, GoopError::SubprocessFailed { binary, .. } if binary == "gallery-dl"),
            "the test is only meaningful if gallery-dl is what failed: {err:?}"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "updating yt-dlp cannot fix gallery-dl"
        );
    }

    /// Without a hook this is plain `dispatch`. Pinned so the wiring can be
    /// switched off (no coordinator, kill switch off) without changing what
    /// a failure looks like.
    #[tokio::test]
    async fn without_a_hook_it_is_just_dispatch() {
        let (bins, out, counter) = stale_yt_dlp();
        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        let req = stale_request(out.path());
        let err = dispatch_with_update_hook(
            &resolver,
            Arc::new(RecordingSink::new()),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
            None,
        )
        .await
        .expect_err("the fake yt-dlp always fails");
        assert_eq!(runs(&counter), 1);
        assert!(!err.detail().unwrap_or_default().contains("[goop]"));
    }
}
