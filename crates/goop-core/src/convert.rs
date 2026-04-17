use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Target format
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum TargetFormat {
    // Video
    Mp4,
    Mkv,
    Webm,
    Gif,
    Avi,
    Mov,
    // Audio
    Mp3,
    M4a,
    Opus,
    Wav,
    Flac,
    Ogg,
    Aac,
    ExtractAudioKeepCodec,
    // Image
    Png,
    Jpeg,
    Webp,
    Bmp,
}

impl TargetFormat {
    pub fn is_image(self) -> bool {
        matches!(self, Self::Png | Self::Jpeg | Self::Webp | Self::Bmp)
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mkv => "mkv",
            Self::Webm => "webm",
            Self::Gif => "gif",
            Self::Avi => "avi",
            Self::Mov => "mov",
            Self::Mp3 => "mp3",
            Self::M4a => "m4a",
            Self::Opus => "opus",
            Self::Wav => "wav",
            Self::Flac => "flac",
            Self::Ogg => "ogg",
            Self::Aac => "aac",
            Self::ExtractAudioKeepCodec => "mka",
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
            Self::Bmp => "bmp",
        }
    }
}

// ---------------------------------------------------------------------------
// Quality / compression
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum QualityPreset {
    Original,
    Fast,
    Balanced,
    Small,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum ResolutionCap {
    Original,
    R1080p,
    R720p,
    R480p,
}

// ---------------------------------------------------------------------------
// GIF options
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum GifSizePreset {
    Small,
    Medium,
    Large,
}

impl GifSizePreset {
    pub fn width(self) -> u32 {
        match self {
            Self::Small => 320,
            Self::Medium => 480,
            Self::Large => 720,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct GifOptions {
    pub size_preset: GifSizePreset,
    pub trim_start_ms: Option<u64>,
    pub trim_end_ms: Option<u64>,
}

// ---------------------------------------------------------------------------
// Source kind (set by probe)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Video,
    Audio,
    Image,
    Pdf,
}

// ---------------------------------------------------------------------------
// Compression mode (v0.1.6 Compress tab)
// ---------------------------------------------------------------------------

/// How the Compress tab should reduce a file's size.
///
/// `Quality` maps a 1..=100 slider to codec-specific parameters (CRF, audio
/// bitrate, JPEG/WebP quality). `LosslessReoptimize` is the PNG-only path
/// that re-saves with max deflate. `TargetSizeBytes` asks for a specific
/// output size in bytes (video/audio via bitrate math, images via iterative
/// quality search).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum CompressMode {
    Quality(u8),
    LosslessReoptimize,
    TargetSizeBytes(u64),
}

// ---------------------------------------------------------------------------
// Request / Result / Probe
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ConvertRequest {
    pub input_path: String,
    pub output_path: String,
    pub target: TargetFormat,
    pub quality_preset: Option<QualityPreset>,
    pub resolution_cap: Option<ResolutionCap>,
    pub gif_options: Option<GifOptions>,
    pub compress_mode: Option<CompressMode>,
    pub batch_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ProbeResult {
    pub duration_ms: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub file_size: u64,
    pub container: Option<String>,
    pub has_video: bool,
    pub has_audio: bool,
    pub source_kind: SourceKind,
    pub color_space: Option<String>,
    pub image_format: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ConvertResult {
    pub output_path: String,
    pub bytes: u64,
    pub duration_ms: u64,
    pub reencoded: bool,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_image_identifies_image_targets() {
        assert!(TargetFormat::Png.is_image());
        assert!(TargetFormat::Jpeg.is_image());
        assert!(TargetFormat::Webp.is_image());
        assert!(TargetFormat::Bmp.is_image());
        assert!(!TargetFormat::Mp4.is_image());
        assert!(!TargetFormat::Gif.is_image());
        assert!(!TargetFormat::Mp3.is_image());
    }

    #[test]
    fn extension_maps_correctly() {
        assert_eq!(TargetFormat::Mp4.extension(), "mp4");
        assert_eq!(TargetFormat::Gif.extension(), "gif");
        assert_eq!(TargetFormat::Jpeg.extension(), "jpg");
        assert_eq!(TargetFormat::Webp.extension(), "webp");
        assert_eq!(TargetFormat::Flac.extension(), "flac");
    }

    #[test]
    fn gif_size_preset_widths() {
        assert_eq!(GifSizePreset::Small.width(), 320);
        assert_eq!(GifSizePreset::Medium.width(), 480);
        assert_eq!(GifSizePreset::Large.width(), 720);
    }
}
