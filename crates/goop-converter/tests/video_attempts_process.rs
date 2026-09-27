#![cfg(unix)]

mod common;

use common::{request, SilentSink};
use goop_converter::{ConversionBackend, DetectedEncoders, FfmpegBackend};
use goop_core::publication::PublicationObserver;
use goop_core::{
    CompressMode, ConvertRequest, GoopError, JobId, JobResult, QualityPreset, TargetFormat,
    VideoAttempt, VideoEncoder, VideoFallback, VideoFallbackReason, VideoSelectionContext,
};
use goop_sidecar::BinaryResolver;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

struct Fixture {
    _directory: tempfile::TempDir,
    resolver: BinaryResolver,
    input: PathBuf,
    output: PathBuf,
    attempts: PathBuf,
    ffmpeg: PathBuf,
}

fn executable(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;

    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn fixture_with_probe(mode: &str, probe_json: &str) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let bin = directory.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let attempts = directory.path().join("attempts.txt");
    let script = format!(
        r#"
encoder=unknown
previous=
for argument in "$@"; do
  if [ "$previous" = "-c:v" ] || [ "$previous" = "-c" ]; then encoder="$argument"; fi
  previous="$argument"
  output="$argument"
done
printf '%s\n' "$encoder" >> '{}'
case '{}' in
  fallback) [ "$encoder" = h264_videotoolbox ] && exit 9 ;;
  fail) exit 9 ;;
  no_output) exit 0 ;;
  sleep) exec sleep 20 ;;
esac
printf 'encoded media' > "$output"
"#,
        attempts.display(),
        mode
    );
    let ffmpeg = bin.join("ffmpeg");
    executable(&ffmpeg, &script);
    executable(&bin.join("ffprobe"), &format!("printf '%s' '{probe_json}'"));
    let input = directory.path().join("in.mp4");
    std::fs::write(&input, b"source").unwrap();
    let output = directory.path().join("out.mp4");
    Fixture {
        resolver: BinaryResolver::new(bin),
        input,
        output,
        attempts,
        ffmpeg,
        _directory: directory,
    }
}

fn fixture(mode: &str) -> Fixture {
    fixture_with_probe(
        mode,
        r#"{"format":{"duration":"2.0","size":"4096"},"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":16,"height":16,"pix_fmt":"yuv420p","field_order":"progressive","sample_aspect_ratio":"1:1","avg_frame_rate":"24/1","r_frame_rate":"24/1","time_base":"1/24","start_time":"0.000000","duration":"2.000000","disposition":{"attached_pic":0}},{"index":1,"codec_type":"audio","codec_name":"aac","start_time":"0.000000","duration":"2.000000","disposition":{"attached_pic":0}}]}"#,
    )
}

fn attempted_encoders(fixture: &Fixture) -> Vec<String> {
    std::fs::read_to_string(&fixture.attempts)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn hardware_backend(fixture: &Fixture) -> FfmpegBackend<'_> {
    FfmpegBackend::new(&fixture.resolver, Arc::new(SilentSink)).with_encoders(
        Arc::new(DetectedEncoders::from_names([
            "libx264",
            "h264_videotoolbox",
        ])),
        true,
    )
}

fn encode_request(fixture: &Fixture) -> goop_core::ConvertRequest {
    let mut req = request(&fixture.input, &fixture.output, TargetFormat::Mp4, None);
    req.quality_preset = Some(QualityPreset::Balanced);
    req
}

