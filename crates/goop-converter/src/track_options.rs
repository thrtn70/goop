use crate::{backend::ConversionBackend, encoders::DetectedEncoders};
use goop_core::{
    AudioStreamInfo, ConvertRequest, GoopError, ProbeResult, TargetFormat, TrackChoiceCapability,
    TrackConvertOptions, TrackExecutionSummary, TrackSettingsCapabilities, TrackSourceBinding,
    TRACK_SOURCE_BINDING_VERSION,
};
use goop_sidecar::BinaryResolver;
use std::future::Future;
use std::path::Path;
use std::time::UNIX_EPOCH;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceSnapshot {
    canonical_path: String,
    size_bytes: String,
    modified_unix_ns: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceIdentityLimit {
    PreEpochModified,
    ModifiedOutOfRange,
    NonUtf8CanonicalPath,
}

impl SourceIdentityLimit {
    fn strict_error(self) -> GoopError {
        invalid(match self {
            Self::PreEpochModified => {
                "Track selection does not support pre-epoch modification times"
            }
            Self::ModifiedOutOfRange => "Source modification time is outside the supported range",
            Self::NonUtf8CanonicalPath => "Track selection requires a UTF-8 source path",
        })
    }

    fn unavailable_reason(self) -> &'static str {
        match self {
            Self::PreEpochModified => {
                "Audio track selection is unavailable because the source modification time predates 1970; use Automatic"
            }
            Self::ModifiedOutOfRange => {
                "Audio track selection is unavailable because the source modification time is outside the supported range; use Automatic"
            }
            Self::NonUtf8CanonicalPath => {
                "Audio track selection is unavailable because the canonical source path is not valid UTF-8; use Automatic"
            }
        }
    }
}

#[derive(Debug)]
enum SnapshotError {
    IdentityLimit(SourceIdentityLimit),
    Fatal(GoopError),
}

impl SnapshotError {
    fn into_strict_error(self) -> GoopError {
        match self {
            Self::IdentityLimit(limit) => limit.strict_error(),
            Self::Fatal(error) => error,
        }
    }
}

fn invalid(message: impl Into<String>) -> GoopError {
    GoopError::InvalidRequest(message.into())
}

async fn snapshot(path: &Path) -> Result<SourceSnapshot, SnapshotError> {
    let canonical = tokio::fs::canonicalize(path).await.map_err(|error| {
        SnapshotError::Fatal(invalid(format!(
            "Could not inspect source {}: {error}",
            path.display()
        )))
    })?;
    let metadata = tokio::fs::metadata(&canonical).await.map_err(|error| {
        SnapshotError::Fatal(invalid(format!(
            "Could not inspect source {}: {error}",
            canonical.display()
        )))
    })?;
    if !metadata.is_file() {
        return Err(SnapshotError::Fatal(invalid(format!(
            "Track selection requires a file source: {}",
            path.display()
        ))));
    }
    let modified = metadata.modified().map_err(|error| {
        SnapshotError::Fatal(invalid(format!(
            "Could not read source modification time for {}: {error}",
            canonical.display()
        )))
    })?;
    let modified_ns = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SnapshotError::IdentityLimit(SourceIdentityLimit::PreEpochModified))?
        .as_nanos();
    let modified_ns = u64::try_from(modified_ns)
        .map_err(|_| SnapshotError::IdentityLimit(SourceIdentityLimit::ModifiedOutOfRange))?;
    let canonical_path = canonical
        .to_str()
        .ok_or(SnapshotError::IdentityLimit(
            SourceIdentityLimit::NonUtf8CanonicalPath,
        ))?
        .to_owned();

    Ok(SourceSnapshot {
        canonical_path,
        size_bytes: metadata.len().to_string(),
        modified_unix_ns: modified_ns.to_string(),
    })
}

