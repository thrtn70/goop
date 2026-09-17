use crate::{
    CompressMode, GifOptions, ImageAlphaPolicy, ImageColorPolicy, ImageConvertOptions,
    MetadataPolicy, QualityPreset, ResolutionCap, SubtitleOptions, TargetFormat,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::{Uuid, Version};

pub fn new_preview_session_id() -> String {
    Uuid::new_v4().hyphenated().to_string()
}

pub fn is_canonical_preview_session_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| {
        id.get_version() == Some(Version::Random) && id.hyphenated().to_string() == value
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct PreviewRequest {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub video_options: Option<crate::video::VideoConvertOptions>,
    pub request_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub preview_session_id: Option<String>,
    pub input_path: String,
    pub source_revision: String,
    pub target: TargetFormat,
    pub quality_preset: Option<QualityPreset>,
    pub resolution_cap: Option<ResolutionCap>,
    pub compress_mode: Option<CompressMode>,
    pub metadata_policy: Option<MetadataPolicy>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub image_color_policy: Option<ImageColorPolicy>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub image_alpha_policy: Option<ImageAlphaPolicy>,
    pub subtitle: Option<SubtitleOptions>,
    pub gif_options: Option<GifOptions>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub image_options: Option<ImageConvertOptions>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub pinned_jpeg_quality: Option<u8>,
}

/// Engine-owned admission result for the current bounded preview request.
///
/// `available` means the request passed deterministic preflight. Generation
/// still revalidates the source and can fail during bounded decode or encode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct PreviewEligibility {
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum PreviewKind {
    Image,
    Video,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum ImageSampleKind {
    EmbeddedHeicThumbnail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ImagePreviewDetails {
    pub sample_kind: ImageSampleKind,
    pub admitted_sample_width: u32,
    pub admitted_sample_height: u32,
    pub comparison_frame_width: u32,
    pub comparison_frame_height: u32,
    pub planned_output_width: u32,
    pub planned_output_height: u32,
    pub current_jpeg_quality: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub pinned_jpeg_quality: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub pinned_path: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub image_details: Option<ImagePreviewDetails>,
}
