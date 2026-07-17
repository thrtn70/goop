//! Routing layer that picks between yt-dlp and gallery-dl based on the
//! URL's classifier output, then falls back to the OTHER extractor if
//! the chosen one returns a "no matching extractor" error.
//!
//! `dispatch` is the only thing the IPC layer needs to call. Both
//! backends produce the same `BackendOutcome` shape so the caller can
//! convert to a `JobResult` without caring which extractor ran.

use goop_core::{is_no_matching_extractor, EventSink, GoopError, JobId, JobSignals};
use goop_sidecar::BinaryResolver;
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
/// extractor, and fall back to the OTHER one on a "no matching
/// extractor" error. Transient network failures are retried with
/// backoff (resuming from partial files); every other failure mode
/// (auth, rate limit on the subprocess paths, unsupported input)
/// propagates on the first attempt.
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
/// "Unsupported URL") are disjoint from the transient set.
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
        return debrid::run(sink, job_id, req, signals, ctx).await;
    }
    // Fast path: the probe already determined this is a plain file neither
    // extractor handles, so skip the two doomed extractor spawns.
    if req.direct {
        return crate::direct::download(sink, job_id, req, signals).await;
    }
    let primary = classify_extractor(&req.url);
    let result = run_one(
        resolver,
        sink.clone(),
        job_id,
        req,
        signals.clone(),
        primary,
    )
    .await;
    match result {
        Ok(outcome) => Ok(outcome),
        Err(err) => {
            // A fired signal (cancel OR pause) suppresses the fallback:
            // the user asked this job to stop, not to try harder.
            if signals.check().is_some() || !is_no_matching_extractor_err(&err) {
                return Err(err);
            }
            let fallback = match primary {
                ExtractorChoice::YtDlp => ExtractorChoice::GalleryDl,
                ExtractorChoice::GalleryDl => ExtractorChoice::YtDlp,
            };
            match run_one(
                resolver,
                sink.clone(),
                job_id,
                req,
                signals.clone(),
                fallback,
            )
            .await
            {
                Ok(outcome) => Ok(outcome),
                Err(err2) => {
                    if signals.check().is_some() || !is_no_matching_extractor_err(&err2) {
                        return Err(err2);
                    }
                    // Neither extractor recognised the URL: stream it directly.
                    match crate::direct::download(sink.clone(), job_id, req, signals.clone()).await
                    {
                        Ok(outcome) => Ok(outcome),
                        Err(err3) => {
                            debrid_last_resort(sink, job_id, req, signals, debrid, err3).await
                        }
                    }
                }
            }
        }
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

fn is_no_matching_extractor_err(err: &GoopError) -> bool {
    match err {
        GoopError::SubprocessFailed { stderr, .. } => is_no_matching_extractor(stderr),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_matching_extractor_err_matches_subprocess_failure() {
        let err = GoopError::SubprocessFailed {
            binary: "yt-dlp".into(),
            stderr: "ERROR: Unsupported URL: https://example.com".into(),
        };
        assert!(is_no_matching_extractor_err(&err));
    }

    #[test]
    fn no_matching_extractor_err_ignores_other_errors() {
        let err = GoopError::SubprocessFailed {
            binary: "yt-dlp".into(),
            stderr: "HTTPError: 404 Not Found".into(),
        };
        assert!(!is_no_matching_extractor_err(&err));
        let err = GoopError::Cancelled;
        assert!(!is_no_matching_extractor_err(&err));
        // The control-flow and transient variants must never trigger the
        // cross-extractor fallback.
        assert!(!is_no_matching_extractor_err(&GoopError::Paused));
        assert!(!is_no_matching_extractor_err(&GoopError::Network(
            "Unsupported URL in a network message must not count".into()
        )));
    }
}
