#![cfg(unix)]
mod common;

use common::executable::{executable, EXEC_PROBE_ARG};
use common::held_clock;
use goop_converter::{
    capabilities::{inspect_source, inspect_source_with_encoders},
    encoders::DetectedEncoders,
};
use goop_core::GoopError;
use goop_sidecar::BinaryResolver;
#[cfg(not(target_os = "macos"))]
use std::{ffi::OsString, os::unix::ffi::OsStringExt};
use std::{fs, path::Path, process::Command};
use tokio_util::sync::CancellationToken;

const VALID_PROBE: &str = r#"{"format":{"duration":"1","size":"6","format_name":"matroska"},"streams":[{"index":0,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2,"channel_layout":"stereo","sample_fmt":"fltp","time_base":"1/48000","duration":"1","tags":{"title":"Main"},"disposition":{"default":1,"forced":0,"attached_pic":0}}]}"#;

fn fixture(script_body: &str) -> (tempfile::TempDir, BinaryResolver, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    executable(&directory.path().join("ffprobe"), script_body);
    let source = directory.path().join("source.mkv");
    fs::write(&source, b"source").unwrap();
    let resolver = BinaryResolver::new(directory.path().to_path_buf());
    (directory, resolver, source)
}

#[test]
fn readiness_probe_preserves_the_first_inspection_attempt() {
    let (directory, _resolver, _source) =
        fixture(&fallback_script("printf 'first-attempt' >&2\n  exit 9"));
    let binary = directory.path().join("ffprobe");
    let state = directory.path().join("ffprobe.state");
    let readiness = Command::new(&binary).arg(EXEC_PROBE_ARG).output().unwrap();
    assert!(readiness.status.success());
    assert!(readiness.stdout.is_empty());
    assert!(readiness.stderr.is_empty());
    assert!(!state.exists(), "readiness must not consume fallback state");

    let first = Command::new(&binary).arg("actual-probe").output().unwrap();
    assert_eq!(first.status.code(), Some(9));
    assert_eq!(first.stderr, b"first-attempt");
    assert!(state.exists());
    let second = Command::new(&binary).arg("actual-probe").output().unwrap();
    assert!(second.status.success());
    assert_eq!(second.stdout, VALID_PROBE.as_bytes());
}

fn fallback_script(first_attempt: &str) -> String {
    format!(
        r#"state="$0.state"
if [ ! -f "$state" ]; then
  : > "$state"
  {first_attempt}
fi
printf '%s' '{VALID_PROBE}'"#
    )
}

fn assert_automatic_only(inspection: &goop_core::ConversionInspection, reason: &str) {
    assert!(inspection.probe.has_audio);
    assert!(inspection.track_source.is_none());
    assert_eq!(
        inspection.track_source_unavailable_reason.as_deref(),
        Some(reason)
    );
    assert!(inspection
        .capabilities
        .targets
        .iter()
        .all(|target| target.track_settings.is_none()));
}

/// A pid file for an armed stand-in. It gets a directory of its own because
/// the fixture's directory does not exist until its script has been written.
fn pid_file() -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let pid_file = directory.path().join("ffprobe.pid");
    (directory, pid_file)
}

#[tokio::test(start_paused = true)]
async fn bounded_probe_overflow_recovers_legacy_inspection_only() {
    let (_directory, resolver, source) = fixture(&fallback_script(
        "head -c 1052672 /dev/zero | tr '\\0' x\n  exit 0",
    ));
    let inspection = held_clock::hold(inspect_source(&resolver, &source))
        .await
        .unwrap();
    assert_automatic_only(
        &inspection,
        "Audio track selection is unavailable because ffprobe exceeded its 1 MiB inspection output limit; use Automatic",
    );
}

#[tokio::test(start_paused = true)]
async fn bounded_probe_timeout_recovers_legacy_inspection_only() {
    let (_pids, pid_file) = pid_file();
    let (_directory, resolver, source) = fixture(&fallback_script(&held_clock::script(&pid_file)));
    let inspection = held_clock::expire(
        &pid_file,
        1,
        inspect_source_with_encoders(&resolver, &source, &DetectedEncoders::from_names(["aac"])),
    )
    .await
    .unwrap();
    assert_automatic_only(
        &inspection,
        "Audio track selection is unavailable because ffprobe exceeded its 5 second inspection deadline; use Automatic",
    );
}

