#![cfg(unix)]

use goop_converter::{
    capabilities::{inspect_source, inspect_source_with_encoders},
    encoders::DetectedEncoders,
};
use goop_core::GoopError;
use goop_sidecar::BinaryResolver;
use std::time::Duration;
#[cfg(not(target_os = "macos"))]
use std::{ffi::OsString, os::unix::ffi::OsStringExt};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};
use tokio_util::sync::CancellationToken;

const VALID_PROBE: &str = r#"{"format":{"duration":"1","size":"6","format_name":"matroska"},"streams":[{"index":0,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2,"channel_layout":"stereo","sample_fmt":"fltp","time_base":"1/48000","duration":"1","tags":{"title":"Main"},"disposition":{"default":1,"forced":0,"attached_pic":0}}]}"#;

fn fixture(script_body: &str) -> (tempfile::TempDir, BinaryResolver, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let ffprobe = directory.path().join("ffprobe");
    fs::write(&ffprobe, format!("#!/bin/sh\n{script_body}\n")).unwrap();
    fs::set_permissions(&ffprobe, fs::Permissions::from_mode(0o700)).unwrap();
    let source = directory.path().join("source.mkv");
    fs::write(&source, b"source").unwrap();
    let resolver = BinaryResolver::new(directory.path().to_path_buf());
    (directory, resolver, source)
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

#[tokio::test]
async fn bounded_probe_overflow_recovers_legacy_inspection_only() {
    let (_directory, resolver, source) = fixture(&fallback_script(
        "head -c 1052672 /dev/zero | tr '\\0' x\n  exit 0",
    ));
    let inspection = inspect_source(&resolver, &source).await.unwrap();
    assert_automatic_only(
        &inspection,
        "Audio track selection is unavailable because ffprobe exceeded its 1 MiB inspection output limit; use Automatic",
    );
}

#[tokio::test]
async fn bounded_probe_timeout_recovers_legacy_inspection_only() {
    let (_directory, resolver, source) = fixture(&fallback_script("exec sleep 20"));
    let inspection =
        inspect_source_with_encoders(&resolver, &source, &DetectedEncoders::from_names(["aac"]))
            .await
            .unwrap();
    assert_automatic_only(
        &inspection,
        "Audio track selection is unavailable because ffprobe exceeded its 5 second inspection deadline; use Automatic",
    );
}

#[tokio::test]
async fn repeated_probe_overflow_stays_bounded() {
    let (_directory, resolver, source) = fixture("exec head -c 1052672 /dev/zero");
    let error = inspect_source(&resolver, &source).await.unwrap_err();
    assert_eq!(
        error.user_message(),
        "ffprobe query exceeded its 1 MiB output limit"
    );
}

#[tokio::test]
async fn repeated_probe_timeout_stays_bounded() {
    let (_directory, resolver, source) = fixture("exec sleep 20");
    let result = tokio::time::timeout(Duration::from_secs(12), inspect_source(&resolver, &source))
        .await
        .expect("both inspection attempts must retain the five-second deadline");
    assert_eq!(
        result.unwrap_err().user_message(),
        "ffprobe query exceeded its 5 second deadline"
    );
}

#[tokio::test]
async fn explicit_track_probe_keeps_the_bounded_output_limit_strict() {
    let (_directory, resolver, source) = fixture("head -c 1052672 /dev/zero | tr '\\0' x");
    let error = goop_converter::track_options::probe_bound_source(
        &resolver,
        &source,
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.user_message(),
        "ffprobe query exceeded its 1 MiB output limit"
    );
}

#[tokio::test]
async fn explicit_track_probe_keeps_timeout_and_cancellation_strict() {
    let (_directory, resolver, source) = fixture("exec sleep 20");
    let error = goop_converter::track_options::probe_bound_source(
        &resolver,
        &source,
        &CancellationToken::new(),
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

#[tokio::test]
async fn ordinary_probe_and_missing_source_failures_are_not_recovered() {
    let (_directory, resolver, source) = fixture("printf 'ordinary probe failure' >&2\nexit 9");
    let error = inspect_source(&resolver, &source).await.unwrap_err();
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

#[tokio::test]
async fn pre_epoch_identity_recovers_legacy_inspection_only() {
    let (_directory, resolver, source) = fixture(&format!("printf '%s' '{VALID_PROBE}'"));
    let status = Command::new("touch")
        .args(["-t", "196912302359.59"])
        .arg(&source)
        .status()
        .unwrap();
    assert!(status.success());

    let inspection = inspect_source(&resolver, &source).await.unwrap();
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

#[tokio::test]
#[cfg(not(target_os = "macos"))]
async fn non_utf8_identity_recovers_legacy_inspection_only() {
    let (directory, resolver, _source) = fixture(&format!("printf '%s' '{VALID_PROBE}'"));
    let source = directory
        .path()
        .join(OsString::from_vec(b"source-\xff.mkv".to_vec()));
    fs::write(&source, b"source").unwrap();

    let inspection = inspect_source(&resolver, &source).await.unwrap();
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
