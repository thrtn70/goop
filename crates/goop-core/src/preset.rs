use crate::convert::{CompressMode, QualityPreset, ResolutionCap, TargetFormat};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// A saved combination of target format + quality / resolution / compression
/// settings, named by the user. Applied from the Convert or Compress page.
///
/// A single preset can carry Convert fields (`quality_preset`,
/// `resolution_cap`) and Compress fields (`compress_mode`). Each page applies
/// only the fields relevant to it. Presets without a `compress_mode` are
/// hidden from the Compress page's chip picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub target: TargetFormat,
    pub quality_preset: Option<QualityPreset>,
    pub resolution_cap: Option<ResolutionCap>,
    pub compress_mode: Option<CompressMode>,
    pub is_builtin: bool,
    pub created_at: i64,
}

impl Preset {
    pub fn new_id() -> String {
        Uuid::now_v7().to_string()
    }
}
