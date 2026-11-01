#![cfg(unix)]
mod common;
use common::{executable::executable, request, SilentSink};
use goop_converter::{ConversionBackend, FfmpegBackend};
use goop_core::{CompressMode, GoopError, JobId, TargetFormat};
use goop_sidecar::BinaryResolver;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

fn fixture(
    script: &str,
) -> (
    tempfile::TempDir,
    BinaryResolver,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    for (name, body) in [("ffmpeg", script), ("ffprobe", "printf '%s' '{\"format\":{\"duration\":\"1\",\"size\":\"100\"},\"streams\":[{\"codec_type\":\"video\",\"codec_name\":\"h264\",\"width\":16,\"height\":16}]}'")] {
        executable(&bin.join(name), body);
    }
    let input = dir.path().join("in.mp4");
    std::fs::write(&input, b"source").unwrap();
    let output = dir.path().join("out.mp4");
    (dir, BinaryResolver::new(bin), input, output)
}

#[tokio::test]
async fn oversized_target_is_not_success() {
    let (_dir, r, input, output) = fixture("for out do :; done; printf '1234567890' > \"$out\"");
    let mut req = request(&input, &output, TargetFormat::Mp4, None);
    req.compress_mode = Some(CompressMode::TargetSizeBytes(5));
    let result = FfmpegBackend::new(&r, Arc::new(SilentSink))
        .convert(JobId::new(), &req, CancellationToken::new())
        .await;
    assert!(result.is_err());
    assert!(!output.exists());
}
#[tokio::test]
async fn failure_preserves_existing_destination() {
    let (_dir, r, input, output) =
        fixture("for out do :; done; printf 'partial' > \"$out\"; exit 1");
    std::fs::write(&output, b"original").unwrap();
    let result = FfmpegBackend::new(&r, Arc::new(SilentSink))
        .convert(
            JobId::new(),
            &request(&input, &output, TargetFormat::Mp4, None),
            CancellationToken::new(),
        )
        .await;
    assert!(result.is_err());
    assert_eq!(std::fs::read(output).unwrap(), b"original");
}
#[tokio::test]
async fn zero_exit_without_output_is_failure() {
    let (_dir, r, input, output) = fixture("exit 0");
    assert!(FfmpegBackend::new(&r, Arc::new(SilentSink))
        .convert(
            JobId::new(),
            &request(&input, &output, TargetFormat::Mp4, None),
            CancellationToken::new()
        )
        .await
        .is_err());
}
#[tokio::test(start_paused = true)]
async fn cancellation_after_stdout_eof_reaps_child() {
    let pids = tempfile::tempdir().unwrap();
    let pid_file = pids.path().join("ffmpeg.pid");
    let (_dir, r, input, output) = fixture(&format!(
        "exec 1>&-; {}",
        common::held_clock::script(&pid_file)
    ));
    let cancel = CancellationToken::new();
    let backend = FfmpegBackend::new(&r, Arc::new(SilentSink));
    let req = request(&input, &output, TargetFormat::Mp4, None);
    let result = common::held_clock::cancel(
        &pid_file,
        &cancel,
        backend.convert(JobId::new(), &req, cancel.clone()),
    )
    .await;
    assert!(matches!(result, Err(GoopError::Cancelled)));
    assert!(!output.exists());
}

#[tokio::test]
async fn successful_target_reports_actual_source_and_output_bytes() {
    let (_dir, r, input, output) = fixture("for out do :; done; printf '12345' > \"$out\"");
    let mut req = request(&input, &output, TargetFormat::Mp4, None);
    req.compress_mode = Some(CompressMode::TargetSizeBytes(5));
    let result = FfmpegBackend::new(&r, Arc::new(SilentSink))
        .convert(JobId::new(), &req, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.bytes, 5);
    assert_eq!(result.source_bytes, Some(6));
    assert_eq!(result.target_bytes, Some(5));
    assert_eq!(std::fs::metadata(output).unwrap().len(), result.bytes);
}
#[tokio::test]
async fn input_as_output_cannot_destroy_the_source() {
    let (_dir, r, input, _output) = fixture("for out do :; done; printf replacement > \"$out\"");
    let result = FfmpegBackend::new(&r, Arc::new(SilentSink))
        .convert(
            JobId::new(),
            &request(&input, &input, TargetFormat::Mp4, None),
            CancellationToken::new(),
        )
        .await;
    assert!(result.is_err());
    assert_eq!(std::fs::read(input).unwrap(), b"source");
}
#[tokio::test(start_paused = true)]
async fn large_stderr_is_bounded_and_drained() {
    let (_dir, r, input, output) = fixture(
        "dd if=/dev/zero bs=65536 count=8 >&2 2>/dev/null; printf '\\377\\377' >&2; exit 1",
    );
    let backend = FfmpegBackend::new(&r, Arc::new(SilentSink));
    let req = request(&input, &output, TargetFormat::Mp4, None);
    // An undrained stderr pipe would stall the child until the held clock's
    // liveness limit fails the run.
    let result =
        common::held_clock::hold(backend.convert(JobId::new(), &req, CancellationToken::new()))
            .await
            .unwrap_err();
    match result {
        GoopError::SubprocessFailed { stderr, .. } => assert!(stderr.len() <= 8196),
        other => panic!("unexpected {other}"),
    }
}

#[tokio::test]
async fn explicit_jpeg_collision_and_input_destination_preserve_originals() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.jpg");
    image::RgbImage::new(160, 120).save(&input).unwrap();
    let original = std::fs::read(&input).unwrap();
    let output = dir.path().join("out.jpg");
    std::fs::write(&output, b"destination").unwrap();
    let resolver = BinaryResolver::new(dir.path().to_owned());
    let backend = goop_converter::ImageMagickBackend::new(&resolver, Arc::new(SilentSink));
    for destination in [&output, &input] {
        let mut req = request(&input, destination, TargetFormat::Jpeg, None);
        req.image_options = Some(goop_core::ImageConvertOptions {
            jpeg_quality: 90,
            resize: goop_core::ImageResize::FitWithin {
                width: 80,
                height: 80,
            },
        });
        assert!(backend
            .convert(JobId::new(), &req, CancellationToken::new())
            .await
            .is_err());
        assert_eq!(std::fs::read(&input).unwrap(), original);
        assert_eq!(std::fs::read(&output).unwrap(), b"destination");
    }
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
}
