use crate::{compat::Plan, encoders::DetectedEncoders};
use goop_core::{
    validate_audio_request, AudioBitrate, AudioChannels, AudioConvertOptions,
    AudioExecutionSummary, AudioModeAvailability, AudioNumericFact, AudioSampleRate,
    AudioSettingsCapabilities, AudioStreamInfo, ConvertRequest, GoopError, ProbeResult,
    TargetFormat, VideoRationalFact,
};

#[derive(Debug, Clone)]
pub struct ResolvedAudio {
    pub plan: Plan,
    pub summary: AudioExecutionSummary,
}

fn invalid(message: impl Into<String>) -> GoopError {
    GoopError::InvalidRequest(message.into())
}

fn exact(fact: &Option<AudioNumericFact>) -> Option<u32> {
    match fact {
        Some(AudioNumericFact::Exact { value }) => Some(*value),
        _ => None,
    }
}

fn target_facts(target: TargetFormat) -> Option<(&'static str, &'static str, &'static [u32])> {
    match target {
        TargetFormat::Mp3 => Some(("mp3", "libmp3lame", &[64, 96, 128, 160, 192, 256, 320])),
        TargetFormat::M4a | TargetFormat::Aac => {
            Some(("aac", "aac", &[64, 96, 128, 160, 192, 256]))
        }
        TargetFormat::Wav => Some(("pcm_s16le", "pcm_s16le", &[])),
        TargetFormat::Flac => Some(("flac", "flac", &[])),
        _ => None,
    }
}

fn source_stream(probe: &ProbeResult) -> Result<&AudioStreamInfo, GoopError> {
    let details = probe.audio_details.as_ref().ok_or_else(|| {
        invalid("Explicit audio settings require complete fresh audio stream facts")
    })?;
    if details.streams.len() != 1 {
        return Err(invalid(
            "Choose Automatic until audio-track selection is available",
        ));
    }
    Ok(&details.streams[0])
}

fn source_stream_for_request<'a>(
    request: &ConvertRequest,
    probe: &'a ProbeResult,
) -> Result<&'a AudioStreamInfo, GoopError> {
    if request.track_options.is_some() {
        crate::track_options::selected_audio_stream(request, probe)
    } else {
        source_stream(probe)
    }
}

#[derive(Debug)]
struct ValidatedAudio<'a> {
    copied: bool,
    sample_rate_hz: u32,
    channels: u32,
    channel_layout: Option<&'a str>,
    sample_format: Option<&'a str>,
    bit_depth: Option<u32>,
}

fn validate_options_for_stream<'a>(
    requested: &AudioConvertOptions,
    source: &'a AudioStreamInfo,
    target: TargetFormat,
    encoders: &DetectedEncoders,
) -> Result<ValidatedAudio<'a>, GoopError> {
    let (codec, encoder, _) = target_facts(target)
        .ok_or_else(|| invalid("This output does not support explicit audio settings"))?;
    let source_channels = exact(&source.channels).filter(|value| *value > 0);
    let source_rate = exact(&source.sample_rate_hz);
    match requested {
        AudioConvertOptions::Copy => {
            if source.codec_name.as_deref() != Some(codec) {
                return Err(invalid(format!(
                    "Copy audio requires {codec} source audio for this output"
                )));
            }
            let sample_rate_hz = source_rate
                .filter(|value| *value > 0)
                .ok_or_else(|| invalid("Copy audio requires a reported sample rate"))?;
            let channels = source_channels
                .ok_or_else(|| invalid("Copy audio requires a reported channel count"))?;
            Ok(ValidatedAudio {
                copied: true,
                sample_rate_hz,
                channels,
                channel_layout: source.channel_layout.as_deref(),
                sample_format: source.sample_format.as_deref(),
                bit_depth: exact(&source.bits_per_raw_sample).filter(|value| *value > 0),
            })
        }
        AudioConvertOptions::Encode {
            channels,
            sample_rate,
            ..
        } => {
            let source_channels = source_channels
                .filter(|value| matches!(value, 1 | 2))
                .ok_or_else(|| {
                    invalid(
                        "Custom audio settings require a source with exactly one or two reported channels",
                    )
                })?;
            if !encoders.is_available(encoder) {
                return Err(invalid(format!(
                    "Custom audio encoding requires the {encoder} encoder"
                )));
            }
            let channel_layout = match channels {
                AudioChannels::Preserve => source.channel_layout.as_deref(),
                AudioChannels::Mono => Some("mono"),
                AudioChannels::Stereo => Some("stereo"),
            };
            let channels = match channels {
                AudioChannels::Preserve => source_channels,
                AudioChannels::Mono => 1,
                AudioChannels::Stereo => 2,
            };
            let sample_rate_hz = match sample_rate {
                AudioSampleRate::Preserve => source_rate
                    .filter(|value| matches!(value, 44_100 | 48_000))
                    .ok_or_else(|| {
                        invalid(
                            "Preserve sample rate requires reported 44100 or 48000 Hz source audio",
                        )
                    })?,
                AudioSampleRate::Exact { hz } => *hz,
            };
            Ok(ValidatedAudio {
                copied: false,
                sample_rate_hz,
                channels,
                channel_layout,
                sample_format: None,
                bit_depth: (target == TargetFormat::Wav).then_some(16),
            })
        }
    }
}