fn binding_from_snapshot(
    snapshot: SourceSnapshot,
    probe: &ProbeResult,
) -> Result<Option<TrackSourceBinding>, GoopError> {
    let Some(inventory) = probe.track_inventory.clone() else {
        return Ok(None);
    };
    if inventory_has_malformed_identity(&inventory) {
        return Ok(None);
    }
    let binding = TrackSourceBinding {
        version: TRACK_SOURCE_BINDING_VERSION,
        canonical_path: snapshot.canonical_path,
        size_bytes: snapshot.size_bytes,
        modified_unix_ns: snapshot.modified_unix_ns,
        inventory,
    };
    if serde_json::to_vec(&binding)?.len() > goop_core::MAX_TRACK_SOURCE_BINDING_BYTES {
        return Ok(None);
    }
    goop_core::validate_track_source_binding(&binding)?;
    Ok(Some(binding))
}

fn inventory_has_malformed_identity(inventory: &goop_core::TrackInventory) -> bool {
    inventory.streams.iter().any(|stream| {
        [
            &stream.codec_name,
            &stream.container_stream_id,
            &stream.language,
            &stream.title,
        ]
        .into_iter()
        .any(|fact| matches!(fact, goop_core::TrackTextFact::Malformed))
            || stream.disposition.malformed
    })
}

/// Explain why a probe with audio cannot publish an explicit-selection binding.
///
/// A missing inventory, malformed identity, or aggregate binding overflow keeps
/// legacy Automatic conversion usable while disabling explicit track settings.
pub fn source_unavailable_reason(
    probe: &ProbeResult,
    binding: Option<&TrackSourceBinding>,
) -> Option<&'static str> {
    if !probe.has_audio || binding.is_some() {
        return None;
    }
    let Some(inventory) = probe.track_inventory.as_ref() else {
        return Some(
            "Audio track selection requires a complete bounded stream inventory; reinspect the source or use Automatic",
        );
    };
    if inventory_has_malformed_identity(inventory) {
        return Some(
            "Audio track selection is unavailable because the source reported malformed stream identity; use Automatic",
        );
    }
    Some(
        "Audio track selection is unavailable because the source binding exceeds the 64 KiB safety limit; use Automatic",
    )
}

async fn probe_bound_source_with<F>(
    path: &Path,
    probe_future: F,
) -> Result<(ProbeResult, Option<TrackSourceBinding>), GoopError>
where
    F: Future<Output = Result<ProbeResult, GoopError>>,
{
    let before = snapshot(path)
        .await
        .map_err(SnapshotError::into_strict_error)?;
    let probe = probe_future.await?;
    let after = snapshot(path)
        .await
        .map_err(SnapshotError::into_strict_error)?;
    if before != after {
        return Err(invalid(
            "The source changed during inspection; reinspect it before selecting a track",
        ));
    }
    let binding = binding_from_snapshot(after, &probe)?;
    Ok((probe, binding))
}

async fn legacy_inspection_after_limit(
    resolver: &BinaryResolver,
    path: &Path,
    reason: &'static str,
    cancel: &CancellationToken,
) -> Result<
    (
        ProbeResult,
        Option<TrackSourceBinding>,
        Option<&'static str>,
    ),
    GoopError,
> {
    let probe = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(GoopError::Cancelled),
        probe = crate::FfmpegBackend::probe(resolver, path) => probe?,
    };
    let reason = probe.has_audio.then_some(reason);
    Ok((probe, None, reason))
}