#[tokio::test]
async fn hardware_first_success_reports_completed_encoder_without_fallback() {
    let fixture = fixture("success");
    let result = hardware_backend(&fixture)
        .convert(
            JobId::new(),
            &encode_request(&fixture),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(attempted_encoders(&fixture), ["h264_videotoolbox"]);
    assert_eq!(
        result.video_attempt,
        Some(VideoAttempt::Encode {
            encoder: VideoEncoder::H264Videotoolbox,
            encode_attempt_ordinal: 1,
            selection_context: VideoSelectionContext::LegacyGlobalAtExecution {
                hw_acceleration_enabled: true,
            },
            fallback: None,
        })
    );
}

#[tokio::test]
async fn zero_progress_hardware_failure_then_software_success_reports_fallback() {
    let fixture = fixture("fallback");
    let result = hardware_backend(&fixture)
        .convert(
            JobId::new(),
            &encode_request(&fixture),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(
        attempted_encoders(&fixture),
        ["h264_videotoolbox", "libx264"]
    );
    assert_eq!(
        result.video_attempt,
        Some(VideoAttempt::Encode {
            encoder: VideoEncoder::Libx264,
            encode_attempt_ordinal: 2,
            selection_context: VideoSelectionContext::LegacyGlobalAtExecution {
                hw_acceleration_enabled: true,
            },
            fallback: Some(VideoFallback {
                from_encoder: VideoEncoder::H264Videotoolbox,
                reason: VideoFallbackReason::HardwareAttemptSubprocessFailed,
            }),
        })
    );
}

#[tokio::test]
async fn both_encoder_attempts_fail_without_a_success_receipt() {
    let fixture = fixture("fail");
    let result = hardware_backend(&fixture)
        .convert(
            JobId::new(),
            &encode_request(&fixture),
            CancellationToken::new(),
        )
        .await;

    assert!(matches!(result, Err(GoopError::SubprocessFailed { .. })));
    assert_eq!(
        attempted_encoders(&fixture),
        ["h264_videotoolbox", "libx264"]
    );
    assert!(!fixture.output.exists());
}

#[tokio::test]
async fn unknown_no_video_action_keeps_existing_fallback_without_fabricating_receipt() {
    let fixture = fixture_with_probe(
        "fallback",
        r#"{"format":{"duration":"2.0","size":"4096"},"streams":[{"index":0,"codec_type":"audio","codec_name":"aac","start_time":"0.000000","duration":"2.000000","disposition":{"attached_pic":0}}]}"#,
    );
    let result = hardware_backend(&fixture)
        .convert(
            JobId::new(),
            &encode_request(&fixture),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(
        attempted_encoders(&fixture),
        ["h264_videotoolbox", "libx264"]
    );
    assert_eq!(result.video_attempt, None);
}

#[tokio::test]
async fn successful_process_with_invalid_output_does_not_retry() {
    let fixture = fixture("no_output");
    let result = hardware_backend(&fixture)
        .convert(
            JobId::new(),
            &encode_request(&fixture),
            CancellationToken::new(),
        )
        .await;

    assert!(result.is_err());
    assert_eq!(attempted_encoders(&fixture), ["h264_videotoolbox"]);
    assert!(!fixture.output.exists());
}

#[tokio::test]
async fn target_size_validation_failure_does_not_retry() {
    let fixture = fixture("success");
    let mut req = encode_request(&fixture);
    req.quality_preset = None;
    req.compress_mode = Some(CompressMode::TargetSizeBytes(5));
    let result = hardware_backend(&fixture)
        .convert(JobId::new(), &req, CancellationToken::new())
        .await;

    assert!(result.is_err());
    assert_eq!(attempted_encoders(&fixture), ["h264_videotoolbox"]);
    assert!(!fixture.output.exists());
}

#[tokio::test]
async fn spawn_io_failure_does_not_retry() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = fixture("success");
    std::fs::set_permissions(&fixture.ffmpeg, std::fs::Permissions::from_mode(0o644)).unwrap();
    let result = hardware_backend(&fixture)
        .convert(
            JobId::new(),
            &encode_request(&fixture),
            CancellationToken::new(),
        )
        .await;

    assert!(matches!(result, Err(GoopError::Io(_))));
    assert!(attempted_encoders(&fixture).is_empty());
    assert!(!fixture.output.exists());
}

#[tokio::test]
async fn cancellation_does_not_retry() {
    let fixture = fixture("sleep");
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        trigger.cancel();
    });
    let result = hardware_backend(&fixture)
        .convert(JobId::new(), &encode_request(&fixture), cancel)
        .await;

    assert!(matches!(result, Err(GoopError::Cancelled)));
    assert_eq!(attempted_encoders(&fixture), ["h264_videotoolbox"]);
    assert!(!fixture.output.exists());
}

struct FailIntent;

impl PublicationObserver for FailIntent {
    fn before_publish(&self, _: &Path, _: &Path, _: &JobResult) -> Result<(), GoopError> {
        Err(GoopError::Queue("intent write refused".into()))
    }