pub fn resolve(
    request: &ConvertRequest,
    probe: &ProbeResult,
    encoders: &DetectedEncoders,
) -> Result<ResolvedAudio, GoopError> {
    validate_audio_request(request)?;
    let requested = request
        .audio_options
        .as_ref()
        .ok_or_else(|| invalid("Explicit audio settings are missing"))?;
    let (codec, encoder, _) = target_facts(request.target)
        .ok_or_else(|| invalid("This output does not support explicit audio settings"))?;
    let source = source_stream_for_request(request, probe)?;
    let validated = validate_options_for_stream(requested, source, request.target, encoders)?;
    let notice = probe
        .audio_details
        .as_ref()
        .is_some_and(|details| details.has_non_audio_streams && request.track_options.is_none())
        .then(|| "Non-audio streams and artwork are not included".to_owned());

    let mut args = vec![
        "-map".into(),
        format!("0:{}", source.index),
        "-vn".into(),
        "-sn".into(),
        "-dn".into(),
    ];
    match requested {
        AudioConvertOptions::Copy => args.extend(["-c:a".into(), "copy".into()]),
        AudioConvertOptions::Encode {
            bitrate,
            channels,
            sample_rate,
        } => {
            args.extend(["-c:a".into(), encoder.into()]);
            if let Some(AudioBitrate::Target { kbps }) = bitrate {
                args.extend(["-b:a".into(), format!("{kbps}k")]);
            }
            match channels {
                AudioChannels::Preserve => {}
                AudioChannels::Mono if exact(&source.channels) == Some(2) => {
                    args.extend(["-af".into(), "pan=mono|c0=0.5*c0+0.5*c1".into()]);
                }
                AudioChannels::Mono => args.extend(["-ac".into(), "1".into()]),
                AudioChannels::Stereo => args.extend(["-ac".into(), "2".into()]),
            }
            if let AudioSampleRate::Exact { hz } = sample_rate {
                args.extend(["-ar".into(), hz.to_string()]);
            }
        }
    }

    Ok(ResolvedAudio {
        plan: Plan {
            args,
            video_filters: vec![],
            reencoded: !validated.copied,
            ext: request.target.extension(),
        },
        summary: AudioExecutionSummary {
            requested: requested.clone(),
            encoder: (!validated.copied).then(|| encoder.to_owned()),
            codec: codec.into(),
            audio_stream_index: source.index,
            copied: validated.copied,
            sample_rate_hz: validated.sample_rate_hz,
            channels: validated.channels,
            channel_layout: validated.channel_layout.map(str::to_owned),
            sample_format: validated.sample_format.map(str::to_owned),
            bit_depth: validated.bit_depth,
            reported_bitrate_kbps: if validated.copied {
                exact(&source.bit_rate_bps).map(|bps| bps / 1_000)
            } else {
                None
            },
            notices: notice.into_iter().collect(),
        },
    })
}