pub(crate) async fn probe_bound_source_for_inspection(
    resolver: &BinaryResolver,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<
    (
        ProbeResult,
        Option<TrackSourceBinding>,
        Option<&'static str>,
    ),
    GoopError,
> {
    let before = match snapshot(path).await {
        Ok(snapshot) => snapshot,
        Err(SnapshotError::IdentityLimit(limit)) => {
            return legacy_inspection_after_limit(
                resolver,
                path,
                limit.unavailable_reason(),
                cancel,
            )
            .await;
        }
        Err(SnapshotError::Fatal(error)) => return Err(error),
    };
    let probe = match crate::FfmpegBackend::probe_with_cancel(resolver, path, cancel).await {
        Ok(probe) => probe,
        Err(error) => {
            let reason = match crate::bounded_process::query_limit(&error, "ffprobe") {
                Some(crate::bounded_process::QueryLimit::Output) => {
                    "Audio track selection is unavailable because ffprobe exceeded its 1 MiB inspection output limit; use Automatic"
                }
                Some(crate::bounded_process::QueryLimit::Deadline) => {
                    "Audio track selection is unavailable because ffprobe exceeded its 5 second inspection deadline; use Automatic"
                }
                None => return Err(error),
            };
            return legacy_inspection_after_limit(resolver, path, reason, cancel).await;
        }
    };
    let after = match snapshot(path).await {
        Ok(snapshot) => snapshot,
        Err(SnapshotError::IdentityLimit(limit)) => {
            let reason = probe.has_audio.then_some(limit.unavailable_reason());
            return Ok((probe, None, reason));
        }
        Err(SnapshotError::Fatal(error)) => return Err(error),
    };
    if before != after {
        return Err(invalid(
            "The source changed during inspection; reinspect it before selecting a track",
        ));
    }
    let binding = binding_from_snapshot(after, &probe)?;
    let reason = source_unavailable_reason(&probe, binding.as_ref());
    Ok((probe, binding, reason))
}

/// Probe a source and bind its complete track inventory to stable file identity.
///
/// Unlike inspection enrichment, this explicit path is strict: bounded-query
/// limits and unsupported file identity are returned as errors.
pub async fn probe_bound_source(
    resolver: &BinaryResolver,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<(ProbeResult, Option<TrackSourceBinding>), GoopError> {
    probe_bound_source_with(
        path,
        crate::FfmpegBackend::probe_with_cancel(resolver, path, cancel),
    )
    .await
}

/// Require an exact match between a previously admitted binding and fresh facts.
pub fn verify_source_binding(
    expected: &TrackSourceBinding,
    actual: Option<&TrackSourceBinding>,
) -> Result<(), GoopError> {
    goop_core::validate_track_source_binding(expected)?;
    if actual != Some(expected) {
        return Err(invalid(
            "The source changed after track selection; reinspect it and choose the track again",
        ));
    }
    Ok(())
}

fn selected_track<'a>(
    request: &'a ConvertRequest,
    probe: &'a ProbeResult,
) -> Result<Option<(&'a TrackConvertOptions, &'a goop_core::TrackIdentity)>, GoopError> {
    let Some(
        options @ TrackConvertOptions::Audio {
            source,
            stream_index,
        },
    ) = request.track_options.as_ref()
    else {
        return Ok(None);
    };

    goop_core::validate_track_request(request)?;
    let inventory = probe.track_inventory.as_ref().ok_or_else(|| {
        invalid("Fresh track identity is unavailable; reinspect the source before converting")
    })?;
    if inventory != &source.inventory {
        return Err(invalid(
            "The source track inventory changed; reinspect it and choose the track again",
        ));
    }
    let selected = inventory
        .streams
        .iter()
        .find(|stream| stream.index == *stream_index && stream.codec_type == "audio")
        .ok_or_else(|| {
            invalid("The selected audio track is no longer present; reinspect the source")
        })?;
    Ok(Some((options, selected)))
}

/// Resolve an explicit selection into its verified execution disclosure.
pub fn resolve(
    request: &ConvertRequest,
    probe: &ProbeResult,
) -> Result<Option<TrackExecutionSummary>, GoopError> {
    let Some((requested, selected)) = selected_track(request, probe)? else {
        return Ok(None);
    };
    let TrackConvertOptions::Audio { source, .. } = requested else {
        return Ok(None);
    };
    let inventory = &source.inventory;
    let dropped_audio = inventory
        .streams
        .iter()
        .filter(|stream| stream.codec_type == "audio" && stream.index != selected.index)
        .cloned()
        .collect::<Vec<_>>();
    let dropped_other = inventory
        .streams
        .iter()
        .filter(|stream| stream.codec_type != "audio")
        .cloned()
        .collect::<Vec<_>>();
    let mut notices = Vec::new();
    if !dropped_audio.is_empty() {
        notices.push(format!(
            "{} additional audio {} omitted",
            dropped_audio.len(),
            if dropped_audio.len() == 1 {
                "stream was"
            } else {
                "streams were"
            }
        ));
    }
    if !dropped_other.is_empty() {
        notices.push(format!(
            "{} non-audio {} omitted",
            dropped_other.len(),
            if dropped_other.len() == 1 {
                "stream was"
            } else {
                "streams were"
            }
        ));
    }

    Ok(Some(TrackExecutionSummary {
        requested: requested.clone(),
        selected: selected.clone(),
        dropped_audio,
        dropped_other,
        output_stream_index: 0,
        notices,
    }))
}

/// Return borrowed processing facts for the exact selected audio stream.
pub fn selected_audio_stream<'a>(
    request: &ConvertRequest,
    probe: &'a ProbeResult,
) -> Result<&'a AudioStreamInfo, GoopError> {
    let details = probe.audio_details.as_ref().ok_or_else(|| {
        invalid("Explicit audio settings require complete fresh audio stream facts")
    })?;
    let Some((_, selected)) = selected_track(request, probe)? else {
        if details.streams.len() != 1 {
            return Err(invalid(
                "Choose Automatic until an audio track has been selected",
            ));
        }
        return Ok(&details.streams[0]);
    };

    details
        .streams
        .iter()
        .find(|stream| stream.index == selected.index)
        .ok_or_else(|| {
            invalid("Fresh processing facts for the selected audio track are unavailable; reinspect the source")
        })
}

