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
pub struct TargetCapability {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub compression: Option<CompressionCapabilities>,
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