fn availability<T>(result: Result<T, GoopError>) -> AudioModeAvailability {
    match result {
        Ok(_) => AudioModeAvailability {
            available: true,
            reason: None,
        },
        Err(error) => AudioModeAvailability {
            available: false,
            reason: Some(error.user_message()),
        },
    }
}

pub fn capabilities(
    probe: &ProbeResult,
    target: TargetFormat,
    encoders: &DetectedEncoders,
) -> AudioSettingsCapabilities {
    capabilities_for_source(source_stream(probe), target, encoders)
}

pub(crate) fn mode_availability_for_stream(
    source: Option<&AudioStreamInfo>,
    target: TargetFormat,
    encoders: &DetectedEncoders,
) -> (AudioModeAvailability, AudioModeAvailability) {
    let (_, _, bitrates) = target_facts(target).unwrap_or(("unsupported", "unsupported", &[]));
    let evaluated = evaluate_capabilities(
        source.ok_or_else(|| {
            invalid("Explicit audio settings require complete fresh audio stream facts")
        }),
        target,
        encoders,
        bitrates,
    );
    (evaluated.copy, evaluated.encode)
}

struct EvaluatedCapabilities<'a> {
    source: Option<&'a AudioStreamInfo>,
    copy: AudioModeAvailability,
    encode: AudioModeAvailability,
    default_channels: Option<AudioChannels>,
    default_sample_rate: Option<AudioSampleRate>,
}

fn evaluate_capabilities<'a>(
    source: Result<&'a AudioStreamInfo, GoopError>,
    target: TargetFormat,
    encoders: &DetectedEncoders,
    bitrates: &[u32],
) -> EvaluatedCapabilities<'a> {
    let (source, source_error) = match source {
        Ok(source) => (Some(source), None),
        Err(error) => (None, Some(error.user_message())),
    };
    let source_rate = source.and_then(|stream| exact(&stream.sample_rate_hz));
    let source_channels = source.and_then(|stream| exact(&stream.channels));
    let default_sample_rate = if matches!(source_rate, Some(44_100 | 48_000)) {
        Some(AudioSampleRate::Preserve)
    } else {
        Some(AudioSampleRate::Exact { hz: 48_000 })
    };
    let default_channels =
        matches!(source_channels, Some(1 | 2)).then_some(AudioChannels::Preserve);
    let encode = AudioConvertOptions::Encode {
        bitrate: (!bitrates.is_empty()).then_some(AudioBitrate::Target { kbps: 192 }),
        channels: default_channels.unwrap_or(AudioChannels::Preserve),
        sample_rate: default_sample_rate.unwrap_or(AudioSampleRate::Exact { hz: 48_000 }),
    };
    let unavailable = |reason: &str| AudioModeAvailability {
        available: false,
        reason: Some(reason.to_owned()),
    };
    let copy = match source {
        Some(source) => availability(validate_options_for_stream(
            &AudioConvertOptions::Copy,
            source,
            target,
            encoders,
        )),
        None => unavailable(
            source_error
                .as_deref()
                .unwrap_or("Audio facts are unavailable"),
        ),
    };
    let encode_availability = match source {
        Some(source) => availability(validate_options_for_stream(
            &encode, source, target, encoders,
        )),
        None => unavailable(
            source_error
                .as_deref()
                .unwrap_or("Audio facts are unavailable"),
        ),
    };
    EvaluatedCapabilities {
        source,
        copy,
        encode: encode_availability,
        default_channels,
        default_sample_rate,
    }
}

fn capabilities_for_source(
    source: Result<&AudioStreamInfo, GoopError>,
    target: TargetFormat,
    encoders: &DetectedEncoders,
) -> AudioSettingsCapabilities {
    let (codec, encoder, bitrates) =
        target_facts(target).unwrap_or(("unsupported", "unsupported", &[]));
    let evaluated = evaluate_capabilities(source, target, encoders, bitrates);
    AudioSettingsCapabilities {
        copy: evaluated.copy,
        encode: evaluated.encode,
        target_codec: codec.into(),
        encoder: encoder.into(),
        bitrate_choices_kbps: bitrates.to_vec(),
        default_bitrate_kbps: (!bitrates.is_empty()).then_some(192),
        channel_choices: vec![
            AudioChannels::Preserve,
            AudioChannels::Mono,
            AudioChannels::Stereo,
        ],
        default_channels: evaluated.default_channels,
        sample_rate_choices: vec![
            AudioSampleRate::Preserve,
            AudioSampleRate::Exact { hz: 44_100 },
            AudioSampleRate::Exact { hz: 48_000 },
        ],
        default_sample_rate: evaluated.default_sample_rate,
        source: evaluated.source.cloned(),
    }
}

