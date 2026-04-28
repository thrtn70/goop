//! Routing layer that picks between yt-dlp and gallery-dl based on the
//! URL's classifier output, then falls back to the OTHER extractor if
//! the chosen one returns a "no matching extractor" error.
//!
//! `dispatch` is the only thing the IPC layer needs to call. Both
//! backends produce the same `BackendOutcome` shape so the caller can
//! convert to a `JobResult` without caring which extractor ran.

use goop_core::{is_no_matching_extractor, EventSink, GoopError, JobId};
use goop_sidecar::BinaryResolver;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use crate::classify::{classify_extractor, ExtractorChoice};
use crate::gallery_dl::GalleryDl;
use crate::ytdlp::{ExtractRequest, YtDlp};

/// Uniform result the IPC layer turns into a `JobResult`. `result_kind`
/// here is the corresponding `goop_core::ResultKind` variant — we keep
/// the dispatch crate decoupled from that enum by stringifying.
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
/// extractor" error. Errors from any other failure mode (network,
/// auth, rate limit, etc.) propagate without retry.
pub async fn dispatch(
    resolver: &BinaryResolver,
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    cancel: CancellationToken,
) -> Result<BackendOutcome, GoopError> {
    let primary = classify_extractor(&req.url);
    let result = run_one(resolver, sink.clone(), job_id, req, cancel.clone(), primary).await;
    match result {
        Ok(outcome) => Ok(outcome),
        Err(err) => {
            if cancel.is_cancelled() {
                return Err(err);
            }
            if !is_no_matching_extractor_err(&err) {
                return Err(err);
            }
            let fallback = match primary {
                ExtractorChoice::YtDlp => ExtractorChoice::GalleryDl,
                ExtractorChoice::GalleryDl => ExtractorChoice::YtDlp,
            };
            run_one(resolver, sink, job_id, req, cancel, fallback).await
        }
    }
}

async fn run_one(
    resolver: &BinaryResolver,
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    cancel: CancellationToken,
    backend: ExtractorChoice,
) -> Result<BackendOutcome, GoopError> {
    match backend {
        ExtractorChoice::YtDlp => {
            let yt = YtDlp::new(resolver, sink);
            let res = yt.download(job_id, req, cancel).await?;
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
            let res = gd.download(job_id, req, cancel).await?;
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
    }
}
