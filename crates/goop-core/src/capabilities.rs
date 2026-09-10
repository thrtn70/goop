use crate::TargetFormat;
use serde::{Deserialize, Serialize};
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
    pub compression: Option<CompressionCapabilities>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub image_settings: Option<ImageSettingsCapabilities>,
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
