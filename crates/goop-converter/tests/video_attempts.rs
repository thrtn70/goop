mod common;

use common::{bundled_resolver, ffmpeg_path, make_source, request, SilentSink};
use goop_converter::{detect_encoders, ConversionBackend, FfmpegBackend};
use goop_core::{
    JobId, QualityPreset, TargetFormat, VideoAttempt, VideoEncoder, VideoSelectionContext,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[tokio::test]
#[ignore = "requires bundled FFmpeg sidecars"]
async fn bundled_ffmpeg_reports_completed_software_encode_and_video_copy() {
    let links = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let resolver = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&resolver);
    let encoders = Arc::new(detect_encoders(&resolver).await);
    let source = files.path().join("source.mp4");
    make_source(&ffmpeg, &source);

    let software_output = files.path().join("software.mp4");
    let mut software_request = request(&source, &software_output, TargetFormat::Mp4, None);
    software_request.quality_preset = Some(QualityPreset::Balanced);
    let software = FfmpegBackend::new(&resolver, Arc::new(SilentSink))
        .with_encoders(encoders.clone(), false)
        .convert(JobId::new(), &software_request, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        software.video_attempt,
        Some(VideoAttempt::Encode {
            encoder: VideoEncoder::Libx264,
            encode_attempt_ordinal: 1,
            selection_context: VideoSelectionContext::LegacyGlobalAtExecution {
                hw_acceleration_enabled: false,
            },
            fallback: None,
        })
    );

    let copy_output = files.path().join("copy.mp4");
    let copy_request = request(&source, &copy_output, TargetFormat::Mp4, None);
    let copy = FfmpegBackend::new(&resolver, Arc::new(SilentSink))
        .with_encoders(encoders, false)
        .convert(JobId::new(), &copy_request, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(copy.video_attempt, Some(VideoAttempt::Copy));
}
