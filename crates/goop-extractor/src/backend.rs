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
};
use goop_sidecar::BinaryResolver;
use std::sync::Arc;

use crate::classify::{classify_extractor, ExtractorChoice};
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
) -> Result<BackendOutcome, GoopError> {
    dispatch_with_policy(resolver, sink, job_id, req, signals, &DEFAULT_RETRY_POLICY).await
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
) -> Result<BackendOutcome, GoopError> {
    with_retry(policy, &signals, &sink, job_id, || {
        dispatch_once(resolver, sink.clone(), job_id, req, signals.clone())
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
) -> Result<BackendOutcome, GoopError> {
    // Fast path: the probe already determined this is a plain file neither
    // extractor handles, so skip the two doomed extractor spawns.
    if req.direct {
        return crate::direct::download(sink, job_id, req, signals).await;
    }
    let primary = classify_extractor(&req.url);
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
        // Neither extractor recognised the URL: stream it directly.
        BothFailed::TryDirect => crate::direct::download(sink, job_id, req, signals).await,
        BothFailed::Surface(e) => Err(e),
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
