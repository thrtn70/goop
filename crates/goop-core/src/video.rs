use crate::{ConvertRequest, GoopError, ResolutionCap, TargetFormat};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

fn deserialize_present_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Encoder names admitted by the current video planners, not proof of device utilization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub enum VideoEncoder {
    #[serde(rename = "libx264")]
    Libx264,
    #[serde(rename = "libx265")]
    Libx265,
    #[serde(rename = "libvpx-vp9")]
    LibvpxVp9,
    #[serde(rename = "mpeg4")]
    Mpeg4,
    #[serde(rename = "h264_videotoolbox")]
    H264Videotoolbox,
    #[serde(rename = "h264_nvenc")]
    H264Nvenc,
    #[serde(rename = "h264_qsv")]
    H264Qsv,
    #[serde(rename = "h264_amf")]
    H264Amf,
}

impl VideoEncoder {
    pub fn name(self) -> &'static str {
        match self {
            Self::Libx264 => "libx264",
            Self::Libx265 => "libx265",
            Self::LibvpxVp9 => "libvpx-vp9",
            Self::Mpeg4 => "mpeg4",
            Self::H264Videotoolbox => "h264_videotoolbox",
            Self::H264Nvenc => "h264_nvenc",
            Self::H264Qsv => "h264_qsv",
            Self::H264Amf => "h264_amf",
        }
    }

    pub fn is_hardware(self) -> bool {
        matches!(
            self,
            Self::H264Videotoolbox | Self::H264Nvenc | Self::H264Qsv | Self::H264Amf
        )
    }
}

/// Execution-time legacy preference is distinct from explicit per-job Software intent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
#[serde(deny_unknown_fields)]
pub enum VideoSelectionContext {
    ExplicitSoftware,
    ExplicitHardwareRequired,
    LegacyGlobalAtExecution { hw_acceleration_enabled: bool },
}

impl<'de> Deserialize<'de> for VideoSelectionContext {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictContext {
            ExplicitSoftware {},
            ExplicitHardwareRequired {},
            LegacyGlobalAtExecution { hw_acceleration_enabled: bool },
        }
        Ok(match StrictContext::deserialize(deserializer)? {
            StrictContext::ExplicitSoftware {} => Self::ExplicitSoftware,
            StrictContext::ExplicitHardwareRequired {} => Self::ExplicitHardwareRequired,
            StrictContext::LegacyGlobalAtExecution {
                hw_acceleration_enabled,
            } => Self::LegacyGlobalAtExecution {
                hw_acceleration_enabled,
            },
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum VideoFallbackReason {
    HardwareAttemptSubprocessFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoFallback {
    pub from_encoder: VideoEncoder,
    pub reason: VideoFallbackReason,
}

/// Facts about completed processing, frozen before publication. Ordinal is internal
/// to this conversion, not the queue attempt count. Absent receipts remain unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
#[serde(deny_unknown_fields)]
pub enum VideoAttempt {
    Copy,
    Encode {
        encoder: VideoEncoder,
        encode_attempt_ordinal: u8,
        selection_context: VideoSelectionContext,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        fallback: Option<VideoFallback>,
    },
}

impl<'de> Deserialize<'de> for VideoAttempt {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictAttempt {
            Copy {},
            Encode {
                encoder: VideoEncoder,
                encode_attempt_ordinal: u8,
                selection_context: VideoSelectionContext,
                #[serde(default)]
                fallback: Option<VideoFallback>,
            },
        }
        match StrictAttempt::deserialize(deserializer)? {
            StrictAttempt::Copy {} => Ok(Self::Copy),
            StrictAttempt::Encode {
                encoder,
                encode_attempt_ordinal,
                selection_context,
                fallback,
            } => {
                let legacy_hw_enabled = matches!(
                    selection_context,
                    VideoSelectionContext::LegacyGlobalAtExecution {
                        hw_acceleration_enabled: true
                    }
                );
                let valid =
                    match &fallback {
                        Some(previous) => {
                            legacy_hw_enabled
                                && encode_attempt_ordinal == 2
                                && encoder == VideoEncoder::Libx264
                                && previous.from_encoder.is_hardware()
                        }
                        None => match selection_context {
                            VideoSelectionContext::ExplicitHardwareRequired => {
                                encode_attempt_ordinal == 1
                                    && encoder == VideoEncoder::H264Videotoolbox
                            }
                            _ => {
                                encode_attempt_ordinal == 1
                                    && (!encoder.is_hardware() || legacy_hw_enabled)
                            }
                        },
                    } && (!matches!(selection_context, VideoSelectionContext::ExplicitSoftware)
                        || matches!(encoder, VideoEncoder::Libx264 | VideoEncoder::Libx265));
                if !valid {
                    return Err(serde::de::Error::custom(
                        "inconsistent completed video attempt",
                    ));
                }
                Ok(Self::Encode {
                    encoder,
                    encode_attempt_ordinal,
                    selection_context,
                    fallback,
                })
            }
        }
    }
}

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

/// The first portable explicit hardware codec contract. Encoder names remain
/// execution facts and are not persisted as user intent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum VideoHardwareCodec {
    H264,
}

/// Hardware-required means the admitted hardware encoder must be used and no
/// software substitution or retry is permitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
#[serde(deny_unknown_fields)]
pub enum VideoHardwarePolicy {
    Required,
}

impl<'de> Deserialize<'de> for VideoHardwarePolicy {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictPolicy {
            Required {},
        }
        match StrictPolicy::deserialize(deserializer)? {
            StrictPolicy::Required {} => Ok(Self::Required),
        }
    }
}

/// Rate control admitted by explicit hardware-required encoding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
#[serde(deny_unknown_fields)]
pub enum VideoHardwareRateControl {
    AverageBitrate { kbps: u32 },
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

/// Explicit output geometry for Custom video encoding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
#[serde(deny_unknown_fields)]
pub enum VideoResize {
    Original,
    FitWithin { width: u32, height: u32 },
}

impl<'de> Deserialize<'de> for VideoResize {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictResize {
            Original {},
            FitWithin { width: u32, height: u32 },
        }
        Ok(match StrictResize::deserialize(deserializer)? {
            StrictResize::Original {} => Self::Original,
            StrictResize::FitWithin { width, height } => Self::FitWithin { width, height },
        })
    }
}

/// Explicit presentation-timing policy for Custom video encoding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
#[serde(deny_unknown_fields)]
pub enum VideoFrameRate {
    Preserve,
    Constant { numerator: u32, denominator: u32 },
}

impl<'de> Deserialize<'de> for VideoFrameRate {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictFrameRate {
            Preserve {},
            Constant { numerator: u32, denominator: u32 },
        }
        Ok(match StrictFrameRate::deserialize(deserializer)? {
            StrictFrameRate::Preserve {} => Self::Preserve,
            StrictFrameRate::Constant {
                numerator,
                denominator,
            } => Self::Constant {
                numerator,
                denominator,
            },
        })
    }
}

