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
use crate::recovery::ExtractRecovery;
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
    dispatch_with_recovery(
        resolver,
        sink,
        job_id,
        req,
        signals,
        debrid,
        hook,
        ExtractRecovery::ephemeral(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn dispatch_with_recovery(
    resolver: &BinaryResolver,
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
    debrid: Option<DebridCtx>,
    hook: Option<UpdateHook>,
    recovery: ExtractRecovery,
) -> Result<BackendOutcome, GoopError> {
    let err = match dispatch_policy_recovery(
        resolver,
        sink.clone(),
        job_id,
        req,
        signals.clone(),
        &DEFAULT_RETRY_POLICY,
        debrid.clone(),
        recovery.clone(),
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
    match dispatch_policy_recovery(
        resolver,
        sink,
        job_id,
        req,
        signals,
        &DEFAULT_RETRY_POLICY,
        debrid,
        recovery,
    )
    .await
    {
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
    dispatch_policy_recovery(
        resolver,
        sink,
        job_id,
        req,
        signals,
        policy,
        debrid,
        ExtractRecovery::ephemeral(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_policy_recovery(
    resolver: &BinaryResolver,
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
    policy: &RetryPolicy,
    debrid: Option<DebridCtx>,
    recovery: ExtractRecovery,
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
            recovery.clone(),
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
    recovery: ExtractRecovery,
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
    // The probe already found out which extractor answers for this URL;
    // `classify_extractor` only guesses from its shape. Using the verdict
    // skips a doomed spawn on every URL the classifier gets wrong. The
    // fallback below is untouched, so a stale or absent hint is exactly as
    // expensive as today.
    let hinted = req.extractor_hint.is_some();
    let primary = req
        .extractor_hint
        .unwrap_or_else(|| classify_extractor(&req.url));
    tracing::info!(?job_id, extractor = ?primary, hinted, "dispatch");
    let err = match run_one(
        resolver,
        sink.clone(),
        job_id,
        req,
        signals.clone(),
        primary,
        recovery.clone(),
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
        recovery,
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
    recovery: ExtractRecovery,
) -> Result<BackendOutcome, GoopError> {
    match backend {
        ExtractorChoice::YtDlp => {
            let yt = YtDlp::new(resolver, sink);
            let res = yt.download(job_id, req, signals, recovery).await?;
            Ok(BackendOutcome {
                output_path: res.output_path,
                bytes: res.bytes,
                duration_ms: res.duration_ms,
                result_kind: ResultKindTag::File,
                file_count: 1,
            })
        }
        ExtractorChoice::GalleryDl => {
            let gd = GalleryDl::new(resolver, sink.clone());
            let res = gd.download(job_id, req, signals).await?;
            // AFTER the download, not before it. "Saved in the original
            // quality" is a claim about a file that exists: emitted on entry
            // it also fires for an attempt that then fails (nothing was
            // saved), and for one that gallery-dl disowns so yt-dlp carries
            // the job — where the format choice WAS honoured and the warning
            // is simply false.
            //
            // Warn, don't refuse: gallery-dl is what makes these URLs work at
            // all, and the file is the one the user wanted — just not in the
            // size they picked. `WarnOnceSink` collapses repeats within a
            // dispatch.
            if req.format.is_some() || req.audio_only {
                sink.emit_sidecar(goop_core::SidecarEvent::Warning {
                    code: goop_core::WarningCode::FormatFallback,
                    message: "Saved in the original quality — the format choice \
                              applies only to video sites."
                        .into(),
                });
            }
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
/// sidecars and recent yt-dlp/gallery-dl `.part`/`.ytdl` files. Used when a
/// paused download is cancelled — pause keeps partials by contract, and the
/// worker that would normally clean up on cancel already returned.
pub fn cleanup_partials_for(req: &ExtractRequest) {
    let expanded = goop_core::path::expand(&req.output_dir);
    let output_dir = std::fs::canonicalize(&expanded).unwrap_or(expanded);
    crate::direct::remove_partials(&output_dir, &req.url);
    // Legacy yt-dlp metadata establishes no ownership; retain uncertain files.
    if req
        .extractor_hint
        .unwrap_or_else(|| classify_extractor(&req.url))
        == ExtractorChoice::GalleryDl
    {
        crate::gallery_dl::cleanup_run_artifacts(&output_dir);
    }
}

/// Cleanup a recovered yt-dlp job without invoking gallery's shared-root sweep.
/// Direct fallback partials retain their existing exact URL-keyed cleanup.
pub fn cleanup_partials_for_recovery(
    req: &ExtractRequest,
    id: JobId,
    checkpoint: &crate::recovery::RecoveryCheckpoint,
) -> Result<(), GoopError> {
    checkpoint.cleanup_for(id, req)?;
    crate::direct::remove_partials(&checkpoint.root, &req.url);
    Ok(())
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
    use crate::test_fakes::write_fake;
    use goop_core::events::RecordingSink;
    use goop_core::{SidecarEvent, WarningCode};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tempfile::TempDir;

    #[test]
    fn recovered_gallery_classified_job_does_not_sweep_shared_partials() {
        let out = TempDir::new().unwrap();
        let req = request("https://imgur.com/gallery/example", out.path());
        let id = JobId::new();
        let recovery = ExtractRecovery::ephemeral();
        let checkpoint = recovery.allocate(id, &req).unwrap();
        let unrelated = out.path().join("unrelated.part");
        std::fs::write(&unrelated, b"keep").unwrap();
        cleanup_partials_for_recovery(&req, id, &checkpoint).unwrap();
        assert_eq!(std::fs::read(unrelated).unwrap(), b"keep");
        assert!(!checkpoint.root.join(checkpoint.workspace).exists());
    }

    #[tokio::test]
    async fn failed_postprocess_never_exposes_public_output_or_cleans_unrelated_partials() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let unrelated = out.path().join("unrelated.mp4.part");
        std::fs::write(&unrelated, b"unrelated").unwrap();
        write_fake(
            bins.path(),
            "yt-dlp",
            r#"
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then dir=$(dirname "$a"); fi
  prev="$a"
done
printf 'broken' > "$dir/failed.mp4"
echo "__GOOP_FINAL__\"$dir/failed.mp4\""
echo 'ERROR: conversion failed' >&2
exit 1
"#,
        );
        let req: ExtractRequest = serde_json::from_value(serde_json::json!({
            "url":"https://youtube.com/watch?v=test", "output_dir":out.path(),
            "format":null,"audio_only":false
        }))
        .unwrap();
        let result = dispatch(
            &resolver_at(bins.path()),
            Arc::new(RecordingSink::default()),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
        )
        .await;
        assert!(result.is_err());
        assert!(
            !out.path().join("failed.mp4").exists(),
            "failed media must remain private"
        );
        cleanup_partials_for(&req);
        assert_eq!(std::fs::read(unrelated).unwrap(), b"unrelated");
    }

    #[tokio::test]
    async fn dispatch_reports_merging_and_cancels_after_pipe_eof() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let barrier = out.path().join("barrier");
        // Keep this pipe-EOF fixture to one leader. External touch or a
        // non-exec sleep can race cancellation before the shell reaps them;
        // descendant termination has its own writer and native ffmpeg tests.
        write_fake(bins.path(), "yt-dlp", &format!(
            "echo '__GOOP_PP__{{\"status\":\"started\",\"postprocessor\":\"Merger\"}}' >&2\nexec 1>&- 2>&-\n: > '{}'\nexec sleep 20\n", barrier.display()));
        let req: ExtractRequest = serde_json::from_value(serde_json::json!({
            "url":"https://youtube.com/watch?v=test", "output_dir":out.path(),
            "format":null,"audio_only":false
        }))
        .unwrap();
        let sink = Arc::new(RecordingSink::default());
        let signals = JobSignals::new();
        let resolver = resolver_at(bins.path());
        let future = dispatch(
            &resolver,
            sink.clone(),
            JobId::new(),
            &req,
            signals.clone(),
            None,
        );
        tokio::pin!(future);
        tokio::select! {
            result = &mut future => panic!("unexpected completion: {result:?}"),
            _ = async {
                tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        let merging = sink.progress.lock().iter().any(|p| {
                            p.stage == "merging" && p.eta_secs.is_none() && p.speed_hr.is_none()
                        });
                        if barrier.exists() && merging { break; }
                        tokio::task::yield_now().await;
                    }
                }).await.unwrap();
            } => {}
        }
        let merging = sink
            .progress
            .lock()
            .iter()
            .any(|p| p.stage == "merging" && p.eta_secs.is_none() && p.speed_hr.is_none());
        signals.cancel.cancel();
        let stopped = tokio::time::timeout(Duration::from_secs(3), &mut future).await;
        assert!(stopped.is_ok(), "cancel must interrupt wait after pipe EOF");
        let stopped = stopped.unwrap();
        assert!(matches!(stopped, Err(GoopError::Cancelled)), "{stopped:?}");
        assert!(
            merging,
            "observed postprocessor must report indeterminate merging"
        );
    }

    #[tokio::test]
    #[ignore = "requires explicit local native fixture and bundled binary directories"]
    async fn native_completed_source_replay_validates_real_postprocessors() {
        use crate::recovery::{ExtractRecovery, RECOVERY_PAYLOAD_KEY};
        use goop_core::{Job, JobKind};
        use goop_queue::QueueStore;
        let fixture_root = std::path::PathBuf::from(
            std::env::var_os("GOOP_EXTRACT_NATIVE_FIXTURES").expect("fixture directory"),
        );
        let binary_root = std::path::PathBuf::from(
            std::env::var_os("GOOP_EXTRACT_NATIVE_BIN_DIR").expect("binary directory"),
        );
        let resolver = BinaryResolver::new(binary_root);
        for mode in ["muxed", "split", "audio"] {
            let out = TempDir::new().unwrap();
            let database = TempDir::new().unwrap();
            let fixture = fixture_root.join(mode);
            let info: serde_json::Value =
                serde_json::from_slice(&std::fs::read(fixture.join("sanitized.json")).unwrap())
                    .unwrap();
            let mut req = request("https://example.invalid/offline-recovery", out.path());
            req.cookies_from_browser = None;
            req.audio_only = mode == "audio";
            req.format = Some(
                if mode == "split" {
                    "v+a"
                } else if mode == "audio" {
                    "a"
                } else {
                    "m"
                }
                .into(),
            );
            // The fixture records the actual muxed format id.
            if mode == "muxed" {
                req.format = Some(info["formats"][0]["format_id"].as_str().unwrap().into());
            }
            let job = Job::new(JobKind::Extract, serde_json::to_value(&req).unwrap());
            let db = database.path().join("queue.db");
            let store = QueueStore::open(&db).unwrap();
            store.insert(&job).unwrap();
            let id = job.id;
            let callback = |store: QueueStore| -> crate::recovery::PersistRecovery {
                Arc::new(move |cp| {
                    store.patch_payload_field(
                        id,
                        RECOVERY_PAYLOAD_KEY,
                        serde_json::to_value(cp).unwrap(),
                    )
                })
            };
            let recovery = ExtractRecovery::new(None, callback(store.clone())).unwrap();
            let cp = recovery.allocate(id, &req).unwrap();
            let dir = cp.owned_directory().unwrap();
            let formats = info["formats"].as_array().unwrap();
            let mut raw =
                serde_json::json!({"title":format!("native-{mode}"), "extractor":"generic"});
            let mut selected = Vec::new();
            let mut merge = Vec::new();
            for format in formats {
                let id = format["format_id"].as_str().unwrap();
                let ext = format["ext"].as_str().unwrap();
                let original = if mode == "split" {
                    format!("fixture-split.f{id}.{ext}")
                } else {
                    format!("fixture-{mode}.{ext}")
                };
                let local = if mode == "split" {
                    format!("source.f{id}.{ext}")
                } else {
                    format!("source.{ext}")
                };
                std::fs::copy(fixture.join(original), dir.join(&local)).unwrap();
                let mut selected_format = format.clone();
                selected_format["filepath"] = serde_json::json!(dir.join(local));
                merge.push(selected_format["filepath"].clone());
                selected.push(selected_format);
            }
            if mode == "split" {
                raw["requested_formats"] = serde_json::json!(selected);
                raw["__files_to_merge"] = serde_json::json!(merge);
            } else {
                for (key, value) in selected[0].as_object().unwrap() {
                    raw[key] = value.clone();
                }
            }
            recovery.capture(raw, JobSignals::new()).await.unwrap();
            let saved = recovery.checkpoint().unwrap();
            drop(recovery);
            drop(store);
            let store = QueueStore::open(&db).unwrap();
            let row = store.get_by_id(job.id).unwrap().unwrap();
            let recovery = ExtractRecovery::new(
                row.payload.get(RECOVERY_PAYLOAD_KEY).cloned(),
                callback(store),
            )
            .unwrap();
            let sink = Arc::new(RecordingSink::default());
            let result = dispatch_with_recovery(
                &resolver,
                sink.clone(),
                job.id,
                &req,
                JobSignals::new(),
                None,
                None,
                recovery,
            )
            .await
            .unwrap_or_else(|e| panic!("{mode}: {e:?}"));
            saved.validate_sources(&JobSignals::new()).unwrap();
            let decode = tokio::process::Command::new(resolver.resolve("ffmpeg").unwrap().path)
                .args(["-v", "error", "-i"])
                .arg(&result.output_path)
                .args(["-f", "null", "-"])
                .output()
                .await
                .unwrap();
            assert!(
                decode.status.success(),
                "{mode}: {}",
                String::from_utf8_lossy(&decode.stderr)
            );
            let stages: Vec<_> = sink
                .progress
                .lock()
                .iter()
                .map(|e| e.stage.clone())
                .collect();
            assert!(stages.iter().any(|s| s == "validating"));
            if mode == "split" {
                assert!(stages.iter().any(|s| s == "merging"));
            }
            if mode == "audio" {
                assert!(stages.iter().any(|s| s == "converting"));
            }
            if mode == "muxed" {
                let offline = ExtractRecovery::new(
                    Some(serde_json::to_value(&saved).unwrap()),
                    Arc::new(|_| Ok(())),
                )
                .unwrap();
                let replay = offline.replay(JobSignals::new()).await.unwrap().unwrap();
                std::fs::remove_file(saved.file(&saved.sources[0].relative_path).unwrap()).unwrap();
                let command =
                    tokio::process::Command::new(resolver.resolve("yt-dlp").unwrap().path)
                        .args([
                            "--ignore-config",
                            "--proxy",
                            "",
                            "--socket-timeout",
                            "1",
                            "--retries",
                            "0",
                            "--no-simulate",
                            "--load-info-json",
                        ])
                        .arg(replay)
                        .arg("-o")
                        .arg(saved.root.join(&saved.workspace).join("source.%(ext)s"))
                        .env("HTTP_PROXY", "http://127.0.0.1:1")
                        .env("HTTPS_PROXY", "http://127.0.0.1:1")
                        .kill_on_drop(true)
                        .output();
                let output = tokio::time::timeout(Duration::from_secs(5), command)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(
                    !output.status.success(),
                    "missing input must fail against inert URL"
                );
                assert!(!saved
                    .root
                    .join(&saved.workspace)
                    .join(&saved.sources[0].relative_path)
                    .exists());
                eprintln!("NATIVE INERT URL: missing source rejected within 5s, proxy explicitly disabled");
            }
            eprintln!("NATIVE REPLAY {mode}: {} bytes; source hashes unchanged; full decode passed; stages {stages:?}", result.bytes);
        }
    }

    #[tokio::test]
    #[ignore = "requires explicit local native fixture and bundled binary directories"]
    async fn native_failure_reopen_retry_performs_no_additional_media_requests() {
        use crate::recovery::{ExtractRecovery, RECOVERY_PAYLOAD_KEY};
        use goop_core::{Job, JobKind};
        use goop_queue::QueueStore;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let fixtures = std::path::PathBuf::from(
            std::env::var_os("GOOP_EXTRACT_NATIVE_FIXTURES").expect("fixture directory"),
        );
        let native = std::path::PathBuf::from(
            std::env::var_os("GOOP_EXTRACT_NATIVE_BIN_DIR").expect("binary directory"),
        );
        let media = std::fs::read(fixtures.join("muxed/fixture-muxed.mp4")).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let gets = Arc::new(AtomicUsize::new(0));
        let requests = gets.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = vec![0; 8192];
                let n = socket.read(&mut bytes).await.unwrap();
                let request = String::from_utf8_lossy(&bytes[..n]);
                let head = request.starts_with("HEAD ");
                if request.starts_with("GET ") {
                    requests.fetch_add(1, Ordering::SeqCst);
                }
                let header = format!("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", media.len());
                if socket.write_all(header.as_bytes()).await.is_ok() && !head {
                    let _ = socket.write_all(&media).await;
                }
                let _ = socket.shutdown().await;
            }
        });
        struct ServerGuard(tokio::task::JoinHandle<()>);
        impl Drop for ServerGuard {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let _server = ServerGuard(server);
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let database = TempDir::new().unwrap();
        for name in ["yt-dlp", "ffprobe"] {
            std::os::unix::fs::symlink(
                std::fs::canonicalize(native.join(name)).unwrap(),
                bins.path().join(name),
            )
            .unwrap();
        }
        let failed = database.path().join("processing-failed-once");
        let real_ffmpeg = std::fs::canonicalize(native.join("ffmpeg")).unwrap();
        write_fake(
            bins.path(),
            "ffmpeg",
            &format!(
                r#"
processing=""
for a in "$@"; do if [ "$a" = "-i" ]; then processing=yes; fi; done
if [ "$processing" = yes ] && [ ! -f '{}' ]; then
  touch '{}'
  echo 'intentional fixture conversion failure' >&2
  exit 1
fi
exec '{}' "$@"
"#,
                failed.display(),
                failed.display(),
                real_ffmpeg.display()
            ),
        );
        let resolver = BinaryResolver::new(bins.path().to_owned());
        let mut req = request(&format!("http://{address}/fixture.mp4"), out.path());
        req.cookies_from_browser = None;
        req.audio_only = true;
        req.extractor_hint = Some(ExtractorChoice::YtDlp);
        let job = Job::new(JobKind::Extract, serde_json::to_value(&req).unwrap());
        let id = job.id;
        let db = database.path().join("queue.db");
        let store = QueueStore::open(&db).unwrap();
        store.insert(&job).unwrap();
        store.claim_queued(id, 1).unwrap();
        let callback = |store: QueueStore| -> crate::recovery::PersistRecovery {
            Arc::new(move |cp| {
                store.patch_payload_field(
                    id,
                    RECOVERY_PAYLOAD_KEY,
                    serde_json::to_value(cp).unwrap(),
                )
            })
        };
        let recovery = ExtractRecovery::new(None, callback(store.clone())).unwrap();
        let first = tokio::time::timeout(
            Duration::from_secs(20),
            dispatch_with_recovery(
                &resolver,
                Arc::new(RecordingSink::default()),
                id,
                &req,
                JobSignals::new(),
                None,
                None,
                recovery.clone(),
            ),
        )
        .await
        .unwrap();
        assert!(first.is_err(), "first processing must fail");
        assert!(
            failed.exists(),
            "actual FFmpeg conversion was invoked: {first:?}"
        );
        let checkpoint = recovery.checkpoint().unwrap();
        assert_eq!(
            checkpoint.sources.len(),
            1,
            "real acquisition must persist its completed source: {first:?}"
        );
        assert!(!checkpoint.writer_active);
        let before = gets.load(Ordering::SeqCst);
        assert!(before > 0);
        drop(recovery);
        drop(store);
        let store = QueueStore::open(&db).unwrap();
        store.reconcile().unwrap();
        store.retry_errored(id).unwrap();
        let payload = store.get_by_id(id).unwrap().unwrap().payload;
        let recovery =
            ExtractRecovery::new(payload.get(RECOVERY_PAYLOAD_KEY).cloned(), callback(store))
                .unwrap();
        let sink = Arc::new(RecordingSink::default());
        let result = tokio::time::timeout(
            Duration::from_secs(20),
            dispatch_with_recovery(
                &resolver,
                sink.clone(),
                id,
                &req,
                JobSignals::new(),
                None,
                None,
                recovery,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            gets.load(Ordering::SeqCst),
            before,
            "retry must not perform another media GET"
        );
        checkpoint.validate_sources(&JobSignals::new()).unwrap();
        let decode = tokio::process::Command::new(&real_ffmpeg)
            .args(["-v", "error", "-i"])
            .arg(&result.output_path)
            .args(["-f", "null", "-"])
            .output()
            .await
            .unwrap();
        assert!(
            decode.status.success(),
            "{}",
            String::from_utf8_lossy(&decode.stderr)
        );
        assert!(sink
            .progress
            .lock()
            .iter()
            .any(|event| event.stage == "converting"));
        eprintln!("NATIVE FAILURE RECOVERY: initial media GETs={before}; retry GETs=0; {} bytes; real source checkpoint/store reopen/reconcile/retry; unchanged source hash; full decode passed", result.bytes);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires explicit local native fixture and bundled binary directories"]
    async fn native_ffmpeg_cancel_and_pause_stop_real_descendants() {
        let fixtures = std::path::PathBuf::from(
            std::env::var_os("GOOP_EXTRACT_NATIVE_FIXTURES").expect("fixture directory"),
        );
        let native = std::path::PathBuf::from(
            std::env::var_os("GOOP_EXTRACT_NATIVE_BIN_DIR").expect("binary directory"),
        );
        for pause in [false, true] {
            let bins = TempDir::new().unwrap();
            let out = TempDir::new().unwrap();
            let witness = TempDir::new().unwrap();
            let pidfile = witness.path().join("ffmpeg-pid");
            for name in ["yt-dlp", "ffprobe"] {
                std::os::unix::fs::symlink(
                    std::fs::canonicalize(native.join(name)).unwrap(),
                    bins.path().join(name),
                )
                .unwrap();
            }
            let real = std::fs::canonicalize(native.join("ffmpeg")).unwrap();
            write_fake(
                bins.path(),
                "ffmpeg",
                &format!(
                    r#"
for a in "$@"; do
  if [ "$a" = "-i" ]; then
    echo $$ > '{}'
    exec '{}' -re "$@"
  fi
done
exec '{}' "$@"
"#,
                    pidfile.display(),
                    real.display(),
                    real.display()
                ),
            );
            let resolver = BinaryResolver::new(bins.path().to_owned());
            let mut req = request("https://example.invalid/completed", out.path());
            req.audio_only = true;
            req.format = Some("a".into());
            req.cookies_from_browser = None;
            let id = JobId::new();
            let recovery = ExtractRecovery::ephemeral();
            let cp = recovery.allocate(id, &req).unwrap();
            let dir = cp.owned_directory().unwrap();
            let source = dir.join("source.m4a");
            std::fs::copy(fixtures.join("audio/fixture-audio.m4a"), &source).unwrap();
            recovery.capture(serde_json::json!({"title":"native-audio","format_id":"a","ext":"m4a","vcodec":"none","acodec":"aac","filepath":source}), JobSignals::new()).await.unwrap();
            let signals = JobSignals::new();
            let future = dispatch_with_recovery(
                &resolver,
                Arc::new(RecordingSink::default()),
                id,
                &req,
                signals.clone(),
                None,
                None,
                recovery.clone(),
            );
            tokio::pin!(future);
            let pid = tokio::select! {
                result = &mut future => panic!("processor finished before native cancellation witness: {result:?}"),
                pid = async {
                    tokio::time::timeout(Duration::from_secs(10), async {
                        loop {
                            if let Ok(pid) = std::fs::read_to_string(&pidfile) {
                                let process = tokio::process::Command::new("/bin/ps").args(["-p", pid.trim(), "-o", "comm="]).output().await.unwrap();
                                if String::from_utf8_lossy(&process.stdout).contains("ffmpeg-aarch64") { break pid.trim().parse::<i32>().unwrap(); }
                            }
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                    }).await.unwrap()
                } => pid,
            };
            if pause {
                signals.pause.cancel();
            } else {
                signals.cancel.cancel();
            }
            let result = tokio::time::timeout(Duration::from_secs(3), &mut future)
                .await
                .unwrap();
            assert!(
                if pause {
                    matches!(result, Err(GoopError::Paused))
                } else {
                    matches!(result, Err(GoopError::Cancelled))
                },
                "{result:?}"
            );
            // SAFETY: signal zero only observes the witnessed, nonpersisted PID.
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                -1,
                "real ffmpeg must be gone"
            );
            assert!(!out.path().join("native-audio.mp3").exists());
            if pause {
                recovery
                    .checkpoint()
                    .unwrap()
                    .validate_sources(&JobSignals::new())
                    .unwrap();
                let result = dispatch_with_recovery(
                    &resolver,
                    Arc::new(RecordingSink::default()),
                    id,
                    &req,
                    JobSignals::new(),
                    None,
                    None,
                    recovery.clone(),
                )
                .await
                .unwrap();
                assert!(std::path::Path::new(&result.output_path).is_file());
            } else {
                assert!(!dir.exists());
            }
            eprintln!("NATIVE FFMPEG {}: observed real descendant PID {pid}, tree stopped, no early public output{}", if pause { "PAUSE" } else { "CANCEL" }, if pause { "; fresh-signal resume reused source and succeeded" } else { "; exact workspace removed" });
        }
    }

    fn recovery_fake(counter: &std::path::Path) -> String {
        format!(
            r#"
prev=""
replay=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then dir=$(dirname "$a"); fi
  if [ "$a" = "--load-info-json" ]; then replay=yes; fi
  prev="$a"
done
if [ -z "$replay" ]; then
  echo acquisition >> '{counter}'
  printf 'completed original' > "$dir/source.mp4"
fi
echo processing >> '{counter}'
printf '__GOOP_SOURCE__{{"title":"video","format_id":"18","ext":"mp4","vcodec":"h264","acodec":"aac","filepath":"%s/source.mp4"}}\n' "$dir"
echo '__GOOP_PP__{{"status":"started","postprocessor":"Merger"}}' >&2
if [ -z "$replay" ]; then
  echo 'ERROR: conversion failed' >&2
  exit 1
fi
printf '__GOOP_FINAL__"%s/source.mp4"\n' "$dir"
exit 0
"#,
            counter = counter.display()
        )
    }

    #[tokio::test]
    async fn reopened_store_retry_reuses_completed_sources() {
        use crate::recovery::{ExtractRecovery, RECOVERY_PAYLOAD_KEY};
        use goop_core::{Job, JobKind, JobState};
        use goop_queue::QueueStore;
        for paused in [false, true] {
            let bins = TempDir::new().unwrap();
            let out = TempDir::new().unwrap();
            let database = TempDir::new().unwrap();
            let counter = out.path().join("counter");
            write_fake(bins.path(), "yt-dlp", &recovery_fake(&counter));
            let resolver = Arc::new(resolver_at(bins.path()));
            let req = request("https://youtube.com/watch?v=test", out.path());
            let job = Job::new(JobKind::Extract, serde_json::to_value(&req).unwrap());
            let db = database.path().join("queue.db");
            let store = QueueStore::open(&db).unwrap();
            store.insert(&job).unwrap();
            store.claim_queued(job.id, 1).unwrap();
            let callback = |store: QueueStore| -> crate::recovery::PersistRecovery {
                let id = job.id;
                Arc::new(move |checkpoint| {
                    store.patch_payload_field(
                        id,
                        RECOVERY_PAYLOAD_KEY,
                        serde_json::to_value(checkpoint).unwrap(),
                    )
                })
            };
            let recovery = ExtractRecovery::new(None, callback(store.clone())).unwrap();
            let first = dispatch_with_recovery(
                &resolver,
                Arc::new(RecordingSink::default()),
                job.id,
                &req,
                JobSignals::new(),
                None,
                None,
                recovery.clone(),
            )
            .await;
            assert!(first.is_err());
            let checkpoint = recovery.checkpoint().unwrap();
            assert!(!checkpoint.writer_active);
            assert_eq!(checkpoint.sources.len(), 1);
            let source = checkpoint
                .file(&checkpoint.sources[0].relative_path)
                .unwrap();
            let original = std::fs::read(&source).unwrap();
            let root = checkpoint.root.clone();
            let workspace = checkpoint.workspace.clone();
            drop(recovery);
            if paused {
                store
                    .update_state(job.id, &JobState::Paused, None, 2)
                    .unwrap();
            }
            drop(store);
            let store = QueueStore::open(&db).unwrap();
            store.reconcile().unwrap();
            if paused {
                assert_eq!(
                    store.get_by_id(job.id).unwrap().unwrap().state,
                    JobState::Paused
                );
                store.requeue_paused(job.id).unwrap();
            } else {
                assert!(matches!(
                    store.get_by_id(job.id).unwrap().unwrap().state,
                    JobState::Error { .. }
                ));
                store.retry_errored(job.id).unwrap();
            }
            let row = store.get_by_id(job.id).unwrap().unwrap();
            assert_eq!(row.payload["url"], req.url);
            let worker_store = store.clone();
            let worker: goop_queue::WorkerFn = Arc::new(move |id, payload, signals| {
                let store = worker_store.clone();
                let resolver = resolver.clone();
                Box::pin(async move {
                    let callback_store = store.clone();
                    let recovery = ExtractRecovery::new(
                        payload.get(RECOVERY_PAYLOAD_KEY).cloned(),
                        Arc::new(move |cp| {
                            callback_store.patch_payload_field(
                                id,
                                RECOVERY_PAYLOAD_KEY,
                                serde_json::to_value(cp)?,
                            )
                        }),
                    )?;
                    let req = serde_json::from_value(payload)?;
                    let out = dispatch_with_recovery(
                        &resolver,
                        Arc::new(RecordingSink::default()),
                        id,
                        &req,
                        signals,
                        None,
                        None,
                        recovery,
                    )
                    .await?;
                    assert!(
                        std::path::Path::new(&out.output_path).is_file(),
                        "worker success requires public output"
                    );
                    Ok(goop_core::JobResult {
                        output_path: Some(out.output_path),
                        bytes: Some(out.bytes),
                        duration_ms: out.duration_ms,
                        result_kind: goop_core::ResultKind::File,
                        file_count: 1,
                        source_bytes: None,
                        target_bytes: None,
                        reencoded: None,
                    })
                })
            });
            let scheduler = goop_queue::Scheduler::new(
                store.clone(),
                Arc::new(RecordingSink::default()),
                1,
                1,
                1,
                1,
                1,
                worker.clone(),
                worker.clone(),
                worker.clone(),
                worker.clone(),
                worker,
            );
            let runner = tokio::spawn(scheduler.run_kind(JobKind::Extract));
            let row = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let row = store.get_by_id(job.id).unwrap().unwrap();
                    if row.is_terminal() {
                        break row;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            runner.abort();
            assert_eq!(row.state, JobState::Done, "{:?}", row.state);
            let restored: crate::recovery::RecoveryCheckpoint =
                serde_json::from_value(row.payload[RECOVERY_PAYLOAD_KEY].clone()).unwrap();
            assert_eq!(restored.root, root);
            assert_eq!(restored.workspace, workspace);
            let result = row.result.unwrap();
            let output_path = result.output_path.unwrap();
            assert_eq!(std::fs::read(source).unwrap(), original);
            assert_eq!(std::fs::read(&output_path).unwrap(), original);
            let calls = std::fs::read_to_string(counter).unwrap();
            assert_eq!(
                calls.lines().filter(|line| *line == "acquisition").count(),
                1
            );
            assert_eq!(
                calls.lines().filter(|line| *line == "processing").count(),
                2
            );
            assert!(output_path.ends_with("video.mp4"));
        }
    }

    #[tokio::test]
    async fn reopened_title_cannot_escape_public_output_root() {
        let bins = TempDir::new().unwrap();
        let outer = TempDir::new().unwrap();
        let out = outer.path().join("outputs");
        std::fs::create_dir(&out).unwrap();
        let counter = outer.path().join("counter");
        write_fake(bins.path(), "yt-dlp", &recovery_fake(&counter));
        let resolver = resolver_at(bins.path());
        let req = request("https://youtube.com/watch?v=test", &out);
        let id = JobId::new();
        let recovery = ExtractRecovery::ephemeral();
        assert!(dispatch_with_recovery(
            &resolver,
            Arc::new(RecordingSink::default()),
            id,
            &req,
            JobSignals::new(),
            None,
            None,
            recovery.clone()
        )
        .await
        .is_err());
        for field in ["title", "extractor", "upload_date"] {
            let mut checkpoint = serde_json::to_value(recovery.checkpoint().unwrap()).unwrap();
            checkpoint[field] = serde_json::json!("../escaped");
            let recovery = ExtractRecovery::new(Some(checkpoint), Arc::new(|_| Ok(()))).unwrap();
            let result = dispatch_with_recovery(
                &resolver,
                Arc::new(RecordingSink::default()),
                id,
                &req,
                JobSignals::new(),
                None,
                None,
                recovery,
            )
            .await;
            assert!(result.is_err(), "tampered public filename must fail closed");
            assert!(!outer.path().join("escaped.mp4").exists());
        }
    }

    #[tokio::test]
    async fn recovery_rejects_changed_sources_and_metadata_before_spawn() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let counter = out.path().join("counter");
        write_fake(bins.path(), "yt-dlp", &recovery_fake(&counter));
        let resolver = resolver_at(bins.path());
        let req = request("https://youtube.com/watch?v=test", out.path());
        let id = JobId::new();
        let recovery = ExtractRecovery::ephemeral();
        assert!(dispatch_with_recovery(
            &resolver,
            Arc::new(RecordingSink::default()),
            id,
            &req,
            JobSignals::new(),
            None,
            None,
            recovery.clone()
        )
        .await
        .is_err());
        let cp = recovery.checkpoint().unwrap();
        let source = cp.file(&cp.sources[0].relative_path).unwrap();
        let before = std::fs::read_to_string(&counter).unwrap();
        for case in [
            "schema",
            "job",
            "root",
            "workspace",
            "absolute",
            "traversal",
            "format",
            "empty",
            "truncated",
            "mutated",
            "missing",
            "symlink",
            "selector",
            "audio",
            "url",
        ] {
            let mut raw = serde_json::to_value(&cp).unwrap();
            let mut request = req.clone();
            std::fs::write(&source, b"completed original").unwrap();
            match case {
                "schema" => raw["version"] = serde_json::json!(99),
                "job" => raw["job_id"] = serde_json::to_value(JobId::new()).unwrap(),
                "root" => raw["root"] = serde_json::json!("/"),
                "workspace" => raw["workspace"] = serde_json::json!("../other"),
                "absolute" => raw["sources"][0]["relative_path"] = serde_json::json!(source),
                "traversal" => {
                    raw["sources"][0]["relative_path"] = serde_json::json!("../source.mp4")
                }
                "format" => raw["sources"][0]["format_id"] = serde_json::json!("different"),
                "empty" => std::fs::write(&source, []).unwrap(),
                "truncated" => std::fs::write(&source, b"short").unwrap(),
                "mutated" => std::fs::write(&source, b"completed mutated!").unwrap(),
                "missing" => std::fs::remove_file(&source).unwrap(),
                "symlink" => {
                    std::fs::remove_file(&source).unwrap();
                    std::os::unix::fs::symlink(&counter, &source).unwrap();
                }
                "selector" => request.format = Some("other".into()),
                "audio" => request.audio_only = true,
                "url" => request.url.push('x'),
                _ => unreachable!(),
            }
            let recovery = ExtractRecovery::new(Some(raw), Arc::new(|_| Ok(()))).unwrap();
            let result = dispatch_with_recovery(
                &resolver,
                Arc::new(RecordingSink::default()),
                id,
                &request,
                JobSignals::new(),
                None,
                None,
                recovery,
            )
            .await;
            assert!(result.is_err(), "{case}: {result:?}");
            assert_eq!(
                std::fs::read_to_string(&counter).unwrap(),
                before,
                "{case} spawned a sidecar"
            );
            if std::fs::symlink_metadata(&source).is_ok() {
                std::fs::remove_file(&source).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn active_crash_checkpoint_is_quarantined_without_reusing_or_deleting_sources() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let resolver = resolver_at(bins.path());
        write_fake(bins.path(), "yt-dlp", &yt_dlp_succeeds(out.path()));
        let req = request("https://youtube.com/watch?v=test", out.path());
        let id = JobId::new();
        let old = ExtractRecovery::ephemeral();
        let cp = old.allocate(id, &req).unwrap();
        let old_dir = cp.owned_directory().unwrap();
        std::fs::write(old_dir.join("source.mp4"), b"uncertain old writer").unwrap();
        old.set_writer(true).unwrap();
        let resumed = ExtractRecovery::new(
            Some(serde_json::to_value(old.checkpoint()).unwrap()),
            Arc::new(|_| Ok(())),
        )
        .unwrap();
        let result = dispatch_with_recovery(
            &resolver,
            Arc::new(RecordingSink::default()),
            id,
            &req,
            JobSignals::new(),
            None,
            None,
            resumed.clone(),
        )
        .await
        .unwrap();
        assert_ne!(resumed.checkpoint().unwrap().workspace, cp.workspace);
        assert_eq!(
            std::fs::read(old_dir.join("source.mp4")).unwrap(),
            b"uncertain old writer"
        );
        assert_eq!(std::fs::read(result.output_path).unwrap(), b"x");
        assert!(old.cleanup().is_err());
    }

    #[tokio::test]
    async fn completed_cleanup_rejects_uncertain_or_forged_rows_and_preserves_neighbors() {
        use crate::recovery::{cleanup_completed_recovery, RecoveryPhase, RECOVERY_PAYLOAD_KEY};
        use goop_core::{Job, JobKind, JobState, ResultKind};
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let resolver = resolver_at(bins.path());
        write_fake(bins.path(), "yt-dlp", &yt_dlp_succeeds(out.path()));
        let req = request("https://youtube.com/watch?v=test", out.path());
        let mut job = Job::new(JobKind::Extract, serde_json::to_value(&req).unwrap());
        let recovery = ExtractRecovery::ephemeral();
        let result = dispatch_with_recovery(
            &resolver,
            Arc::new(RecordingSink::default()),
            job.id,
            &req,
            JobSignals::new(),
            None,
            None,
            recovery.clone(),
        )
        .await
        .unwrap();
        let cp = recovery.checkpoint().unwrap();
        let directory = cp.root.join(&cp.workspace);
        job.state = JobState::Done;
        job.payload[RECOVERY_PAYLOAD_KEY] = serde_json::to_value(&cp).unwrap();
        job.result = Some(goop_core::JobResult {
            output_path: Some(result.output_path.clone()),
            bytes: Some(result.bytes),
            duration_ms: 0,
            result_kind: ResultKind::File,
            file_count: 1,
            source_bytes: None,
            target_bytes: None,
            reencoded: None,
        });
        for state in [
            JobState::Paused,
            JobState::Queued,
            JobState::Running,
            JobState::Error {
                message: "failed".into(),
                detail: None,
            },
        ] {
            let mut row = job.clone();
            row.state = state;
            cleanup_completed_recovery(&row).unwrap();
            assert!(directory.exists());
        }
        let mut non_extract = job.clone();
        non_extract.kind = JobKind::Convert;
        cleanup_completed_recovery(&non_extract).unwrap();
        assert!(directory.exists());
        for field in [
            "writer",
            "receipt",
            "job",
            "root",
            "fingerprint",
            "workspace",
            "output",
            "result",
            "schema",
        ] {
            let mut row = job.clone();
            let mut forged = cp.clone();
            match field {
                "writer" => forged.writer_active = true,
                "receipt" => forged.phase = RecoveryPhase::OutputVerified,
                "job" => forged.job_id = JobId::new(),
                "root" => forged.root = bins.path().to_path_buf(),
                "fingerprint" => forged.fingerprint = "wrong".into(),
                "workspace" => forged.workspace = "../unrelated".into(),
                "output" => forged.published_path = Some(directory.join("source.mp4")),
                "result" => {
                    row.result.as_mut().unwrap().output_path = Some("/unrelated.mp4".into())
                }
                "schema" => forged.version = 99,
                _ => unreachable!(),
            }
            row.payload[RECOVERY_PAYLOAD_KEY] = serde_json::to_value(forged).unwrap();
            assert!(
                cleanup_completed_recovery(&row).is_err(),
                "accepted forged {field}"
            );
            assert!(directory.exists());
        }
        let sibling = cp.root.join(".goop-extract-unrelated");
        std::fs::create_dir(&sibling).unwrap();
        std::fs::write(sibling.join("keep"), b"sibling").unwrap();
        let unrelated = cp.root.join("unrelated.part");
        std::fs::write(&unrelated, b"keep").unwrap();
        std::os::unix::fs::symlink(&unrelated, directory.join("linked-artifact")).unwrap();
        let held = cp.root.join("held-workspace");
        std::fs::rename(&directory, &held).unwrap();
        std::os::unix::fs::symlink(&held, &directory).unwrap();
        assert!(cleanup_completed_recovery(&job).is_err());
        std::fs::remove_file(&directory).unwrap();
        std::fs::rename(&held, &directory).unwrap();
        // Simulate interruption at an unlink boundary. Ownership must outlive
        // every private media entry so the durable row can retry cleanup.
        let mut entries: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        // Directory enumeration order is unspecified; exercise marker-first.
        entries.sort_by_key(|path| match path.file_name().unwrap().to_str().unwrap() {
            "owner.json" => 0,
            "source.mp4" => 2,
            _ => 1,
        });
        let interrupted = crate::recovery::unlink_owned_entries(&directory, entries, |path| {
            if path.file_name().unwrap() == "owner.json" {
                assert_eq!(
                    std::fs::read_dir(&directory)?.count(),
                    1,
                    "ownership marker must be the last private entry removed"
                );
            }
            if path.file_name().unwrap() == "source.mp4" {
                return Err(std::io::Error::other("injected cleanup interruption"));
            }
            std::fs::remove_file(path)
        });
        assert!(interrupted.is_err());
        assert!(directory.join("owner.json").is_file());
        assert!(directory.join("source.mp4").is_file());
        assert_eq!(
            std::fs::read_dir(&directory).unwrap().count(),
            2,
            "earlier private entries were removed before the interruption"
        );
        cleanup_completed_recovery(&job).unwrap();
        cleanup_completed_recovery(&job).unwrap();
        assert!(!directory.exists());
        assert_eq!(std::fs::read(unrelated).unwrap(), b"keep");
        assert_eq!(std::fs::read(sibling.join("keep")).unwrap(), b"sibling");
        assert_eq!(std::fs::read(result.output_path).unwrap(), b"x");
    }

    #[tokio::test]
    async fn durable_done_cleans_exact_workspace_after_real_dispatch() {
        use goop_core::{Job, JobKind, JobState, ResultKind};
        use goop_queue::{QueueStore, Scheduler, WorkerFn};
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let db = TempDir::new().unwrap();
        let resolver = Arc::new(resolver_at(bins.path()));
        write_fake(bins.path(), "yt-dlp", &yt_dlp_succeeds(out.path()));
        let store = QueueStore::open(&db.path().join("queue.db")).unwrap();
        let req = request("https://youtube.com/watch?v=test", out.path());
        let job = Job::new(JobKind::Extract, serde_json::to_value(&req).unwrap());
        store.insert(&job).unwrap();
        let persist_store = store.clone();
        let worker: WorkerFn = Arc::new(move |id, payload, signals| {
            let store = persist_store.clone();
            let resolver = resolver.clone();
            Box::pin(async move {
                let recovery = ExtractRecovery::new(
                    None,
                    Arc::new(move |cp| {
                        store.patch_payload_field(
                            id,
                            crate::recovery::RECOVERY_PAYLOAD_KEY,
                            serde_json::to_value(cp).unwrap(),
                        )
                    }),
                )?;
                let result = dispatch_with_recovery(
                    &resolver,
                    Arc::new(RecordingSink::default()),
                    id,
                    &serde_json::from_value(payload)?,
                    signals,
                    None,
                    None,
                    recovery,
                )
                .await?;
                Ok(goop_core::JobResult {
                    output_path: Some(result.output_path),
                    bytes: Some(result.bytes),
                    duration_ms: result.duration_ms,
                    result_kind: ResultKind::File,
                    file_count: 1,
                    source_bytes: None,
                    target_bytes: None,
                    reencoded: None,
                })
            })
        });
        let sink = Arc::new(RecordingSink::default());
        let hook: goop_queue::CompletionHook = Arc::new(|job| {
            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    crate::recovery::cleanup_completed_recovery(&job)
                })
                .await
                .unwrap()
            })
        });
        let scheduler = Scheduler::with_pids_and_completion(
            store.clone(),
            sink.clone(),
            1,
            1,
            1,
            1,
            1,
            worker.clone(),
            worker.clone(),
            worker.clone(),
            worker.clone(),
            worker,
            Arc::new(goop_queue::SchedulerPidRegistry::new()),
            Some(hook),
        );
        let task = tokio::spawn(scheduler.run_kind(JobKind::Extract));
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if sink.queue.lock().iter().any(|e| e.state == JobState::Done) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let row = store.get_by_id(job.id).unwrap().unwrap();
        assert_eq!(row.state, JobState::Done);
        let cp: crate::recovery::RecoveryCheckpoint =
            serde_json::from_value(row.payload[crate::recovery::RECOVERY_PAYLOAD_KEY].clone())
                .unwrap();
        assert!(
            !cp.root.join(&cp.workspace).exists(),
            "durable success must release its private media copies"
        );
        assert_eq!(
            std::fs::read(row.result.unwrap().output_path.unwrap()).unwrap(),
            b"x"
        );
    }

    #[tokio::test]
    async fn normalized_edge_dot_titles_publish_on_first_attempt_and_resumed_retry() {
        for raw in ["... hello ...", " . . hello . . "] {
            for retry in [false, true] {
                let bins = TempDir::new().unwrap();
                let out = TempDir::new().unwrap();
                let counter = out.path().join("counter");
                let script = if retry {
                    recovery_fake(&counter)
                } else {
                    yt_dlp_succeeds(out.path())
                };
                write_fake(
                    bins.path(),
                    "yt-dlp",
                    &script.replace(
                        "\"title\":\"video\"",
                        &format!("\"title\":{}", serde_json::to_string(raw).unwrap()),
                    ),
                );
                let resolver = resolver_at(bins.path());
                let req = request("https://youtube.com/watch?v=test", out.path());
                let id = JobId::new();
                let recovery = ExtractRecovery::ephemeral();
                let first = dispatch_with_recovery(
                    &resolver,
                    Arc::new(RecordingSink::default()),
                    id,
                    &req,
                    JobSignals::new(),
                    None,
                    None,
                    recovery.clone(),
                )
                .await;
                let checkpoint = recovery.checkpoint().unwrap();
                assert_eq!(
                    checkpoint.owned_directory().unwrap(),
                    checkpoint.root.join(&checkpoint.workspace)
                );
                assert_eq!(checkpoint.title, "hello");
                let result = if retry {
                    assert!(first.is_err());
                    assert_eq!(checkpoint.sources.len(), 1);
                    let resumed = ExtractRecovery::new(
                        Some(serde_json::to_value(checkpoint).unwrap()),
                        Arc::new(|_| Ok(())),
                    )
                    .unwrap();
                    let result = dispatch_with_recovery(
                        &resolver,
                        Arc::new(RecordingSink::default()),
                        id,
                        &req,
                        JobSignals::new(),
                        None,
                        None,
                        resumed,
                    )
                    .await
                    .unwrap();
                    assert_eq!(
                        std::fs::read_to_string(counter)
                            .unwrap()
                            .matches("acquisition")
                            .count(),
                        1
                    );
                    result
                } else {
                    first.unwrap()
                };
                assert_eq!(
                    std::path::Path::new(&result.output_path)
                        .file_name()
                        .unwrap(),
                    "hello.mp4"
                );
                assert_eq!(
                    std::fs::read(result.output_path).unwrap(),
                    if retry {
                        b"completed original".as_slice()
                    } else {
                        b"x".as_slice()
                    }
                );
            }
        }
    }

    #[tokio::test]
    async fn publication_budgets_long_utf8_and_composed_names_with_collisions() {
        for (title, extractor, template) in [
            ("界".repeat(100), "site".into(), None),
            (
                "a".repeat(150),
                "b".repeat(150),
                Some("%(title)s — %(extractor)s.%(ext)s"),
            ),
            ("CON".into(), "site".into(), None),
            ("aux.backup".into(), "site".into(), None),
            ("COM1".into(), "site".into(), None),
            ("LPT9".into(), "site".into(), None),
        ] {
            let bins = TempDir::new().unwrap();
            let out = TempDir::new().unwrap();
            let resolver = resolver_at(bins.path());
            let script = yt_dlp_succeeds(out.path()).replace(
                "\"title\":\"video\"",
                &format!(
                    "\"title\":{},\"extractor\":{}",
                    serde_json::to_string(&title).unwrap(),
                    serde_json::to_string(&extractor).unwrap()
                ),
            );
            write_fake(bins.path(), "yt-dlp", &script);
            let mut req = request("https://youtube.com/watch?v=test", out.path());
            req.output_template = template.map(str::to_owned);
            let mut paths = Vec::new();
            for _ in 0..2 {
                let result = dispatch(
                    &resolver,
                    Arc::new(RecordingSink::default()),
                    JobId::new(),
                    &req,
                    JobSignals::new(),
                    None,
                )
                .await
                .unwrap();
                let path = std::path::PathBuf::from(result.output_path);
                let name = path.file_name().unwrap().to_str().unwrap();
                assert!(
                    name.len() <= 255,
                    "filename exceeds portable byte budget: {}",
                    name.len()
                );
                assert!(name.ends_with(".mp4"));
                let device = name.split('.').next().unwrap().to_ascii_uppercase();
                assert!(
                    !["CON", "AUX", "COM1", "LPT9"].contains(&device.as_str()),
                    "reserved device basename: {name}"
                );
                if !paths.is_empty() {
                    assert!(name.ends_with(" (1).mp4"));
                }
                paths.push(path);
            }
            assert_ne!(paths[0], paths[1]);
            for path in paths {
                assert_eq!(std::fs::read(path).unwrap(), b"x");
            }
        }
    }

    #[tokio::test]
    async fn publication_collision_preserves_symlink_and_concurrent_same_title_jobs() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let resolver = resolver_at(bins.path());
        write_fake(bins.path(), "yt-dlp", &yt_dlp_succeeds(out.path()));
        std::os::unix::fs::symlink("missing-target", out.path().join("video.mp4")).unwrap();
        let req = request("https://youtube.com/watch?v=test", out.path());
        let one = dispatch(
            &resolver,
            Arc::new(RecordingSink::default()),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
        );
        let two = dispatch(
            &resolver,
            Arc::new(RecordingSink::default()),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
        );
        let (one, two) = tokio::join!(one, two);
        let (one, two) = (one.unwrap(), two.unwrap());
        assert_ne!(one.output_path, two.output_path);
        assert_eq!(std::fs::read(one.output_path).unwrap(), b"x");
        assert_eq!(std::fs::read(two.output_path).unwrap(), b"x");
        assert_eq!(
            std::fs::read_link(out.path().join("video.mp4")).unwrap(),
            std::path::Path::new("missing-target")
        );
    }

    #[tokio::test]
    async fn cancellation_before_and_after_atomic_publication_respects_commit_authority() {
        use crate::recovery::RecoveryPhase;
        for after_commit in [false, true] {
            let bins = TempDir::new().unwrap();
            let out = TempDir::new().unwrap();
            let resolver = resolver_at(bins.path());
            write_fake(bins.path(), "yt-dlp", &yt_dlp_succeeds(out.path()));
            let req = request("https://youtube.com/watch?v=test", out.path());
            let signals = JobSignals::new();
            let cancel = signals.cancel.clone();
            let recovery = ExtractRecovery::new(
                None,
                Arc::new(move |cp| {
                    if cp.phase
                        == if after_commit {
                            RecoveryPhase::Published
                        } else {
                            RecoveryPhase::OutputVerified
                        }
                    {
                        cancel.cancel();
                    }
                    Ok(())
                }),
            )
            .unwrap();
            let result = dispatch_with_recovery(
                &resolver,
                Arc::new(RecordingSink::default()),
                JobId::new(),
                &req,
                signals,
                None,
                None,
                recovery.clone(),
            )
            .await;
            if after_commit {
                assert!(result.is_ok(), "{result:?}");
                assert_eq!(std::fs::read(result.unwrap().output_path).unwrap(), b"x");
            } else {
                assert!(matches!(result, Err(GoopError::Cancelled)));
                assert!(!out.path().join("video.mp4").exists());
                let cp = recovery.checkpoint().unwrap();
                assert!(
                    !cp.root.join(cp.workspace).exists(),
                    "cancel must clean its exact workspace after validation"
                );
            }
        }
    }

    #[tokio::test]
    async fn missing_publication_receipt_preserves_existing_output_on_recovery() {
        use crate::recovery::RecoveryPhase;
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let resolver = resolver_at(bins.path());
        write_fake(bins.path(), "yt-dlp", &yt_dlp_succeeds(out.path()));
        let req = request("https://youtube.com/watch?v=test", out.path());
        let id = JobId::new();
        let recovery = ExtractRecovery::new(
            None,
            Arc::new(|cp| {
                if cp.phase == RecoveryPhase::Published {
                    return Err(GoopError::Queue("receipt write failed".into()));
                }
                Ok(())
            }),
        )
        .unwrap();
        let first = dispatch_with_recovery(
            &resolver,
            Arc::new(RecordingSink::default()),
            id,
            &req,
            JobSignals::new(),
            None,
            None,
            recovery.clone(),
        )
        .await
        .unwrap();
        let checkpoint = recovery.checkpoint().unwrap();
        assert_eq!(checkpoint.phase, RecoveryPhase::OutputVerified);
        let resumed = ExtractRecovery::new(
            Some(serde_json::to_value(checkpoint).unwrap()),
            Arc::new(|_| Ok(())),
        )
        .unwrap();
        let second = dispatch_with_recovery(
            &resolver,
            Arc::new(RecordingSink::default()),
            id,
            &req,
            JobSignals::new(),
            None,
            None,
            resumed,
        )
        .await
        .unwrap();
        assert_ne!(
            first.output_path, second.output_path,
            "an interrupted receipt cannot authorize adopting a same-name file"
        );
        assert_eq!(std::fs::read(first.output_path).unwrap(), b"x");
        assert_eq!(std::fs::read(second.output_path).unwrap(), b"x");
    }

    #[tokio::test]
    async fn checkpoint_write_failure_prevents_spawn_or_publication() {
        use crate::recovery::{ExtractRecovery, RecoveryCheckpoint, RecoveryPhase};
        for fail_at in ["allocation", "writer", "source"] {
            let bins = TempDir::new().unwrap();
            let out = TempDir::new().unwrap();
            let counter = out.path().join("counter");
            write_fake(bins.path(), "yt-dlp", &recovery_fake(&counter));
            let resolver = resolver_at(bins.path());
            let persisted = Arc::new(std::sync::Mutex::new(None::<RecoveryCheckpoint>));
            let durable = persisted.clone();
            let recovery = ExtractRecovery::new(
                None,
                Arc::new(move |cp| {
                    let refused = match fail_at {
                        "allocation" => true,
                        "writer" => cp.writer_active,
                        "source" => !cp.sources.is_empty(),
                        _ => unreachable!(),
                    };
                    if refused {
                        return Err(GoopError::Queue(
                            "injected database failure: payload update affected 0 rows".into(),
                        ));
                    }
                    *durable.lock().unwrap() = Some(cp.clone());
                    Ok(())
                }),
            )
            .unwrap();
            let req = request("https://youtube.com/watch?v=test", out.path());
            let error = dispatch_with_recovery(
                &resolver,
                Arc::new(RecordingSink::default()),
                JobId::new(),
                &req,
                JobSignals::new(),
                None,
                None,
                recovery.clone(),
            )
            .await
            .unwrap_err();
            assert!(error.to_string().contains("injected database failure"));
            let durable = persisted.lock().unwrap().clone();
            assert_eq!(
                serde_json::to_value(recovery.checkpoint()).unwrap(),
                serde_json::to_value(&durable).unwrap(),
                "refused writes must not advance the in-memory checkpoint"
            );
            if fail_at == "allocation" {
                assert!(durable.is_none());
            } else {
                let checkpoint = durable.unwrap();
                assert_eq!(checkpoint.phase, RecoveryPhase::Allocated);
                assert!(checkpoint.sources.is_empty());
                assert!(!checkpoint.writer_active);
                assert!(checkpoint.published_path.is_none());
            }
            if fail_at != "source" {
                assert!(
                    !counter.exists(),
                    "allocation and writer state must be durable before spawn"
                );
            } else {
                assert_eq!(
                    std::fs::read_to_string(counter)
                        .unwrap()
                        .matches("acquisition")
                        .count(),
                    1
                );
            }
            assert!(!out.path().join("video.mp4").exists());
            assert!(
                !std::fs::read_dir(out.path()).unwrap().any(|entry| {
                    let name = entry.unwrap().file_name();
                    let name = name.to_string_lossy();
                    !name.starts_with(".goop-extract-") && name != "counter"
                }),
                "failed persistence must not publish an output"
            );
        }
    }

    #[tokio::test]
    async fn cancellation_stops_descendant_writer_and_cleans_only_owned_workspace() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let barrier = out.path().join("writer-count");
        let unrelated = out.path().join("other.part");
        std::fs::write(&unrelated, b"other").unwrap();
        write_fake(
            bins.path(),
            "yt-dlp",
            &format!(
                r#"
echo '__GOOP_PP__{{"status":"started","postprocessor":"Merger"}}' >&2
(while :; do echo write >> '{}'; sleep 0.01; done) &
wait
"#,
                barrier.display()
            ),
        );
        let resolver = resolver_at(bins.path());
        let req = request("https://youtube.com/watch?v=test", out.path());
        let signals = JobSignals::new();
        let recovery = ExtractRecovery::ephemeral();
        let future = dispatch_with_recovery(
            &resolver,
            Arc::new(RecordingSink::default()),
            JobId::new(),
            &req,
            signals.clone(),
            None,
            None,
            recovery.clone(),
        );
        tokio::pin!(future);
        tokio::select! {
            result = &mut future => panic!("premature result: {result:?}"),
            _ = async { tokio::time::timeout(Duration::from_secs(3), async {
                while !barrier.exists() { tokio::task::yield_now().await; }
            }).await.unwrap(); } => {}
        }
        signals.cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(3), &mut future)
            .await
            .unwrap();
        assert!(matches!(result, Err(GoopError::Cancelled)), "{result:?}");
        let count = std::fs::metadata(&barrier).unwrap().len();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(std::fs::metadata(barrier).unwrap().len(), count);
        assert_eq!(std::fs::read(unrelated).unwrap(), b"other");
        let cp = recovery.checkpoint().unwrap();
        assert!(!cp.root.join(cp.workspace).exists());
    }

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
    /// it was handed, named on stdout the way the real tool names every
    /// file it writes. That line is what the run is tallied from, so
    /// without it the run is "no extractable content" however many files
    /// are on disk.
    ///
    /// The `|| true` guards the one fake that closes stdout deliberately:
    /// an unguarded `echo` to a closed fd would put a shell error on
    /// stderr, which is the stream that test is about.
    const GALLERY_DL_WRITES_ONE_FILE: &str = r#"
dir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--directory" ]; then dir="$a"; fi
  prev="$a"
done
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

    fn resolver_at(bins: &std::path::Path) -> BinaryResolver {
        write_fake(bins, "ffmpeg", "exit 0\n");
        write_fake(
            bins,
            "ffprobe",
            "echo '{\"streams\":[{\"codec_type\":\"video\"},{\"codec_type\":\"audio\"}]}'\n",
        );
        BinaryResolver::new(bins.to_path_buf())
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
    fn yt_dlp_succeeds(_out: &std::path::Path) -> String {
        r#"
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then dir=$(dirname "$a"); fi
  prev="$a"
done
printf 'x' > "$dir/source.mp4"
printf '__GOOP_SOURCE__{"title":"video","format_id":"18","ext":"mp4","vcodec":"h264","acodec":"aac","filepath":"%s/source.mp4"}\n' "$dir"
printf '__GOOP_FINAL__"%s/source.mp4"\n' "$dir"
exit 0
"#.into()
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
            extractor_hint: None,
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

        let resolver = resolver_at(bins.path());
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

        let resolver = resolver_at(bins.path());
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

        let resolver = resolver_at(bins.path());
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
        // gallery-dl closes stdout inside the cookie-failure branch instead
        // of up front. That is the invocation whose stderr has to survive,
        // so it is where the losing interleaving belongs — and it leaves the
        // no-cookie retry able to report the file it downloaded, which is
        // what the run is tallied from.
        const CLOSE_STDOUT_THEN_COOKIE_FAIL: &str = r#"
for a in "$@"; do
  if [ "$a" = "--cookies-from-browser" ]; then
    exec 1>&-
    sleep 0.2
    echo "ERROR: Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271" >&2
    exit 1
  fi
done
"#;
        write_fake(
            bins.path(),
            "gallery-dl",
            &format!("{CLOSE_STDOUT_THEN_COOKIE_FAIL}{GALLERY_DL_WRITES_ONE_FILE}"),
        );

        let resolver = resolver_at(bins.path());
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

        let resolver = resolver_at(bins.path());
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

    /// The stdout counterpart of the test above, where the same bad line
    /// cost more than a truncated message: the stdout arm propagated the
    /// decode error with `?`, returning from `download_once` with the
    /// child neither killed nor waited for. Nothing downstream cleaned
    /// that up — no spawn in this tree sets `kill_on_drop` — so a live
    /// yt-dlp kept writing into the user's folder after the job had
    /// already reported failure, and the Retry button then landed a
    /// second one on the same `--continue`d `.part`. No layer even
    /// re-dispatched on its own to make that visible: `GoopError::Io` is
    /// neither transient nor a no-match verdict, so the run just failed.
    ///
    /// What this observes is the success, not the process: the fake
    /// writes its file AFTER the bad line, so finishing at all proves the
    /// loop got past a line it couldn't read, drained to EOF, and reaped
    /// the child for its exit status — the only route to `Ok` here. It
    /// cannot tell a reaped failure from an abandoned one, which is why
    /// the name claims the run, not the child.
    #[tokio::test]
    async fn an_undecodable_stdout_line_does_not_end_the_run() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let file = out.path().join("video.mp4");
        let file = file.to_string_lossy().into_owned();
        // `--print after_move:filepath` puts one absolute path on stdout
        // per file finished, and that path is the only place a title
        // reaches this stream. Here the first one is mis-encoded: `\351`
        // is `é` in cp1252, which is what a title looks like once yt-dlp
        // has encoded stdout in a legacy Windows codepage rather than
        // UTF-8, and a lone 0xe9 is not valid UTF-8 in any position. The
        // directory rides in as a `%s` argument so a `%` in the temp path
        // can't be read as a conversion.
        write_fake(
            bins.path(),
            "yt-dlp",
            &format!(
                "printf '%s/Caf\\351.mp4\\n' '{dir}'\n{success}",
                dir = out.path().display(),
                success = yt_dlp_succeeds(out.path())
            ),
        );
        // Never reached: yt-dlp succeeds, and the IO error it used to
        // return is not a no-match either. Present so the resolver can't
        // silently pick up a real gallery-dl from $PATH.
        write_fake(
            bins.path(),
            "gallery-dl",
            "echo 'ERROR: the fallback extractor ran' >&2\nexit 1\n",
        );

        let resolver = resolver_at(bins.path());
        let rec = Arc::new(RecordingSink::new());
        let mut req = request("https://example.com/x", out.path());
        // Isolate the decode path: no cookies, so nothing else can send
        // the run around again.
        req.cookies_from_browser = None;

        let outcome = dispatch_with_policy(
            &resolver,
            rec.clone(),
            JobId::new(),
            &req,
            JobSignals::new(),
            &FAST_RETRIES,
            None,
        )
        .await
        .expect("the undecodable line must not end the run");

        assert_eq!(
            std::path::PathBuf::from(outcome.output_path),
            std::fs::canonicalize(file).unwrap(),
            "the path printed after the bad line must still be the result"
        );
    }

    /// The `--print after_move:filepath` line is the only stdout line under
    /// the download argv that carries a title, and it is the line the
    /// wrapper learns the output path from. yt-dlp writes it through
    /// `write_string`, which encodes with the stream's own encoding and an
    /// `ignore` error handler — for a redirected pipe on Windows, the ANSI
    /// codepage. Both halves of that lose the download, and the second one
    /// silently:
    ///
    /// - a character the codepage CAN represent becomes a legacy byte
    ///   (cp1252 `é` -> 0xE9), which is not valid UTF-8, so the line never
    ///   decodes and no path is ever reported;
    /// - a character it CANNOT is DROPPED by `ignore`, so a Japanese or
    ///   Cyrillic title yields a perfectly decodable path that does not
    ///   exist on disk. The `.exists()` guard rejects it, `output_path`
    ///   stays None, and the run fails as "no output file reported" with
    ///   nothing in the log to say why.
    ///
    /// The output DIRECTORY rides in that same line, so a profile path like
    /// `C:\Users\José\Downloads` breaks it even when the title is ASCII.
    ///
    /// `--encoding` reaches exactly this path: `--print` writes via
    /// `to_stdout` -> `YoutubeDL._write_string`, which hands
    /// `params['encoding']` to `write_string`. Same class as gallery-dl's
    /// `-o output.stdout=utf-8`.
    ///
    /// This asserts the COMMAND LINE specifically, because the environment
    /// is not an option: the shipped 2026.06.09 PyInstaller build ignores
    /// `PYTHONIOENCODING` outright, so a future "simplification" that moves
    /// the pin into an env var would be silently inert on the one platform
    /// it exists for.
    ///
    /// Reads the argv off a fake that dumps it, which is the only way to see
    /// what was actually spawned.
    #[tokio::test]
    async fn the_yt_dlp_stdout_encoding_is_pinned_on_the_command_line() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        // Its own directory: the binary resolver reads `bins` and the
        // wrapper canonicalizes `out`, and the dump belongs to neither.
        let dumped = TempDir::new().unwrap();
        let argv = dumped.path().join("argv");
        // Dump argv, then succeed, so the run ends without a fallback spawn
        // appending a second invocation to the same file.
        write_fake(
            bins.path(),
            "yt-dlp",
            &format!(
                "for a in \"$@\"; do echo \"$a\" >> '{}'; done\n{}",
                argv.display(),
                yt_dlp_succeeds(out.path())
            ),
        );

        let mut req = request("https://example.com/x", out.path());
        req.cookies_from_browser = None;

        let res = dispatch(
            &resolver_at(bins.path()),
            Arc::new(RecordingSink::new()),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
        )
        .await;
        assert!(res.is_ok(), "the fake yt-dlp succeeds: {res:?}");

        let sent: Vec<String> = std::fs::read_to_string(&argv)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect();
        // Adjacency, not presence: `--encoding` takes its value as the next
        // argv word, so a stray `utf-8` anywhere else would prove nothing.
        assert!(
            sent.windows(2)
                .any(|w| w[0] == "--encoding" && w[1] == "utf-8"),
            "missing `--encoding utf-8` in argv:\n{}",
            sent.join("\n")
        );
    }

    // ---- the probe's extractor verdict ----------------------------------

    /// Writes a witness file so a test can prove a binary was NEVER run.
    /// Asserting on the error text only proves which one failed last.
    fn witness(path: &std::path::Path) -> String {
        format!(
            "printf 'x' > '{}'\necho 'ERROR: Unsupported URL' >&2\nexit 1\n",
            path.display()
        )
    }

    /// The point of the hint. `classify_extractor` sends anything it does
    /// not recognise to yt-dlp, so a gallery-dl URL it has no rule for costs
    /// a doomed yt-dlp spawn before the fallback rescues it. The probe
    /// already found out which one answers.
    #[tokio::test]
    async fn a_hinted_request_does_not_spawn_the_other_extractor() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let seen = out.path().join("yt-dlp.ran");
        write_fake(bins.path(), "yt-dlp", &witness(&seen));
        write_fake(bins.path(), "gallery-dl", GALLERY_DL_WRITES_ONE_FILE);

        // A URL `classify_extractor` routes to yt-dlp by default.
        let mut req = request("https://example.com/x", out.path());
        req.cookies_from_browser = None;
        assert_eq!(
            classify_extractor(&req.url),
            ExtractorChoice::YtDlp,
            "the test is only meaningful if the classifier disagrees with the hint"
        );
        req.extractor_hint = Some(ExtractorChoice::GalleryDl);

        let res = dispatch(
            &resolver_at(bins.path()),
            Arc::new(RecordingSink::new()),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
        )
        .await;

        assert!(res.is_ok(), "gallery-dl should have carried it: {res:?}");
        assert!(!seen.exists(), "the hint must skip the doomed yt-dlp spawn");
    }

    /// Without a hint nothing changes: the classifier still decides, and the
    /// fallback still rescues its wrong guesses.
    #[tokio::test]
    async fn an_unhinted_request_still_classifies_and_falls_back() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let seen = out.path().join("yt-dlp.ran");
        write_fake(bins.path(), "yt-dlp", &witness(&seen));
        write_fake(bins.path(), "gallery-dl", GALLERY_DL_WRITES_ONE_FILE);

        let mut req = request("https://example.com/x", out.path());
        req.cookies_from_browser = None;
        assert!(req.extractor_hint.is_none());

        let res = dispatch(
            &resolver_at(bins.path()),
            Arc::new(RecordingSink::new()),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
        )
        .await;

        assert!(res.is_ok(), "the fallback still rescues it: {res:?}");
        assert!(
            seen.exists(),
            "the classifier's guess must still be tried first"
        );
    }

    /// A hint that has gone stale — the site changed hands, or the payload
    /// predates a classifier fix — must cost nothing beyond one wrong spawn,
    /// which is exactly what an unhinted misclassification costs today.
    #[tokio::test]
    async fn a_wrong_hint_degrades_to_the_normal_fallback() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        // Hinted at yt-dlp, but only gallery-dl can do the job.
        write_fake(
            bins.path(),
            "yt-dlp",
            "echo 'ERROR: Unsupported URL' >&2\nexit 1\n",
        );
        write_fake(bins.path(), "gallery-dl", GALLERY_DL_WRITES_ONE_FILE);

        let mut req = request("https://imgur.com/gallery/abc", out.path());
        req.cookies_from_browser = None;
        req.extractor_hint = Some(ExtractorChoice::YtDlp);

        let res = dispatch(
            &resolver_at(bins.path()),
            Arc::new(RecordingSink::new()),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
        )
        .await;
        assert!(res.is_ok(), "a stale hint must not break the job: {res:?}");
    }

    /// The first link in the chain: a probe has to say which extractor
    /// answered it, or there is no verdict for the UI to echo and the hint
    /// is dead on arrival. Driven through the real `probe` entry points so
    /// the reporting cannot be true of one extractor and not the other.
    #[tokio::test]
    async fn each_probe_names_the_extractor_that_answered() {
        let bins = TempDir::new().unwrap();
        // `-J` output: yt-dlp prints one JSON object on stdout.
        write_fake(
            bins.path(),
            "yt-dlp",
            "echo '{\"title\":\"clip\",\"formats\":[]}'\nexit 0\n",
        );
        // `-j` output: gallery-dl prints an array of triples.
        write_fake(bins.path(), "gallery-dl", "echo '[]'\nexit 0\n");
        let resolver = resolver_at(bins.path());

        let yt = YtDlp::probe(&resolver, "https://example.com/x", None)
            .await
            .expect("the fake yt-dlp answers");
        assert_eq!(yt.extractor, Some(ExtractorChoice::YtDlp));

        let gd =
            crate::gallery_dl::GalleryDl::probe(&resolver, "https://imgur.com/gallery/a", None)
                .await
                .expect("the fake gallery-dl answers");
        assert_eq!(gd.extractor, Some(ExtractorChoice::GalleryDl));
    }

    /// The retry helper is only useful if what a real probe returns on a
    /// transient failure actually classifies as transient. That is the
    /// join between two independently-correct pieces, and getting it wrong
    /// means the retry never fires in production while every unit test
    /// stays green.
    #[tokio::test]
    async fn a_real_transient_probe_failure_is_retried_and_recovers() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let counter = out.path().join("runs");
        // 503 first, then a valid `-J` payload.
        write_fake(
            bins.path(),
            "yt-dlp",
            &format!(
                "echo run >> '{}'\n                 if [ $(wc -l < '{}') -eq 1 ]; then
                   echo 'ERROR: Unable to download webpage: HTTP Error 503: Service Unavailable' >&2
                   exit 1
                 fi
                 echo '{{\"title\":\"clip\",\"formats\":[]}}'
                 exit 0
",
                counter.display(),
                counter.display()
            ),
        );
        let resolver = resolver_at(bins.path());

        let probe = crate::retry::with_probe_retry(std::time::Duration::from_millis(1), || {
            YtDlp::probe(&resolver, "https://example.com/x", None)
        })
        .await
        .expect("the second attempt succeeds");

        assert_eq!(probe.title, "clip");
        assert_eq!(
            runs(&counter),
            2,
            "the 503 must have been recognised as transient"
        );
    }

    /// And a permanent one must not be retried, or every dead link costs an
    /// extra spawn and a wait before saying the same thing.
    #[tokio::test]
    async fn a_real_permanent_probe_failure_is_not_retried() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let counter = out.path().join("runs");
        write_fake(
            bins.path(),
            "yt-dlp",
            &counting(
                &counter,
                "echo 'ERROR: [youtube] abc: Private video' >&2\nexit 1\n",
            ),
        );
        let resolver = resolver_at(bins.path());

        let res = crate::retry::with_probe_retry(std::time::Duration::from_millis(1), || {
            YtDlp::probe(&resolver, "https://example.com/x", None)
        })
        .await;

        assert!(res.is_err());
        assert_eq!(
            runs(&counter),
            1,
            "a private video is not going to become public"
        );
    }

    /// Legacy payloads. Every job queued before this field existed is still
    /// in the store, and the worker deserializes straight from SQLite.
    #[test]
    fn a_payload_without_the_field_deserializes() {
        let json = serde_json::json!({
            "url": "https://example.com/x",
            "output_dir": "/tmp",
            "format": null,
            "audio_only": false,
        });
        let req: ExtractRequest = serde_json::from_value(json).expect("legacy payload");
        assert!(req.extractor_hint.is_none());
    }

    // ---- format choices that gallery-dl cannot honour --------------------

    /// gallery-dl has no format selection: it saves what the site has. A
    /// request carrying a format choice that lands there gets the file, but
    /// not the quality the user picked — and said nothing about it.
    #[tokio::test]
    async fn a_format_choice_on_the_gallery_path_warns() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        write_fake(bins.path(), "gallery-dl", GALLERY_DL_WRITES_ONE_FILE);
        write_fake(
            bins.path(),
            "yt-dlp",
            "echo 'ERROR: Unsupported URL' >&2\nexit 1\n",
        );

        let rec = Arc::new(RecordingSink::new());
        let mut req = request("https://imgur.com/gallery/abc", out.path());
        req.cookies_from_browser = None;
        req.format = Some("137".into());

        let res = dispatch(
            &resolver_at(bins.path()),
            rec.clone(),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
        )
        .await;
        assert!(res.is_ok(), "{res:?}");
        assert_eq!(
            warning_codes(&rec),
            vec![WarningCode::FormatFallback],
            "the download works; the format choice silently did not"
        );
    }

    /// Audio-only is the same promise by another name.
    #[tokio::test]
    async fn audio_only_on_the_gallery_path_warns() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        write_fake(bins.path(), "gallery-dl", GALLERY_DL_WRITES_ONE_FILE);
        write_fake(
            bins.path(),
            "yt-dlp",
            "echo 'ERROR: Unsupported URL' >&2\nexit 1\n",
        );

        let rec = Arc::new(RecordingSink::new());
        let mut req = request("https://imgur.com/gallery/abc", out.path());
        req.cookies_from_browser = None;
        req.audio_only = true;

        dispatch(
            &resolver_at(bins.path()),
            rec.clone(),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
        )
        .await
        .expect("downloads");
        assert_eq!(warning_codes(&rec), vec![WarningCode::FormatFallback]);
    }

    /// "Saved in the original quality" is a claim about a file that exists.
    /// A gallery-dl attempt that fails has saved nothing, and telling the
    /// user how it was saved is worse than saying nothing at all.
    #[tokio::test]
    async fn a_failed_gallery_attempt_claims_nothing_about_quality() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        // Fails in a way that is neither a no-match nor transient, so
        // nothing rescues it and nothing retries.
        write_fake(
            bins.path(),
            "gallery-dl",
            "echo 'ERROR: [site] Private album' >&2\nexit 1\n",
        );
        write_fake(
            bins.path(),
            "yt-dlp",
            "echo 'ERROR: Unsupported URL' >&2\nexit 1\n",
        );

        let rec = Arc::new(RecordingSink::new());
        let mut req = request("https://imgur.com/gallery/abc", out.path());
        req.cookies_from_browser = None;
        req.format = Some("137".into());

        dispatch(
            &resolver_at(bins.path()),
            rec.clone(),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
        )
        .await
        .expect_err("the fake gallery-dl always fails");

        assert!(
            warning_codes(&rec).is_empty(),
            "nothing was saved, so nothing can be reported about how"
        );
    }

    /// gallery-dl was only the first guess. When it disowns the URL and
    /// yt-dlp carries the job, the format choice WAS honoured — warning
    /// about it would tell the user their download is wrong when it isn't.
    #[tokio::test]
    async fn a_gallery_attempt_superseded_by_yt_dlp_does_not_warn() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        // Primary (by classification) disowns it...
        write_fake(
            bins.path(),
            "gallery-dl",
            "echo 'ERROR: No suitable extractor found' >&2\nexit 1\n",
        );
        // ...and yt-dlp, which honours formats, does the job.
        write_fake(bins.path(), "yt-dlp", &yt_dlp_succeeds(out.path()));

        let rec = Arc::new(RecordingSink::new());
        let mut req = request("https://imgur.com/gallery/abc", out.path());
        req.cookies_from_browser = None;
        req.audio_only = true;
        assert_eq!(
            classify_extractor(&req.url),
            ExtractorChoice::GalleryDl,
            "the test needs gallery-dl to be tried first"
        );

        let resolver = resolver_at(bins.path());
        write_fake(
            bins.path(),
            "ffprobe",
            "echo '{\"streams\":[{\"codec_type\":\"audio\"}]}'\n",
        );
        let res = dispatch(
            &resolver,
            rec.clone(),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
        )
        .await;

        assert!(res.is_ok(), "yt-dlp should carry it: {res:?}");
        assert!(
            warning_codes(&rec).is_empty(),
            "yt-dlp honoured the choice; warning would be simply false"
        );
    }

    /// No format asked for, nothing to warn about. A gallery download is
    /// the normal case and must stay quiet.
    #[tokio::test]
    async fn a_plain_gallery_download_does_not_warn() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        write_fake(bins.path(), "gallery-dl", GALLERY_DL_WRITES_ONE_FILE);
        write_fake(
            bins.path(),
            "yt-dlp",
            "echo 'ERROR: Unsupported URL' >&2\nexit 1\n",
        );

        let rec = Arc::new(RecordingSink::new());
        let mut req = request("https://imgur.com/gallery/abc", out.path());
        req.cookies_from_browser = None;

        dispatch(
            &resolver_at(bins.path()),
            rec.clone(),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
        )
        .await
        .expect("downloads");
        assert!(warning_codes(&rec).is_empty());
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

        let resolver = resolver_at(bins.path());
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

        let resolver = resolver_at(bins.path());
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

        let resolver = resolver_at(bins.path());
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

        let resolver = resolver_at(bins.path());
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

        let resolver = resolver_at(bins.path());
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

        let resolver = resolver_at(bins.path());
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
        let resolver = resolver_at(bins.path());
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

    /// A `&list=` URL is what you get by copying a link off a playlist
    /// page, and it is the normal way the URL arrives. Without the pin one
    /// click downloads every video in the playlist behind a single
    /// progress bar, and `output_path` records only the last file.
    #[tokio::test]
    async fn a_download_never_expands_a_playlist() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let argv = out.path().join("argv");
        write_fake(
            bins.path(),
            "yt-dlp",
            &format!(
                "for a in \"$@\"; do echo \"$a\" >> '{}'; done\nexit 1\n",
                argv.display()
            ),
        );

        let req = request("https://www.youtube.com/watch?v=x&list=y", out.path());
        assert_eq!(
            classify_extractor(&req.url),
            ExtractorChoice::YtDlp,
            "the test only pins yt-dlp's argv if yt-dlp is the one spawned"
        );
        let _ = dispatch(
            &resolver_at(bins.path()),
            Arc::new(RecordingSink::new()),
            JobId::new(),
            &req,
            JobSignals::new(),
            None,
        )
        .await;

        let sent = std::fs::read_to_string(&argv).unwrap_or_default();
        assert!(
            sent.contains("--no-playlist"),
            "download argv must pin --no-playlist; got:\n{sent}"
        );
    }
}
