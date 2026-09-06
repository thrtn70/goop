use crate::convert::{
    CompressMode, GifOptions, MetadataPolicy, QualityPreset, ResolutionCap, SubtitleOptions,
    TargetFormat,
};
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
    #[serde(default)]
    #[ts(optional = nullable)]
    pub metadata_policy: Option<MetadataPolicy>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub gif_options: Option<GifOptions>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub subtitle: Option<SubtitleOptions>,
    pub is_builtin: bool,
    pub created_at: i64,
}

impl Preset {
    pub fn new_id() -> String {
        Uuid::now_v7().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_preset_loads_without_extended_settings() {
        let preset: Preset = serde_json::from_str(r#"{"id":"old","name":"Old","target":"mp4","quality_preset":null,"resolution_cap":null,"compress_mode":null,"is_builtin":false,"created_at":0}"#).unwrap();
        assert_eq!(preset.metadata_policy, None);
        assert_eq!(preset.gif_options, None);
        assert_eq!(preset.subtitle, None);
    }
}
