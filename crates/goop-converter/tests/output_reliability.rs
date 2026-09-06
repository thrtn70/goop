#![cfg(unix)]
mod common;
use common::{request, SilentSink};
use goop_converter::{ConversionBackend, FfmpegBackend};
use goop_core::{CompressMode, GoopError, JobId, TargetFormat};
use goop_sidecar::BinaryResolver;
use std::{os::unix::fs::PermissionsExt, sync::Arc};
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
        let p = bin.join(name); std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap(); std::fs::set_permissions(p,std::fs::Permissions::from_mode(0o755)).unwrap();
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
#[tokio::test]
async fn cancellation_after_stdout_eof_reaps_child() {
    let (_dir, r, input, output) = fixture("exec 1>&-; exec sleep 20");
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        trigger.cancel();
    });
    let backend = FfmpegBackend::new(&r, Arc::new(SilentSink));
    let req = request(&input, &output, TargetFormat::Mp4, None);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        backend.convert(JobId::new(), &req, cancel),
    )
    .await;
    assert!(matches!(result, Ok(Err(GoopError::Cancelled))));
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
#[tokio::test]
async fn large_stderr_is_bounded_and_drained() {
    let (_dir, r, input, output) = fixture(
        "dd if=/dev/zero bs=65536 count=8 >&2 2>/dev/null; printf '\\377\\377' >&2; exit 1",
    );
    let backend = FfmpegBackend::new(&r, Arc::new(SilentSink));
    let req = request(&input, &output, TargetFormat::Mp4, None);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        backend.convert(JobId::new(), &req, CancellationToken::new()),
    )
    .await
    .unwrap()
    .unwrap_err();
    match result {
        GoopError::SubprocessFailed { stderr, .. } => assert!(stderr.len() <= 8196),
        other => panic!("unexpected {other}"),
    }
}
