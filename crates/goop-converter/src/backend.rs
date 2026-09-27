use goop_core::{
    ConvertRequest, ConvertResult, GoopError, JobId, JobResult, ProbeResult, ResultKind,
};
use goop_sidecar::BinaryResolver;
use std::path::Path;
use tokio_util::sync::CancellationToken;

pub fn conversion_job_result(result: &ConvertResult) -> JobResult {
    JobResult {
        video_attempt: result.video_attempt.clone(),
        track_execution: result.track_execution.clone(),
        audio_execution: result.audio_execution.clone(),
        video_execution: result.video_execution.clone(),
        video_track_execution: result.video_track_execution.clone(),
        image_metadata_execution: result.image_metadata_execution.clone(),
        compression_execution: result.compression_execution.clone(),
        image_alpha_execution: result.image_alpha_execution,
        source_bytes: result.source_bytes,
        target_bytes: result.target_bytes,
        reencoded: Some(result.reencoded),
        output_path: Some(result.output_path.clone()),
        bytes: Some(result.bytes),
        duration_ms: result.duration_ms,
        result_kind: ResultKind::File,
        file_count: 1,
    }
}

pub(crate) async fn publish_conversion(
    staged: goop_core::output::StagedOutput,
    destination: goop_core::output::OutputDestination,
    target_bytes: Option<u64>,
    cancel: CancellationToken,
    observer: Option<std::sync::Arc<dyn goop_core::publication::PublicationObserver>>,
    result: JobResult,
) -> Result<goop_core::output::PublishedOutput, GoopError> {
    // Identity verification reads the full output. Own and await this task:
    // cancellation cannot detach a publisher that may already have moved it.
    tokio::task::spawn_blocking(move || {
        if let Some(observer) = observer {
            staged.publish_observed(
                &destination,
                target_bytes,
                false,
                &cancel,
                observer.as_ref(),
                &result,
            )
        } else {
            staged.publish(&destination, target_bytes, false, &cancel)
        }
    })
    .await
    .map_err(|error| GoopError::Queue(format!("output publication task failed: {error}")))?
}

/// Abstraction over conversion backends (ffmpeg, ImageMagick, etc.).
///
/// Each backend knows how to probe a file for metadata and convert it to a
/// target format. Implementations share infrastructure from this crate
/// (`ProgressTracker`, `naming`, `EventSink`) but own their subprocess
/// invocation and output parsing.
pub trait ConversionBackend: Send + Sync {
    /// Probe a file and return metadata. Static method — no `&self` needed.
    fn probe(
        resolver: &BinaryResolver,
        path: &Path,
    ) -> impl std::future::Future<Output = Result<ProbeResult, GoopError>> + Send
    where
        Self: Sized;

    /// Convert a file according to the request. Streams progress via the
    /// backend's `EventSink`. Cancellable via the token.
    fn convert(
        &self,
        job_id: JobId,
        req: &ConvertRequest,
        cancel: CancellationToken,
    ) -> impl std::future::Future<Output = Result<ConvertResult, GoopError>> + Send;
}

/// Which backend to dispatch to, based on source file extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    Ffmpeg,
    ImageMagick,
}

const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "bmp", "tiff", "tif", "avif", "hdr", "ico", "jxl", "heic", "heif",
];

pub fn backend_for_extension(ext: &str) -> BackendKind {
    let lower = ext.to_ascii_lowercase();
    if IMAGE_EXTENSIONS.contains(&lower.as_str()) || crate::raw::is_raw_extension(ext) {
        BackendKind::ImageMagick
    } else {
        BackendKind::Ffmpeg
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_images_to_imagemagick() {
        assert_eq!(backend_for_extension("png"), BackendKind::ImageMagick);
        assert_eq!(backend_for_extension("JPG"), BackendKind::ImageMagick);
        assert_eq!(backend_for_extension("webp"), BackendKind::ImageMagick);
        assert_eq!(backend_for_extension("bmp"), BackendKind::ImageMagick);
        assert_eq!(backend_for_extension("tiff"), BackendKind::ImageMagick);
        assert_eq!(backend_for_extension("jxl"), BackendKind::ImageMagick);
        // HEIC/HEIF route here so decode_any can return a clear
        // "not supported in this build" error rather than letting
        // ffmpeg produce an opaque demuxer failure.
        assert_eq!(backend_for_extension("heic"), BackendKind::ImageMagick);
        assert_eq!(backend_for_extension("HEIF"), BackendKind::ImageMagick);
    }

    #[test]
    fn routes_raw_to_image_backend() {
        for ext in [
            "dng", "DNG", "nef", "arw", "cr2", "cr3", "raf", "orf", "rw2",
        ] {
            assert_eq!(
                backend_for_extension(ext),
                BackendKind::ImageMagick,
                "{ext}"
            );
        }
    }

    #[test]
    fn routes_media_to_ffmpeg() {
        assert_eq!(backend_for_extension("mp4"), BackendKind::Ffmpeg);
        assert_eq!(backend_for_extension("mkv"), BackendKind::Ffmpeg);
        assert_eq!(backend_for_extension("mp3"), BackendKind::Ffmpeg);
        assert_eq!(backend_for_extension("gif"), BackendKind::Ffmpeg);
        assert_eq!(backend_for_extension("wav"), BackendKind::Ffmpeg);
        assert_eq!(backend_for_extension(""), BackendKind::Ffmpeg);
    }
}