#[tokio::test(start_paused = true)]
async fn repeated_probe_overflow_stays_bounded() {
    let (_directory, resolver, source) = fixture("exec head -c 1052672 /dev/zero");
    let error = held_clock::hold(inspect_source(&resolver, &source))
        .await
        .unwrap_err();
    assert_eq!(
        error.user_message(),
        "ffprobe query exceeded its 1 MiB output limit"
    );
}

#[tokio::test(start_paused = true)]
async fn repeated_probe_timeout_stays_bounded() {
    let (_pids, pid_file) = pid_file();
    let (_directory, resolver, source) = fixture(&held_clock::script(&pid_file));
    // Both inspection attempts must retain the five-second deadline: without
    // one, the second attempt's child outlives the held clock's liveness limit.
    let error = held_clock::expire(&pid_file, 2, inspect_source(&resolver, &source))
        .await
        .unwrap_err();
    assert_eq!(
        error.user_message(),
        "ffprobe query exceeded its 5 second deadline"
    );
}

#[tokio::test(start_paused = true)]
async fn explicit_track_probe_keeps_the_bounded_output_limit_strict() {
    let (_directory, resolver, source) = fixture("head -c 1052672 /dev/zero | tr '\\0' x");
    let error = held_clock::hold(goop_converter::track_options::probe_bound_source(
        &resolver,
        &source,
        &CancellationToken::new(),
    ))
    .await
    .unwrap_err();
    assert_eq!(
        error.user_message(),
        "ffprobe query exceeded its 1 MiB output limit"
    );
}

#[tokio::test(start_paused = true)]
async fn explicit_track_probe_keeps_timeout_and_cancellation_strict() {
    let (_pids, pid_file) = pid_file();
    let (_directory, resolver, source) = fixture(&held_clock::script(&pid_file));
    let error = held_clock::expire(
        &pid_file,
        1,
        goop_converter::track_options::probe_bound_source(
            &resolver,
            &source,
            &CancellationToken::new(),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.user_message(),
        "ffprobe query exceeded its 5 second deadline"
    );

    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = goop_converter::track_options::probe_bound_source(&resolver, &source, &cancel)
        .await
        .unwrap_err();
    assert!(matches!(error, GoopError::Cancelled));
}

#[tokio::test(start_paused = true)]
async fn ordinary_probe_and_missing_source_failures_are_not_recovered() {
    let (_directory, resolver, source) = fixture("printf 'ordinary probe failure' >&2\nexit 9");
    let error = held_clock::hold(inspect_source(&resolver, &source))
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GoopError::SubprocessFailed { ref binary, ref stderr }
            if binary == "ffprobe" && stderr.contains("ordinary probe failure")
    ));

    let missing = source.with_file_name("missing.mkv");
    let error = inspect_source(&resolver, Path::new(&missing))
        .await
        .unwrap_err();
    assert!(matches!(error, GoopError::InvalidRequest(_)));
}

#[tokio::test(start_paused = true)]
async fn pre_epoch_identity_recovers_legacy_inspection_only() {
    let (_directory, resolver, source) = fixture(&format!("printf '%s' '{VALID_PROBE}'"));
    let status = Command::new("touch")
        .args(["-t", "196912302359.59"])
        .arg(&source)
        .status()
        .unwrap();
    assert!(status.success());

    let inspection = held_clock::hold(inspect_source(&resolver, &source))
        .await
        .unwrap();
    assert_automatic_only(
        &inspection,
        "Audio track selection is unavailable because the source modification time predates 1970; use Automatic",
    );
    let error = goop_converter::track_options::probe_bound_source(
        &resolver,
        &source,
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert!(error.user_message().contains("pre-epoch"));
}

#[tokio::test(start_paused = true)]
#[cfg(not(target_os = "macos"))]
async fn non_utf8_identity_recovers_legacy_inspection_only() {
    let (directory, resolver, _source) = fixture(&format!("printf '%s' '{VALID_PROBE}'"));
    let source = directory
        .path()
        .join(OsString::from_vec(b"source-\xff.mkv".to_vec()));
    fs::write(&source, b"source").unwrap();

    let inspection = held_clock::hold(inspect_source(&resolver, &source))
        .await
        .unwrap();
    assert_automatic_only(
        &inspection,
        "Audio track selection is unavailable because the canonical source path is not valid UTF-8; use Automatic",
    );
    let error = goop_converter::track_options::probe_bound_source(
        &resolver,
        &source,
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert!(error.user_message().contains("UTF-8"));
}
