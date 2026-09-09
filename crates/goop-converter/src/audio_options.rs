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
    let source = source_stream(probe)?;
    let source_channels = exact(&source.channels).filter(|value| *value > 0);
    let source_rate = exact(&source.sample_rate_hz);
    let notice = probe
        .audio_details
        .as_ref()
        .is_some_and(|details| details.has_non_audio_streams)
        .then(|| "Non-audio streams and artwork are not included".to_owned());

    let mut args = vec![
        "-map".into(),
        format!("0:{}", source.index),
        "-vn".into(),
        "-sn".into(),
        "-dn".into(),
    ];
    let (copied, sample_rate_hz, channels, channel_layout, sample_format, bit_depth) =
        match requested {
            AudioConvertOptions::Copy => {
                if source.codec_name.as_deref() != Some(codec) {
                    return Err(invalid(format!(
                        "Copy audio requires {codec} source audio for this output"
                    )));
                }
                let rate = source_rate
                    .filter(|value| *value > 0)
                    .ok_or_else(|| invalid("Copy audio requires a reported sample rate"))?;
                let channels = source_channels
                    .ok_or_else(|| invalid("Copy audio requires a reported channel count"))?;
                args.extend(["-c:a".into(), "copy".into()]);
                (
                    true,
                    rate,
                    channels,
                    source.channel_layout.clone(),
                    source.sample_format.clone(),
                    exact(&source.bits_per_raw_sample).filter(|value| *value > 0),
                )
            }
            AudioConvertOptions::Encode {
                bitrate,
                channels,
                sample_rate,
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
                args.extend(["-c:a".into(), encoder.into()]);
                if let Some(AudioBitrate::Target { kbps }) = bitrate {
                    args.extend(["-b:a".into(), format!("{kbps}k")]);
                }
                let output_channels = match channels {
                    AudioChannels::Preserve => source_channels,
                    AudioChannels::Mono => {
                        if source_channels == 2 {
                            args.extend(["-af".into(), "pan=mono|c0=0.5*c0+0.5*c1".into()]);
                        } else {
                            args.extend(["-ac".into(), "1".into()]);
                        }
                        1
                    }
                    AudioChannels::Stereo => {
                        args.extend(["-ac".into(), "2".into()]);
                        2
                    }
                };
                let output_rate = match sample_rate {
                    AudioSampleRate::Preserve => source_rate
                        .filter(|value| matches!(value, 44_100 | 48_000))
                        .ok_or_else(|| {
                            invalid(
                                "Preserve sample rate requires reported 44100 or 48000 Hz source audio",
                            )
                        })?,
                    AudioSampleRate::Exact { hz } => {
                        args.extend(["-ar".into(), hz.to_string()]);
                        *hz
                    }
                };
                (
                    false,
                    output_rate,
                    output_channels,
                    match channels {
                        AudioChannels::Preserve => source.channel_layout.clone(),
                        AudioChannels::Mono => Some("mono".into()),
                        AudioChannels::Stereo => Some("stereo".into()),
                    },
                    None,
                    (request.target == TargetFormat::Wav).then_some(16),
                )
            }
        };

    Ok(ResolvedAudio {
        plan: Plan {
            args,
            video_filters: vec![],
            reencoded: !copied,
            ext: request.target.extension(),
        },
        summary: AudioExecutionSummary {
            requested: requested.clone(),
            encoder: (!copied).then(|| encoder.to_owned()),
            codec: codec.into(),
            audio_stream_index: source.index,
            copied,
            sample_rate_hz,
            channels,
            channel_layout,
            sample_format,
            bit_depth,
            reported_bitrate_kbps: if copied {
                exact(&source.bit_rate_bps).map(|bps| bps / 1_000)
            } else {
                None
            },
            notices: notice.into_iter().collect(),
        },
    })
}

fn availability(result: Result<ResolvedAudio, GoopError>) -> AudioModeAvailability {
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
    let (codec, encoder, bitrates) =
        target_facts(target).unwrap_or(("unsupported", "unsupported", &[]));
    let request = |audio_options| ConvertRequest {
        audio_options: Some(audio_options),
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
        subtitle: None,
        image_options: None,
    };
    let source = probe
        .audio_details
        .as_ref()
        .and_then(|details| (details.streams.len() == 1).then(|| details.streams[0].clone()));
    let source_rate = source
        .as_ref()
        .and_then(|stream| exact(&stream.sample_rate_hz));
    let source_channels = source.as_ref().and_then(|stream| exact(&stream.channels));
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
    AudioSettingsCapabilities {
        copy: availability(resolve(
            &request(AudioConvertOptions::Copy),
            probe,
            encoders,
        )),
        encode: availability(resolve(&request(encode), probe, encoders)),
        target_codec: codec.into(),
        encoder: encoder.into(),
        bitrate_choices_kbps: bitrates.to_vec(),
        default_bitrate_kbps: (!bitrates.is_empty()).then_some(192),
        channel_choices: vec![
            AudioChannels::Preserve,
            AudioChannels::Mono,
            AudioChannels::Stereo,
        ],
        default_channels,
        sample_rate_choices: vec![
            AudioSampleRate::Preserve,
            AudioSampleRate::Exact { hz: 44_100 },
            AudioSampleRate::Exact { hz: 48_000 },
        ],
        default_sample_rate,
        source,
    }
}

pub fn validate_output_against_source(
    expected: &AudioExecutionSummary,
    source: &ProbeResult,
    actual: &ProbeResult,
) -> Result<AudioExecutionSummary, GoopError> {
    let source_audio = source_stream(source)
        .map_err(|_| invalid("Admitted source audio facts are no longer complete"))?;
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
