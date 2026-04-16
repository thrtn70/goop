use goop_core::{ConvertRequest, ConvertResult, GoopError, JobId, ProbeResult};
use goop_sidecar::BinaryResolver;
use std::path::Path;
use tokio_util::sync::CancellationToken;

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

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "tiff", "tif"];

pub fn backend_for_extension(ext: &str) -> BackendKind {
    let lower = ext.to_ascii_lowercase();
    if IMAGE_EXTENSIONS.contains(&lower.as_str()) {
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
