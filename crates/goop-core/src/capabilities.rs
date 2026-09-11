use crate::TargetFormat;
use serde::{de::Error as _, ser::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use ts_rs::TS;

/// Copy and encode availability for one source-bound audio track.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct TrackChoiceCapability {
    pub track: crate::tracks::TrackIdentity,
    pub copy: crate::audio::AudioModeAvailability,
    pub encode: crate::audio::AudioModeAvailability,
}

/// Source binding and per-track audio choices returned by inspection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct TrackSettingsCapabilities {
    pub source: crate::tracks::TrackSourceBinding,
    pub audio_choices: Vec<TrackChoiceCapability>,
}

/// One source-bound track or policy availability result for explicit video.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct TrackModeAvailability {
    pub available: bool,
    pub reason: Option<String>,
}

/// Copy and Custom availability for one audio or embedded subtitle stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoTrackChoiceCapability {
    pub track: crate::tracks::TrackIdentity,
    pub copy: TrackModeAvailability,
    pub custom: TrackModeAvailability,
}

/// Availability of the three policies within one video processing mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoTrackPolicyModeCapabilities {
    pub keep_all: TrackModeAvailability,
    pub choose: TrackModeAvailability,
    pub none: TrackModeAvailability,
}

/// Copy and Custom policy-level availability for one stream family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoTrackPolicyCapabilities {
    pub copy: VideoTrackPolicyModeCapabilities,
    pub custom: VideoTrackPolicyModeCapabilities,
}

/// Source binding, per-stream reasons and policy-level availability for 05B.
#[derive(Debug, Clone, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct VideoTrackSettingsCapabilities {
    pub source: crate::tracks::TrackSourceBinding,
    pub audio_tracks: Vec<VideoTrackChoiceCapability>,
    pub subtitle_tracks: Vec<VideoTrackChoiceCapability>,
    pub audio_policy: VideoTrackPolicyCapabilities,
    pub subtitle_policy: VideoTrackPolicyCapabilities,
}

impl Serialize for VideoTrackSettingsCapabilities {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct StrictCapabilities<'a> {
            source: &'a crate::tracks::TrackSourceBinding,
            audio_tracks: &'a [VideoTrackChoiceCapability],
            subtitle_tracks: &'a [VideoTrackChoiceCapability],
            audio_policy: &'a VideoTrackPolicyCapabilities,
            subtitle_policy: &'a VideoTrackPolicyCapabilities,
        }

        crate::tracks::validate_track_source_binding(&self.source).map_err(S::Error::custom)?;
        validate_video_track_choices(&self.source, &self.audio_tracks, "audio")
            .map_err(S::Error::custom)?;
        validate_video_track_choices(&self.source, &self.subtitle_tracks, "subtitle")
            .map_err(S::Error::custom)?;
        StrictCapabilities {
            source: &self.source,
            audio_tracks: &self.audio_tracks,
            subtitle_tracks: &self.subtitle_tracks,
            audio_policy: &self.audio_policy,
            subtitle_policy: &self.subtitle_policy,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for VideoTrackSettingsCapabilities {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct StrictCapabilities {
            source: crate::tracks::TrackSourceBinding,
            audio_tracks: Vec<VideoTrackChoiceCapability>,
            subtitle_tracks: Vec<VideoTrackChoiceCapability>,
            audio_policy: VideoTrackPolicyCapabilities,
            subtitle_policy: VideoTrackPolicyCapabilities,
        }

        let raw = StrictCapabilities::deserialize(deserializer)?;
        validate_video_track_choices(&raw.source, &raw.audio_tracks, "audio")
            .map_err(D::Error::custom)?;
        validate_video_track_choices(&raw.source, &raw.subtitle_tracks, "subtitle")
            .map_err(D::Error::custom)?;
        Ok(Self {
            source: raw.source,
            audio_tracks: raw.audio_tracks,
            subtitle_tracks: raw.subtitle_tracks,
            audio_policy: raw.audio_policy,
            subtitle_policy: raw.subtitle_policy,
        })
    }
}

fn validate_video_track_choices(
    source: &crate::tracks::TrackSourceBinding,
    choices: &[VideoTrackChoiceCapability],
    codec_type: &str,
) -> Result<(), String> {
    let expected = source
        .inventory
        .streams
        .iter()
        .filter(|track| track.codec_type == codec_type)
        .collect::<Vec<_>>();
    if choices.len() != expected.len()
        || choices
            .iter()
            .zip(expected)
            .any(|(choice, expected)| &choice.track != expected)
    {
        return Err(format!(
            "Video {codec_type} track capabilities must exactly match source order and identity"
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct CompressionCapabilities {
    pub quality: bool,
    pub target_size: bool,
    pub lossless: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ImageSettingsCapabilities {
    pub available: bool,
    pub reason: Option<String>,
    pub quality_min: u8,
    pub quality_max: u8,
    pub default_quality: u8,
    pub max_dimension: u32,
    pub max_output_pixels: u32,
    pub fit_within: bool,
    pub upscale: bool,
    pub preview_original_available: bool,
    pub preview_fit_within: bool,
    pub preview_unavailable_reason: Option<String>,
}

/// Whether one metadata policy can be applied to a source/target pair and the
/// engine-owned explanation shown to clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct MetadataPolicyAvailability {
    pub available: bool,
    pub reason: Option<String>,
    pub summary: String,
}

/// Source orientation state established by bounded metadata inspection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum ImageOrientationStatus {
    Uninspected,
    Absent,
    Valid,
    Malformed,
    Ambiguous,
}

/// Metadata policy availability and source facts for one image target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct ImageMetadataCapabilities {
    pub preserve: MetadataPolicyAvailability,
    pub remove_personal: MetadataPolicyAvailability,
    pub strip_all: MetadataPolicyAvailability,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub source_has_exif: Option<bool>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub source_has_icc: Option<bool>,
    pub orientation: ImageOrientationStatus,
}

/// Availability for one target, including optional source-bound track settings.
/// Track settings remain absent for legacy or Automatic-only inspection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct TargetCapability {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub audio_settings: Option<crate::audio::AudioSettingsCapabilities>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub video_settings: Option<crate::video::VideoSettingsCapabilities>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub track_settings: Option<TrackSettingsCapabilities>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub video_track_settings: Option<VideoTrackSettingsCapabilities>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub compression: Option<CompressionCapabilities>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub image_settings: Option<ImageSettingsCapabilities>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub image_metadata: Option<ImageMetadataCapabilities>,
    pub target: TargetFormat,
    pub available: bool,
    pub reason: Option<String>,
    pub preserves_metadata: bool,
    pub metadata_warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ConversionCapabilities {
    pub targets: Vec<TargetCapability>,
    pub compression: CompressionCapabilities,
}

/// A single source read and the capabilities derived from that exact probe.
///
/// `track_source` carries exact identity only when explicit selection is safe.
/// When audio exists but identity enrichment hits a supported limit, the source
/// stays absent and `track_source_unavailable_reason` explains the fail-closed
/// Automatic-only result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ConversionInspection {
    pub probe: crate::ProbeResult,
    pub capabilities: ConversionCapabilities,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub track_source: Option<crate::tracks::TrackSourceBinding>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub track_source_unavailable_reason: Option<String>,
}