/// One observed exact rational or a probe value that was present but unusable.
/// Absence on the containing field means the probe value was missing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
#[serde(deny_unknown_fields)]
pub enum VideoRationalFact {
    Exact { numerator: u32, denominator: u32 },
    Malformed,
}

impl<'de> Deserialize<'de> for VideoRationalFact {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictRationalFact {
            Exact { numerator: u32, denominator: u32 },
            Malformed {},
        }
        Ok(match StrictRationalFact::deserialize(deserializer)? {
            StrictRationalFact::Exact {
                numerator,
                denominator,
            } => Self::Exact {
                numerator,
                denominator,
            },
            StrictRationalFact::Malformed {} => Self::Malformed,
        })
    }
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        resize: Option<VideoResize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        frame_rate: Option<VideoFrameRate>,
    },
    HardwareEncode {
        codec: VideoHardwareCodec,
        hardware_policy: VideoHardwarePolicy,
        rate_control: VideoHardwareRateControl,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        resize: Option<VideoResize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        frame_rate: Option<VideoFrameRate>,
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
                #[serde(default)]
                resize: Option<VideoResize>,
                #[serde(default)]
                frame_rate: Option<VideoFrameRate>,
            },
            HardwareEncode {
                codec: VideoHardwareCodec,
                hardware_policy: VideoHardwarePolicy,
                rate_control: VideoHardwareRateControl,
                #[serde(default, deserialize_with = "deserialize_present_option")]
                resize: Option<VideoResize>,
                #[serde(default, deserialize_with = "deserialize_present_option")]
                frame_rate: Option<VideoFrameRate>,
            },
        }
        Ok(match StrictOptions::deserialize(deserializer)? {
            StrictOptions::Copy {} => Self::Copy,
            StrictOptions::Encode {
                codec,
                rate_control,
                speed,
                processor,
                resize,
                frame_rate,
            } => Self::Encode {
                codec,
                rate_control,
                speed,
                processor,
                resize,
                frame_rate,
            },
            StrictOptions::HardwareEncode {
                codec,
                hardware_policy,
                rate_control,
                resize,
                frame_rate,
            } => Self::HardwareEncode {
                codec,
                hardware_policy,
                rate_control,
                resize,
                frame_rate,
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
        VideoConvertOptions::HardwareEncode {
            rate_control: VideoHardwareRateControl::AverageBitrate { kbps },
            ..
        } if !(100..=200_000).contains(kbps) => Err(GoopError::InvalidRequest(
            "Hardware video bitrate must be a whole number from 100 to 200000 kbps".into(),
        )),
        VideoConvertOptions::Encode {
            resize: Some(VideoResize::FitWithin { width, height }),
            ..
        }
        | VideoConvertOptions::HardwareEncode {
            resize: Some(VideoResize::FitWithin { width, height }),
            ..
        } if !(2..=32_768).contains(width) || !(2..=32_768).contains(height) => {
            Err(GoopError::InvalidRequest(
                "Video dimensions must be whole numbers from 2 to 32768 pixels".into(),
            ))
        }
        VideoConvertOptions::Encode {
            frame_rate:
                Some(VideoFrameRate::Constant {
                    numerator,
                    denominator,
                }),
            ..
        }
        | VideoConvertOptions::HardwareEncode {
            frame_rate:
                Some(VideoFrameRate::Constant {
                    numerator,
                    denominator,
                }),
            ..
        } if !matches!(
            (*numerator, *denominator),
            (24_000, 1_001)
                | (24, 1)
                | (25, 1)
                | (30_000, 1_001)
                | (30, 1)
                | (50, 1)
                | (60_000, 1_001)
                | (60, 1)
        ) =>
        {
            Err(GoopError::InvalidRequest(
                "Video frame rate must be one of the supported exact rates".into(),
            ))
        }
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
    if matches!(
        options,
        VideoConvertOptions::Encode {
            resize: Some(_),
            ..
        } | VideoConvertOptions::HardwareEncode {
            resize: Some(_),
            ..
        }
    ) && !matches!(request.resolution_cap, None | Some(ResolutionCap::Original))
    {
        return Err(GoopError::InvalidRequest(
            "New video dimensions cannot be combined with a legacy resolution cap".into(),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub average_frame_rate: Option<VideoRationalFact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub base_frame_rate: Option<VideoRationalFact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub time_base: Option<VideoRationalFact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable, type = "number")]
    pub start_time_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable, type = "number")]
    pub duration_ms: Option<u64>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub requested_resize: Option<VideoResize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub requested_frame_rate: Option<VideoFrameRate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub source_average_frame_rate: Option<VideoRationalFact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub source_base_frame_rate: Option<VideoRationalFact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub source_time_base: Option<VideoRationalFact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub resolved_constant_frame_rate: Option<VideoRationalFact>,
    pub notices: Vec<String>,
}

/// Engine-owned bounds and default for Custom video dimensions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoResizeCapabilities {
    pub available: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub reason: Option<String>,
    pub min_dimension: u32,
    pub max_dimension: u32,
    pub no_enlargement: bool,
    pub default: VideoResize,
}

