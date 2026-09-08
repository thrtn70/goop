use crate::{ConvertRequest, GoopError, ResolutionCap, TargetFormat};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Video codecs admitted by explicit Copy and software Encode modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum VideoCodec {
    H264,
    Hevc,
}

/// Software encoder preset names; speed is independent of rate control and audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum VideoSpeed {
    Fast,
    Medium,
    Slow,
}

/// Explicit encoding processor policy, persisted independently of global preferences.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum VideoProcessor {
    Software,
}

/// One video rate-control mode. CRF admits 1..=51 (lower is higher quality);
/// average bitrate admits 100..=200000 kbps and is not an exact output-size promise.
/// Deserialization checks shape and integer types; callers must validate bounds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
#[serde(deny_unknown_fields)]
pub enum VideoRateControl {
    ConstantQuality { crf: u8 },
    AverageBitrate { kbps: u32 },
}

/// Opt-in video processing; absence on a request retains legacy behavior.
/// Copy never encodes video. Encode honors the selected codec, rate, speed and
/// processor without substitution. Deserialization checks strict payload shape;
/// call validate_video_options or validate_video_request to check numeric bounds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
#[serde(deny_unknown_fields)]
pub enum VideoConvertOptions {
    Copy,
    Encode {
        codec: VideoCodec,
        rate_control: VideoRateControl,
        speed: VideoSpeed,
        processor: VideoProcessor,
    },
}

// Serde accepts unknown fields on internally tagged unit variants. An empty
// struct variant enforces Copy's empty payload while keeping the public enum
// convenient for callers.
impl<'de> Deserialize<'de> for VideoConvertOptions {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind")]
        #[serde(deny_unknown_fields)]
        enum StrictOptions {
            Copy {},
            Encode {
                codec: VideoCodec,
                rate_control: VideoRateControl,
                speed: VideoSpeed,
                processor: VideoProcessor,
            },
        }
        Ok(match StrictOptions::deserialize(deserializer)? {
            StrictOptions::Copy {} => Self::Copy,
            StrictOptions::Encode {
                codec,
                rate_control,
                speed,
                processor,
            } => Self::Encode {
                codec,
                rate_control,
                speed,
                processor,
            },
        })
    }
}

/// Validate CRF 1..=51 or average bitrate 100..=200000 kbps after deserialization.
/// Copy has no numeric settings. Source and encoder admission are checked elsewhere.
pub fn validate_video_options(options: &VideoConvertOptions) -> Result<(), GoopError> {
    match options {
        VideoConvertOptions::Encode {
            rate_control: VideoRateControl::ConstantQuality { crf },
            ..
        } if !(1..=51).contains(crf) => Err(GoopError::InvalidRequest(
            "Video CRF must be a whole number from 1 to 51".into(),
        )),
        VideoConvertOptions::Encode {
            rate_control: VideoRateControl::AverageBitrate { kbps },
            ..
        } if !(100..=200_000).contains(kbps) => Err(GoopError::InvalidRequest(
            "Video bitrate must be a whole number from 100 to 200000 kbps".into(),
        )),
        _ => Ok(()),
    }
}

/// Validate numeric bounds, target, conflicting fields and Copy resolution.
/// Absent video options leave legacy validation unchanged. Fresh source facts and encoder availability are
/// validated separately when resolving explicit video processing.
pub fn validate_video_request(request: &ConvertRequest) -> Result<(), GoopError> {
    let Some(options) = &request.video_options else {
        return Ok(());
    };
    validate_video_options(options)?;
    if !matches!(
        request.target,
        TargetFormat::Mp4 | TargetFormat::Mov | TargetFormat::Mkv
    ) {
        return Err(GoopError::InvalidRequest(
            "Explicit video settings require MP4, MOV or MKV output".into(),
        ));
    }
    if request.quality_preset.is_some()
        || request.compress_mode.is_some()
        || request.image_options.is_some()
        || request.gif_options.is_some()
        || request.subtitle.is_some()
    {
        return Err(GoopError::InvalidRequest("Explicit video settings cannot be combined with legacy quality, image, compression, GIF or subtitle settings".into()));
    }
    if matches!(options, VideoConvertOptions::Copy)
        && !matches!(request.resolution_cap, None | Some(ResolutionCap::Original))
    {
        return Err(GoopError::InvalidRequest(
            "Copy streams requires original resolution".into(),
        ));
    }
    Ok(())
}

/// Complete source stream inventory used for explicit video admission.
/// Stored details do not replace a fresh execution-time probe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoProbeDetails {
    pub streams: Vec<VideoStreamInfo>,
}

/// Source stream facts; missing optional values represent unknown probe facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoStreamInfo {
    /// Absolute source stream index reported by the probe, not a video-only ordinal.
    pub index: u32,
    pub codec_type: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub codec_name: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub pixel_format: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub color_transfer: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub color_primaries: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub color_space: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub color_range: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub field_order: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub sample_aspect_ratio: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub rotation_degrees: Option<i32>,
    /// Malformed, non-integral or conflicting rotation/display information.
    /// A missing rotation value alone does not imply ambiguity.
    pub rotation_ambiguous: bool,
    pub attached_pic: bool,
}

/// Resolved video processing and per-stream outcomes. Requested rate, speed and
/// processor are honored exactly; effective encoder, codec and audio facts are
/// recorded separately. Execution results describe completed processing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoExecutionSummary {
    /// Immutable requested controls, honored without rate/speed/processor fallback.
    pub requested: VideoConvertOptions,
    /// The resolved software encoder; absent when video is copied.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub encoder: Option<String>,
    pub video_codec: VideoCodec,
    /// Absolute admitted video stream index in the source.
    pub video_stream_index: u32,
    #[serde(default)]
    #[ts(optional = nullable)]
    /// Absolute admitted audio stream index in the source; absent for silent input.
    pub audio_stream_index: Option<u32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub audio_codec: Option<String>,
    /// True only when an admitted audio stream is copied without encoding.
    pub audio_copied: bool,
    /// Expected upright output width after the admitted resolution cap.
    pub width: u32,
    /// Expected upright output height after the admitted resolution cap.
    pub height: u32,
    pub notices: Vec<String>,
}

/// Engine-derived availability of a processing mode and its unavailable reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoModeAvailability {
    pub available: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub reason: Option<String>,
}

/// Availability of one concrete software encoder for this source and target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoCodecCapability {
    pub codec: VideoCodec,
    pub encoder: String,
    pub available: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub reason: Option<String>,
    /// Codec-specific recommendation; does not imply equal quality across codecs.
    pub recommended_crf: u8,
}

/// Engine-owned mode availability and control bounds/defaults for a target.
/// Defaults describe first-entry UI choices and never overwrite an explicit request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoSettingsCapabilities {
    pub copy: VideoModeAvailability,
    pub encode: VideoModeAvailability,
    pub codecs: Vec<VideoCodecCapability>,
    pub crf_min: u8,
    pub crf_max: u8,
    pub default_crf: u8,
    pub bitrate_min_kbps: u32,
    pub bitrate_max_kbps: u32,
    pub default_bitrate_kbps: u32,
    pub speeds: Vec<VideoSpeed>,
    pub default_speed: VideoSpeed,
    pub processor: VideoProcessor,
    pub preview_available: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub preview_unavailable_reason: Option<String>,
}
