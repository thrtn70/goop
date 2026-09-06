use crate::{
    CompressMode, GifOptions, MetadataPolicy, QualityPreset, ResolutionCap, SubtitleOptions,
    TargetFormat,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct PreviewRequest {
    pub request_id: String,
    pub input_path: String,
    pub source_revision: String,
    pub target: TargetFormat,
    pub quality_preset: Option<QualityPreset>,
    pub resolution_cap: Option<ResolutionCap>,
    pub compress_mode: Option<CompressMode>,
    pub metadata_policy: Option<MetadataPolicy>,
    pub subtitle: Option<SubtitleOptions>,
    pub gif_options: Option<GifOptions>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum PreviewKind {
    Image,
    Video,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct PreviewResult {
    pub request_id: String,
    pub source_revision: String,
    pub kind: PreviewKind,
    pub before_path: Option<String>,
    pub after_path: String,
    pub width: u32,
    pub height: u32,
    pub sample_bytes: u32,
    pub duration_ms: Option<u32>,
    pub max_edge: u32,
    pub max_duration_ms: u32,
}