/// One named exact constant frame-rate choice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoFrameRateChoice {
    pub frame_rate: VideoFrameRate,
    pub label: String,
}

/// Engine-owned source timing facts and supported Custom timing choices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoFrameRateCapabilities {
    pub available: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub reason: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub default: Option<VideoFrameRate>,
    pub constant_choices: Vec<VideoFrameRateChoice>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub average_frame_rate: Option<VideoRationalFact>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub base_frame_rate: Option<VideoRationalFact>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub time_base: Option<VideoRationalFact>,
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

/// Engine-owned eligibility for the explicit Hardware required mode. This is
/// compiled encoder and option-contract evidence, not proof of a usable device
/// session; runtime failure remains possible and never enables substitution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct VideoHardwareCapabilities {
    pub available: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub reason: Option<String>,
    pub codec: VideoHardwareCodec,
    pub bitrate_min_kbps: u32,
    pub bitrate_max_kbps: u32,
    pub default_bitrate_kbps: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub resize: Option<VideoResizeCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub frame_rate: Option<VideoFrameRateCapabilities>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub hardware: Option<VideoHardwareCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub resize: Option<VideoResizeCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub frame_rate: Option<VideoFrameRateCapabilities>,
    pub preview_available: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub preview_unavailable_reason: Option<String>,
}