/// Compute per-track Copy and Custom availability from one validated binding.
pub fn settings(
    probe: &ProbeResult,
    target: TargetFormat,
    encoders: &DetectedEncoders,
    source: &TrackSourceBinding,
) -> Result<TrackSettingsCapabilities, GoopError> {
    goop_core::validate_track_source_binding(source)?;
    if probe.track_inventory.as_ref() != Some(&source.inventory) {
        return Err(invalid(
            "Track capabilities require a binding from the same fresh inspection",
        ));
    }
    let mut audio_choices = Vec::new();
    let audio_details = probe.audio_details.as_ref();
    for track in source
        .inventory
        .streams
        .iter()
        .filter(|track| track.codec_type == "audio")
    {
        let stream = audio_details.and_then(|details| {
            details
                .streams
                .iter()
                .find(|stream| stream.index == track.index)
        });
        let (copy, encode) =
            crate::audio_options::mode_availability_for_stream(stream, target, encoders);
        audio_choices.push(TrackChoiceCapability {
            track: track.clone(),
            copy,
            encode,
        });
    }
    Ok(TrackSettingsCapabilities {
        source: source.clone(),
        audio_choices,
    })
}

/// Verify that completed output contains only the disclosed selected audio stream.
pub fn validate_output_against_selection(
    expected: &TrackExecutionSummary,
    actual: &ProbeResult,
) -> Result<(), GoopError> {
    let details = actual.audio_details.as_ref().ok_or_else(|| {
        invalid("Completed selected-track output did not contain verified audio facts")
    })?;
    if details.streams.len() != 1
        || details.has_non_audio_streams
        || details.streams[0].index != expected.output_stream_index
    {
        return Err(invalid(
            "Completed selected-track output did not contain exactly the disclosed audio stream",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use goop_core::{SourceKind, TrackInventory};
    use std::fs;

    fn probe() -> ProbeResult {
        ProbeResult {
            video_details: None,
            duration_ms: 0,
            width: None,
            height: None,
            video_codec: None,
            audio_codec: None,
            file_size: 0,
            container: None,
            has_video: false,
            has_audio: false,
            source_kind: SourceKind::Audio,
            color_space: None,
            image_format: None,
            has_subtitles: false,
            subtitle_codecs: vec![],
            audio_codecs: vec![],
            image_has_alpha: None,
            audio_details: None,
            track_inventory: Some(TrackInventory {
                version: goop_core::TRACK_INVENTORY_VERSION,
                streams: vec![],
            }),
        }
    }

    fn audio_probe() -> ProbeResult {
        crate::parse_probe_json(
            br#"{"format":{"size":"6"},"streams":[{"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2},{"index":3,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2}]}"#,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn changed_file_facts_cannot_finish_the_same_inspection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.mkv");
        fs::write(&path, b"first").unwrap();
        let result = probe_bound_source_with(&path, async {
            tokio::fs::write(&path, b"longer replacement")
                .await
                .unwrap();
            Ok(probe())
        })
        .await;
        assert!(result.unwrap_err().user_message().contains("reinspect"));
    }

    #[tokio::test]
    async fn source_binding_uses_canonical_decimal_file_facts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.mkv");
        fs::write(&path, b"source").unwrap();
        let source = binding_from_snapshot(snapshot(&path).await.unwrap(), &probe())
            .unwrap()
            .unwrap();
        assert_eq!(source.size_bytes, "6");
        assert_source_binding_is_canonical(&source);
    }

    fn assert_source_binding_is_canonical(source: &TrackSourceBinding) {
        assert!(source.size_bytes.bytes().all(|byte| byte.is_ascii_digit()));
        assert!(source
            .modified_unix_ns
            .bytes()
            .all(|byte| byte.is_ascii_digit()));
        assert!(Path::new(&source.canonical_path).is_absolute());
        goop_core::validate_track_source_binding(source).unwrap();
    }
    #[tokio::test]
    async fn mismatched_binding_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.mkv");
        fs::write(&path, b"source").unwrap();
        let expected = binding_from_snapshot(snapshot(&path).await.unwrap(), &audio_probe())
            .unwrap()
            .unwrap();
        for changed in [
            {
                let mut changed = expected.clone();
                changed.canonical_path = "/different/source.mkv".into();
                changed
            },
            {
                let mut changed = expected.clone();
                changed.modified_unix_ns = "0".into();
                changed
            },
            {
                let mut changed = expected.clone();
                changed.inventory.streams.swap(0, 1);
                changed
            },
            {
                let mut changed = expected.clone();
                changed.inventory.streams[0].title = goop_core::TrackTextFact::Value {
                    value: "changed metadata".into(),
                };
                changed
            },
        ] {
            assert!(verify_source_binding(&expected, Some(&changed)).is_err());
        }
        assert!(verify_source_binding(&expected, None).is_err());
    }

    #[tokio::test]
    async fn malformed_identity_and_oversized_binding_disable_only_selection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.mkv");
        fs::write(&path, b"source").unwrap();
        let source_snapshot = snapshot(&path).await.unwrap();

        let mut malformed = audio_probe();
        malformed.track_inventory.as_mut().unwrap().streams[0].language =
            goop_core::TrackTextFact::Malformed;
        assert!(binding_from_snapshot(source_snapshot.clone(), &malformed)
            .unwrap()
            .is_none());
        assert!(source_unavailable_reason(&malformed, None)
            .unwrap()
            .contains("malformed stream identity"));

        let mut oversized = audio_probe();
        let template = oversized.track_inventory.as_ref().unwrap().streams[0].clone();
        oversized.track_inventory.as_mut().unwrap().streams = (0..128)
            .map(|index| {
                let mut stream = template.clone();
                stream.index = index;
                stream.title = goop_core::TrackTextFact::Value {
                    value: "x".repeat(goop_core::MAX_TRACK_TEXT_BYTES),
                };
                stream
            })
            .collect();
        assert!(binding_from_snapshot(source_snapshot, &oversized)
            .unwrap()
            .is_none());
        assert!(source_unavailable_reason(&oversized, None)
            .unwrap()
            .contains("64 KiB"));
    }

    #[tokio::test]
    async fn inspection_fallback_never_swallows_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let resolver = BinaryResolver::new(directory.path().to_path_buf());
        let cancel = CancellationToken::new();
        cancel.cancel();
        let error = legacy_inspection_after_limit(
            &resolver,
            Path::new("unused.mkv"),
            "selection unavailable",
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, GoopError::Cancelled));
    }

    #[test]
    fn unavailable_reason_is_specific_to_audio_with_no_complete_inventory() {
        let mut probe = probe();
        assert_eq!(source_unavailable_reason(&probe, None), None);
        probe.has_audio = true;
        probe.track_inventory = None;
        assert!(source_unavailable_reason(&probe, None)
            .unwrap()
            .contains("complete bounded stream inventory"));
    }
}
