use crate::{ConvertRequest, GoopError, TargetFormat, VideoRationalFact};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AudioBitrate {
    Target { kbps: u32 },
}

impl<'de> Deserialize<'de> for AudioBitrate {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictBitrate {
            Target { kbps: u32 },
        }
        Ok(match StrictBitrate::deserialize(deserializer)? {
            StrictBitrate::Target { kbps } => Self::Target { kbps },
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AudioChannels {
    Preserve,
    Mono,
    Stereo,
}

impl<'de> Deserialize<'de> for AudioChannels {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictChannels {
            Preserve {},
            Mono {},
            Stereo {},
        }
        Ok(match StrictChannels::deserialize(deserializer)? {
            StrictChannels::Preserve {} => Self::Preserve,
            StrictChannels::Mono {} => Self::Mono,
            StrictChannels::Stereo {} => Self::Stereo,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AudioSampleRate {
    Preserve,
    Exact { hz: u32 },
}

impl<'de> Deserialize<'de> for AudioSampleRate {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictSampleRate {
            Preserve {},
            Exact { hz: u32 },
        }
        Ok(match StrictSampleRate::deserialize(deserializer)? {
            StrictSampleRate::Preserve {} => Self::Preserve,
            StrictSampleRate::Exact { hz } => Self::Exact { hz },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AudioConvertOptions {
    Copy,
    Encode {
        #[ts(optional = nullable)]
        bitrate: Option<AudioBitrate>,
        channels: AudioChannels,
        sample_rate: AudioSampleRate,
    },
}

impl<'de> Deserialize<'de> for AudioConvertOptions {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictOptions {
            Copy {},
            Encode {
                bitrate: Option<AudioBitrate>,
                channels: AudioChannels,
                sample_rate: AudioSampleRate,
            },
        }
        Ok(match StrictOptions::deserialize(deserializer)? {
            StrictOptions::Copy {} => Self::Copy,
            StrictOptions::Encode {
                bitrate,
                channels,
                sample_rate,
            } => Self::Encode {
                bitrate,
                channels,
                sample_rate,
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AudioNumericFact {
    Exact { value: u32 },
    Malformed,
}

impl<'de> Deserialize<'de> for AudioNumericFact {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictNumericFact {
            Exact { value: u32 },
            Malformed {},
        }
        Ok(match StrictNumericFact::deserialize(deserializer)? {
            StrictNumericFact::Exact { value } => Self::Exact { value },
            StrictNumericFact::Malformed {} => Self::Malformed,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct AudioStreamInfo {
    pub index: u32,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub codec_name: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub sample_rate_hz: Option<AudioNumericFact>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub channels: Option<AudioNumericFact>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub channel_layout: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub sample_format: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub bits_per_raw_sample: Option<AudioNumericFact>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub bit_rate_bps: Option<AudioNumericFact>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub time_base: Option<VideoRationalFact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable, type = "number")]
    pub start_time_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable, type = "number")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct AudioProbeDetails {
    pub streams: Vec<AudioStreamInfo>,
    pub has_non_audio_streams: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct AudioModeAvailability {
    pub available: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct AudioSettingsCapabilities {
    pub copy: AudioModeAvailability,
    pub encode: AudioModeAvailability,
    pub target_codec: String,
    pub encoder: String,
    pub bitrate_choices_kbps: Vec<u32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub default_bitrate_kbps: Option<u32>,
    pub channel_choices: Vec<AudioChannels>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub default_channels: Option<AudioChannels>,
    pub sample_rate_choices: Vec<AudioSampleRate>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub default_sample_rate: Option<AudioSampleRate>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub source: Option<AudioStreamInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct AudioExecutionSummary {
    pub requested: AudioConvertOptions,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub encoder: Option<String>,
    pub codec: String,
    pub audio_stream_index: u32,
    pub copied: bool,
    pub sample_rate_hz: u32,
    pub channels: u32,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub channel_layout: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub sample_format: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub bit_depth: Option<u32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub reported_bitrate_kbps: Option<u32>,
    pub notices: Vec<String>,
}

pub fn validate_audio_request(request: &ConvertRequest) -> Result<(), GoopError> {
    let Some(options) = &request.audio_options else {
        return Ok(());
    };
    if !matches!(
        request.target,
        TargetFormat::Mp3
            | TargetFormat::M4a
            | TargetFormat::Aac
            | TargetFormat::Wav
            | TargetFormat::Flac
    ) {
        return Err(GoopError::InvalidRequest(
            "Explicit audio settings require MP3, M4A, AAC, WAV or FLAC output".into(),
        ));
    }
    if request.video_options.is_some()
        || request.quality_preset.is_some()
        || request.resolution_cap.is_some()
        || request.compress_mode.is_some()
        || request.image_options.is_some()
        || request.gif_options.is_some()
        || request.subtitle.is_some()
    {
        return Err(GoopError::InvalidRequest(
            "Explicit audio settings cannot be combined with video, image, compression, GIF or subtitle settings".into(),
        ));
    }
    if let AudioConvertOptions::Encode {
        bitrate,
        sample_rate,
        ..
    } = options
    {
        let rates: &[u32] = match request.target {
            TargetFormat::Mp3 => &[64, 96, 128, 160, 192, 256, 320],
            TargetFormat::M4a | TargetFormat::Aac => &[64, 96, 128, 160, 192, 256],
            TargetFormat::Wav | TargetFormat::Flac => &[],
            _ => unreachable!(),
        };
        match (rates.is_empty(), bitrate) {
            (false, Some(AudioBitrate::Target { kbps })) if rates.contains(kbps) => {}
            (false, _) => {
                return Err(GoopError::InvalidRequest(
                    "This audio output requires one of its supported bitrate targets".into(),
                ))
            }
            (true, None) => {}
            (true, Some(_)) => {
                return Err(GoopError::InvalidRequest(
                    "WAV and FLAC do not accept an audio bitrate target".into(),
                ))
            }
        }
        if matches!(sample_rate, AudioSampleRate::Exact { hz } if !matches!(hz, 44_100 | 48_000)) {
            return Err(GoopError::InvalidRequest(
                "Audio sample rate must be 44100 or 48000 Hz".into(),
            ));
        }
    }
    Ok(())
}
