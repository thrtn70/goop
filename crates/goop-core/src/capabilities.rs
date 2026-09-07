use crate::TargetFormat;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct TargetCapability {
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ConversionInspection {
    pub probe: crate::ProbeResult,
    pub capabilities: ConversionCapabilities,
}