    fn published(&self, _: &Path, _: &JobResult) -> Result<(), GoopError> {
        panic!("a refused intent must not publish")
    }
}

#[tokio::test]
async fn publication_failure_does_not_retry_encoder() {
    let fixture = fixture("success");
    let result = hardware_backend(&fixture)
        .with_publication_observer(Arc::new(FailIntent))
        .convert(
            JobId::new(),
            &encode_request(&fixture),
            CancellationToken::new(),
        )
        .await;

    assert!(matches!(result, Err(GoopError::Queue(_))));
    assert_eq!(attempted_encoders(&fixture), ["h264_videotoolbox"]);
    assert!(!fixture.output.exists());
}

#[derive(Default)]
struct RecordingObserver {
    intent: Mutex<Option<JobResult>>,
    published: Mutex<Option<JobResult>>,
}

impl PublicationObserver for RecordingObserver {
    fn before_publish(&self, _: &Path, _: &Path, result: &JobResult) -> Result<(), GoopError> {
        *self.intent.lock().unwrap() = Some(result.clone());
        Ok(())
    }

    fn published(&self, _: &Path, result: &JobResult) -> Result<(), GoopError> {
        *self.published.lock().unwrap() = Some(result.clone());
        Ok(())
    }
}

#[tokio::test]
async fn completed_attempt_is_frozen_before_publication() {
    let fixture = fixture("fallback");
    let observer = Arc::new(RecordingObserver::default());
    let result = hardware_backend(&fixture)
        .with_publication_observer(observer.clone())
        .convert(
            JobId::new(),
            &encode_request(&fixture),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let expected = goop_converter::backend::conversion_job_result(&result);

    assert_eq!(observer.intent.lock().unwrap().as_ref(), Some(&expected));
    assert_eq!(observer.published.lock().unwrap().as_ref(), Some(&expected));
    assert!(matches!(
        expected.video_attempt,
        Some(VideoAttempt::Encode {
            encode_attempt_ordinal: 2,
            fallback: Some(_),
            ..
        })
    ));
}

#[tokio::test]
async fn enabled_hardware_with_no_selected_encoder_is_not_fallback() {
    let fixture = fixture("success");
    let result = FfmpegBackend::new(&fixture.resolver, Arc::new(SilentSink))
        .with_encoders(Arc::new(DetectedEncoders::from_names(["libx264"])), true)
        .convert(
            JobId::new(),
            &encode_request(&fixture),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(attempted_encoders(&fixture), ["libx264"]);
    assert_eq!(
        result.video_attempt,
        Some(VideoAttempt::Encode {
            encoder: VideoEncoder::Libx264,
            encode_attempt_ordinal: 1,
            selection_context: VideoSelectionContext::LegacyGlobalAtExecution {
                hw_acceleration_enabled: true,
            },
            fallback: None,
        })
    );
}

#[tokio::test]
async fn explicit_software_reports_explicit_context_and_bypasses_hardware() {
    let fixture = fixture("success");
    let req: ConvertRequest = serde_json::from_value(json!({
        "input_path": fixture.input,
        "output_path": fixture.output,
        "target": "mp4",
        "video_options": {
            "kind": "encode",
            "codec": "h264",
            "rate_control": {"kind": "constant_quality", "crf": 23},
            "speed": "medium",
            "processor": "software"
        }
    }))
    .unwrap();
    let result = hardware_backend(&fixture)
        .convert(JobId::new(), &req, CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(attempted_encoders(&fixture), ["libx264"]);
    assert_eq!(
        result.video_attempt,
        Some(VideoAttempt::Encode {
            encoder: VideoEncoder::Libx264,
            encode_attempt_ordinal: 1,
            selection_context: VideoSelectionContext::ExplicitSoftware,
            fallback: None,
        })
    );
}

#[tokio::test]
async fn video_copy_reports_copy_without_encoder_details() {
    let fixture = fixture("success");
    let req = request(&fixture.input, &fixture.output, TargetFormat::Mp4, None);
    let result = hardware_backend(&fixture)
        .convert(JobId::new(), &req, CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(attempted_encoders(&fixture), ["copy"]);
    assert_eq!(result.video_attempt, Some(VideoAttempt::Copy));
}
