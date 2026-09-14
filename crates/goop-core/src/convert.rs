use crate::error::GoopError;
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
    // Subtitle. Standalone subtitle-to-subtitle conversion; also the
    // extraction target for a subtitle stream inside a container.
    Srt,
    Vtt,
    // Image
    Png,
    Jpeg,
    Webp,
    Bmp,
    /// Tagged Image File Format. Lossless, widely supported by editing
    /// tools. Enabled by the `image` crate's `tiff` feature in v0.2.5
    /// (was previously routed-but-unsupported — pre-v0.2.5 inputs would
    /// panic at runtime).
    Tiff,
    /// AV1-based modern web image format (HEIF container, AV1 codec).
    /// Smaller than JPEG at equivalent quality. Encode via the `image`
    /// crate's `avif` feature (which pulls `ravif` / `rav1e`).
    Avif,
    /// JPEG-XL: high-quality modern image codec. Both decode and encode
    /// run through `jpegxl-rs` (binding to system libjxl) — the `image`
    /// crate doesn't ship a JXL codec.
    JpegXl,
}

impl TargetFormat {
    pub fn is_image(self) -> bool {
        matches!(
            self,
            Self::Png
                | Self::Jpeg
                | Self::Webp
                | Self::Bmp
                | Self::Tiff
                | Self::Avif
                | Self::JpegXl
        )
    }

    pub fn is_subtitle(self) -> bool {
        matches!(self, Self::Srt | Self::Vtt)
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
            Self::Srt => "srt",
            Self::Vtt => "vtt",
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
            Self::Bmp => "bmp",
            Self::Tiff => "tiff",
            Self::Avif => "avif",
            Self::JpegXl => "jxl",
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
// Subtitle options
// ---------------------------------------------------------------------------

/// How an external subtitle file is attached to a video conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum SubtitleMode {
    /// Mux as a selectable track. Keeps the remux fast path when the
    /// audio/video streams are already compatible with the target.
    Soft,
    /// Render the subtitles into the video frames. Always re-encodes,
    /// and the result can't be turned off in the player.
    BurnIn,
}

/// An external `.srt` / `.vtt` to attach during a video conversion.
///
/// `None` on a `ConvertRequest` means no subtitle handling at all — the
/// pre-subtitle behaviour.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct SubtitleOptions {
    pub source_path: String,
    pub mode: SubtitleMode,
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
    Subtitle,
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

/// What to do with the source image's metadata (EXIF + ICC profile)
/// during a convert / compress op.
///
/// * `Preserve` — copy EXIF + ICC chunks from the input to the output
///   when both formats support them (currently JPEG↔JPEG and PNG↔PNG).
///   For cross-format converts (e.g. JPEG → AVIF) the metadata is
///   dropped.
/// * `RemovePersonal` — drop EXIF and other source ancillary metadata,
///   retaining an exact ICC profile only on engine-proven paths.
/// * `StripAll` — drop all source metadata. Explicit color conversion may
///   still attach a generated destination profile that describes the output
///   pixels; the legacy Preserve color path attaches nothing new.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum MetadataPolicy {
    #[default]
    Preserve,
    RemovePersonal,
    StripAll,
}

/// Explicit image color behavior. `Preserve` and an absent request field keep
/// the legacy pixel and metadata paths unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum ImageColorPolicy {
    #[default]
    Preserve,
    ConvertToSrgb,
    AssumeSrgb,
}

/// An opaque color expressed in the destination sRGB encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct SrgbColor {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
}

/// Explicit authorization to remove image transparency for an opaque output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
#[serde(deny_unknown_fields)]
pub enum ImageAlphaPolicy {
    Flatten { background: SrgbColor },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
/// The transfer function used to composite transparent source pixels.
pub enum AlphaCompositing {
    LinearSrgb,
}

/// Verified transparency outcome for a completed conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct ImageAlphaExecution {
    pub requested_policy: ImageAlphaPolicy,
    pub source_had_alpha: bool,
    pub flattened: bool,
    pub background: SrgbColor,
    pub compositing: AlphaCompositing,
}

/// How the completed image output represents color. These values describe
/// verified handling, not perceptual equivalence between viewers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum ImageColorHandling {
    ExactProfileRetained,
    RendererSdrSrgb,
    ConvertedToSrgb,
    AssumedSrgb,
    Untagged,
    NoProfile,
}