pub fn validate_output_against_source(
    expected: &AudioExecutionSummary,
    source: &ProbeResult,
    actual: &ProbeResult,
) -> Result<AudioExecutionSummary, GoopError> {
    let source_audio = source
        .audio_details
        .as_ref()
        .and_then(|details| {
            details
                .streams
                .iter()
                .find(|stream| stream.index == expected.audio_stream_index)
        })
        .ok_or_else(|| invalid("Admitted source audio facts are no longer complete"))?;
    let stream = source_stream(actual).map_err(|_| {
        invalid("Completed audio output did not contain exactly one verified audio stream")
    })?;
    if actual
        .audio_details
        .as_ref()
        .is_some_and(|details| details.has_non_audio_streams)
    {
        return Err(invalid(
            "Completed audio output contains an unexpected non-audio stream",
        ));
    }
    let rate = exact(&stream.sample_rate_hz)
        .ok_or_else(|| invalid("Completed audio output has no verified sample rate"))?;
    let channels = exact(&stream.channels)
        .ok_or_else(|| invalid("Completed audio output has no verified channel count"))?;
    if stream.codec_name.as_deref() != Some(expected.codec.as_str())
        || rate != expected.sample_rate_hz
        || channels != expected.channels
    {
        return Err(invalid(
            "Completed audio output does not match the admitted codec, sample rate and channels",
        ));
    }

    let source_rate = exact(&source_audio.sample_rate_hz).filter(|value| *value > 0);
    let codec_allowance = |codec: Option<&str>, sample_rate: Option<u32>| -> u64 {
        let frames: u64 = match codec {
            Some("aac") => 2 * 1_024,
            Some("mp3") => 2 * 1_152,
            _ => 1,
        };
        sample_rate
            .map(|value| frames * 1_000_u64 / u64::from(value) + 1)
            .unwrap_or(0)
    };
    let tick_allowance = |fact: &Option<VideoRationalFact>, label: &str| match fact {
        Some(VideoRationalFact::Exact {
            numerator,
            denominator,
        }) if *numerator > 0 && *denominator > 0 => {
            Ok(u64::from(*numerator) * 1_000_u64 / u64::from(*denominator) + 1)
        }
        _ => Err(invalid(format!("{label} has no verified stream time base"))),
    };
    let source_duration = source_audio
        .duration_ms
        .filter(|duration| *duration > 0)
        .ok_or_else(|| invalid("Admitted source audio has no verified stream duration"))?;
    let output_duration = stream
        .duration_ms
        .filter(|duration| *duration > 0)
        .ok_or_else(|| invalid("Completed audio output has no verified stream duration"))?;
    let allowance = codec_allowance(source_audio.codec_name.as_deref(), source_rate)
        + codec_allowance(Some(expected.codec.as_str()), Some(rate))
        + tick_allowance(&source_audio.time_base, "Admitted source audio")?
        + tick_allowance(&stream.time_base, "Completed audio output")?;
    if source_duration.abs_diff(output_duration) > allowance {
        return Err(invalid(
            "Completed audio output duration is outside the codec allowance",
        ));
    }

    let mut completed = expected.clone();
    completed.sample_rate_hz = rate;
    completed.channels = channels;
    completed.channel_layout = stream.channel_layout.clone();
    completed.sample_format = stream.sample_format.clone();
    completed.bit_depth = exact(&stream.bits_per_raw_sample).filter(|value| *value > 0);
    completed.reported_bitrate_kbps = exact(&stream.bit_rate_bps).map(|bps| bps / 1_000);
    Ok(completed)
}