/// Verified metadata outcome for a completed image conversion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct ImageMetadataExecution {
    pub requested_policy: MetadataPolicy,
    #[serde(default)]
    pub requested_color_policy: ImageColorPolicy,
    pub exif_retained: bool,
    pub icc_retained: bool,
    #[serde(default)]
    pub destination_srgb_profile_attached: bool,
    pub orientation_normalized: bool,
    pub color_handling: ImageColorHandling,
    pub notices: Vec<String>,
}

/// Measured compression outcome. Image target-size execution fills every
/// measurement from the same final metadata-bearing candidate it publishes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct CompressionExecution {
    pub requested_mode: CompressMode,
    pub attempts: u8,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub selected_quality: Option<u8>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub target_bytes: Option<u64>,
    pub final_bytes: u64,
    pub target_met: bool,
    pub metadata_policy: MetadataPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ImageResize {
    Original,
    FitWithin { width: u32, height: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ImageConvertOptions {
    pub jpeg_quality: u8,
    pub resize: ImageResize,
}

// ---------------------------------------------------------------------------
// Request / Result / Probe
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ConvertRequest {
    /// Explicit color conversion is opt-in. `None` is identical to
    /// `Preserve` for older callers, presets and queued jobs.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub image_color_policy: Option<ImageColorPolicy>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub video_options: Option<crate::video::VideoConvertOptions>,
    pub input_path: String,
    pub output_path: String,
    pub target: TargetFormat,
    pub quality_preset: Option<QualityPreset>,
    pub resolution_cap: Option<ResolutionCap>,
    pub gif_options: Option<GifOptions>,
    pub compress_mode: Option<CompressMode>,
    pub batch_id: Option<String>,
    /// EXIF + ICC handling. `None` is treated as `Preserve` so older
    /// callers / presets don't need to migrate; an explicit
    /// `StripAll` opts in to scrubbing.
    #[serde(default)]
    pub metadata_policy: Option<MetadataPolicy>,
    /// External subtitle to soft-embed or burn in. `None` skips all
    /// subtitle handling, so pre-subtitle presets and queued job
    /// payloads keep deserializing unchanged.
    #[serde(default)]
    pub subtitle: Option<SubtitleOptions>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub image_options: Option<ImageConvertOptions>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub audio_options: Option<crate::audio::AudioConvertOptions>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub track_options: Option<crate::tracks::TrackConvertOptions>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub image_alpha_policy: Option<ImageAlphaPolicy>,
}

/// Reject source-independent explicit color combinations before any source I/O
/// or native color work. Source layout/profile compatibility is validated from
/// the engine-owned snapshot after this shape check passes.
pub fn validate_image_color_request_shape(request: &ConvertRequest) -> Result<(), GoopError> {
    if request.image_color_policy.unwrap_or_default() == ImageColorPolicy::Preserve {
        return Ok(());
    }
    if !matches!(request.target, TargetFormat::Jpeg | TargetFormat::Png) {
        return Err(GoopError::InvalidRequest(
            "Explicit image color handling requires JPEG or PNG output".into(),
        ));
    }
    if request.compress_mode.is_some() {
        return Err(GoopError::InvalidRequest(
            "Explicit color handling is currently available in Convert only".into(),
        ));
    }
    if request.video_options.is_some()
        || request.audio_options.is_some()
        || request.track_options.is_some()
        || request.gif_options.is_some()
        || request.subtitle.is_some()
        || request
            .quality_preset
            .is_some_and(|value| value != QualityPreset::Original)
        || request
            .resolution_cap
            .is_some_and(|value| value != ResolutionCap::Original)
    {
        return Err(GoopError::InvalidRequest(
            "Explicit image color handling cannot be combined with media, GIF, subtitle, or video quality controls."
                .into(),
        ));
    }
    if let Some(options) = request.image_options.as_ref() {
        if request.target != TargetFormat::Jpeg {
            return Err(GoopError::InvalidRequest(
                "Explicit JPEG quality and resize settings require JPEG output".into(),
            ));
        }
        if !(1..=100).contains(&options.jpeg_quality) {
            return Err(GoopError::InvalidRequest(
                "JPEG quality must be 1–100".into(),
            ));
        }
        if let ImageResize::FitWithin { width, height } = options.resize {
            if width == 0 || height == 0 || width > 32_768 || height > 32_768 {
                return Err(GoopError::InvalidRequest(
                    "Fit dimensions must be 1–32768 pixels".into(),
                ));
            }
        }
    }
    Ok(())
}

/// Reject invalid alpha-policy combinations without reading the source.
pub fn validate_image_alpha_request_shape(request: &ConvertRequest) -> Result<(), GoopError> {
    if request.image_alpha_policy.is_none() {
        return Ok(());
    }
    if request.target != TargetFormat::Jpeg {
        return Err(GoopError::InvalidRequest(
            "JPEG transparency flattening requires JPEG output".into(),
        ));
    }
    if request.compress_mode.is_some() {
        return Err(GoopError::InvalidRequest(
            "JPEG transparency flattening is currently available in Convert only".into(),
        ));
    }
    if matches!(
        request.image_color_policy.unwrap_or_default(),
        ImageColorPolicy::Preserve
    ) {
        return Err(GoopError::InvalidRequest(
            "JPEG transparency flattening requires Convert to sRGB or Assume sRGB".into(),
        ));
    }
    if request.video_options.is_some()
        || request.audio_options.is_some()
        || request.track_options.is_some()
        || request.gif_options.is_some()
        || request.subtitle.is_some()
        || request
            .quality_preset
            .is_some_and(|value| value != QualityPreset::Original)
        || request
            .resolution_cap
            .is_some_and(|value| value != ResolutionCap::Original)
    {
        return Err(GoopError::InvalidRequest(
            "JPEG transparency flattening cannot be combined with media, GIF, subtitle, or video quality controls."
                .into(),
        ));
    }
    validate_image_color_request_shape(request)
}

/// Media probe facts. The bounded track inventory is absent when complete
/// identity cannot be represented safely; legacy processing facts remain usable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ProbeResult {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub video_details: Option<crate::video::VideoProbeDetails>,
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
    /// True when the source carries at least one subtitle stream —
    /// either a bare `.srt` / `.vtt` or a container with embedded subs.
    #[serde(default)]
    pub has_subtitles: bool,
    /// Codecs of every subtitle stream, in stream order (`subrip`,
    /// `webvtt`, `hdmv_pgs_subtitle`, …). The full list matters because
    /// text and bitmap subtitles can't be transcoded into each other, so
    /// preserving existing tracks is only safe when they are all text.
    #[serde(default)]
    pub subtitle_codecs: Vec<String>,
    /// Codecs of every audio stream, in stream order (`aac`, `ac3`,
    /// `vorbis`, …).
    ///
    /// `audio_codec` above names only the *first* stream, which is all the
    /// remux-or-re-encode decision needs. Carrying the source's secondary
    /// tracks through a stream copy needs the whole list instead: each one
    /// lands in the output untouched, so each has to be checked against
    /// what the target container can actually describe.
    #[serde(default)]
    pub audio_codecs: Vec<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub image_has_alpha: Option<bool>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub audio_details: Option<crate::audio::AudioProbeDetails>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub track_inventory: Option<crate::tracks::TrackInventory>,
}

/// Completed conversion measurements and optional explicit processing disclosures.
/// Track execution remains absent for Automatic and legacy conversions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ConvertResult {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub audio_execution: Option<crate::audio::AudioExecutionSummary>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub video_execution: Option<crate::video::VideoExecutionSummary>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub track_execution: Option<crate::tracks::TrackExecutionSummary>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub video_track_execution: Option<crate::tracks::VideoTrackExecutionSummary>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub image_metadata_execution: Option<ImageMetadataExecution>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub compression_execution: Option<CompressionExecution>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub image_alpha_execution: Option<ImageAlphaExecution>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub source_bytes: Option<u64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub target_bytes: Option<u64>,

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

    fn color_request(target: TargetFormat) -> ConvertRequest {
        ConvertRequest {
            video_options: None,
            input_path: String::new(),
            output_path: String::new(),
            target,
            quality_preset: None,
            resolution_cap: None,
            gif_options: None,
            compress_mode: None,
            batch_id: None,
            metadata_policy: None,
            image_color_policy: Some(ImageColorPolicy::ConvertToSrgb),
            image_alpha_policy: None,
            subtitle: None,
            image_options: None,
            audio_options: None,
            track_options: None,
        }
    }

    #[test]
    fn explicit_color_shape_validation_is_source_independent() {
        let mut request = color_request(TargetFormat::Png);
        assert!(validate_image_color_request_shape(&request).is_ok());

        request.target = TargetFormat::Webp;
        assert!(validate_image_color_request_shape(&request).is_err());
        request.target = TargetFormat::Jpeg;
        request.image_options = Some(ImageConvertOptions {
            jpeg_quality: 0,
            resize: ImageResize::Original,
        });
        assert!(validate_image_color_request_shape(&request)
            .unwrap_err()
            .to_string()
            .contains("quality must be 1–100"));
        request.image_color_policy = None;
        assert!(validate_image_color_request_shape(&request).is_ok());
    }

    #[test]
    fn is_image_identifies_image_targets() {
        assert!(TargetFormat::Png.is_image());
        assert!(TargetFormat::Jpeg.is_image());
        assert!(TargetFormat::Webp.is_image());
        assert!(TargetFormat::Bmp.is_image());
        assert!(TargetFormat::Tiff.is_image());
        assert!(TargetFormat::Avif.is_image());
        assert!(TargetFormat::JpegXl.is_image());
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
        assert_eq!(TargetFormat::Tiff.extension(), "tiff");
        assert_eq!(TargetFormat::Avif.extension(), "avif");
        assert_eq!(TargetFormat::JpegXl.extension(), "jxl");
    }

    #[test]
    fn gif_size_preset_widths() {
        assert_eq!(GifSizePreset::Small.width(), 320);
        assert_eq!(GifSizePreset::Medium.width(), 480);
        assert_eq!(GifSizePreset::Large.width(), 720);
    }

    #[test]
    fn is_subtitle_identifies_subtitle_targets() {
        assert!(TargetFormat::Srt.is_subtitle());
        assert!(TargetFormat::Vtt.is_subtitle());
        assert!(!TargetFormat::Mp4.is_subtitle());
        assert!(!TargetFormat::Mp3.is_subtitle());
        assert!(!TargetFormat::Png.is_subtitle());
        // Subtitle targets must never be mistaken for image targets: the
        // worker branches on `is_image()` to pick the ImageMagick backend.
        assert!(!TargetFormat::Srt.is_image());
        assert!(!TargetFormat::Vtt.is_image());
    }

    #[test]
    fn subtitle_target_extensions() {
        assert_eq!(TargetFormat::Srt.extension(), "srt");
        assert_eq!(TargetFormat::Vtt.extension(), "vtt");
    }

    #[test]
    fn subtitle_options_round_trip_snake_case() {
        let opts = SubtitleOptions {
            source_path: "/tmp/subs.srt".into(),
            mode: SubtitleMode::BurnIn,
        };
        let s = serde_json::to_string(&opts).unwrap();
        assert_eq!(s, r#"{"source_path":"/tmp/subs.srt","mode":"burn_in"}"#);
        assert_eq!(serde_json::from_str::<SubtitleOptions>(&s).unwrap(), opts);
    }

    #[test]
    fn subtitle_mode_soft_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&SubtitleMode::Soft).unwrap(),
            r#""soft""#
        );
    }

    #[test]
    fn convert_request_without_subtitle_key_deserializes() {
        // Back-compat canary: presets and queued job payloads written
        // before subtitle support must still deserialize.
        let json = r#"{
            "input_path": "/in.mp4",
            "output_path": "/out.mkv",
            "target": "mkv",
            "quality_preset": null,
            "resolution_cap": null,
            "gif_options": null,
            "compress_mode": null,
            "batch_id": null
        }"#;
        let req: ConvertRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.subtitle, None);
        assert_eq!(req.metadata_policy, None);
    }

    #[test]
    fn convert_request_round_trips_with_subtitle() {
        let json = r#"{
            "input_path": "/in.mp4",
            "output_path": "/out.mp4",
            "target": "mp4",
            "quality_preset": null,
            "resolution_cap": null,
            "gif_options": null,
            "compress_mode": null,
            "batch_id": null,
            "metadata_policy": null,
            "subtitle": { "source_path": "/subs.vtt", "mode": "soft" }
        }"#;
        let req: ConvertRequest = serde_json::from_str(json).unwrap();
        let sub = req.subtitle.as_ref().expect("subtitle should deserialize");
        assert_eq!(sub.source_path, "/subs.vtt");
        assert_eq!(sub.mode, SubtitleMode::Soft);
    }

    #[test]
    fn source_kind_subtitle_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&SourceKind::Subtitle).unwrap(),
            r#""subtitle""#
        );
    }
}
