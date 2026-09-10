//! Exact-map multi-stream policies for explicit video conversions.

use crate::{compat::Plan, encoders::DetectedEncoders};
use goop_core::*;
use goop_sidecar::BinaryResolver;
use serde::Deserialize;
use std::path::Path;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub struct ResolvedVideoTrackPlan {
    pub plan: Plan,
    pub video_summary: VideoExecutionSummary,
    pub track_summary: VideoTrackExecutionSummary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StreamCodecTag {
    index: u32,
    tag: TrackTextFact,
    handler_title: TrackTextFact,
}

pub(crate) async fn probe_codec_tags(
    resolver: &BinaryResolver,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<Vec<StreamCodecTag>, GoopError> {
    #[derive(Deserialize)]
    struct Root {
        #[serde(default)]
        streams: Vec<Stream>,
    }
    #[derive(Deserialize)]
    struct Stream {
        index: u32,
        codec_tag_string: Option<String>,
        #[serde(default)]
        tags: Option<Tags>,
    }
    #[derive(Deserialize)]
    struct Tags {
        handler_name: Option<String>,
    }

    let bin = resolver.resolve("ffprobe")?;
    let output = crate::bounded_process::output(
        Command::new(&bin.path)
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_entries",
                "stream=index,codec_tag_string:stream_tags=handler_name",
            ])
            .arg(path),
        "ffprobe",
        cancel,
    )
    .await?;
    if !output.status.success() {
        return Err(invalid(format!(
            "ffprobe could not verify stream codec tags: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    let root: Root = serde_json::from_slice(&output.stdout)?;
    let mut previous = None;
    root.streams
        .into_iter()
        .map(|stream| {
            if previous.is_some_and(|index| index >= stream.index) {
                return Err(invalid("Codec-tag probe indices are not strictly ordered"));
            }
            previous = Some(stream.index);
            let tag = match stream.codec_tag_string {
                Some(value) if !value.is_empty() => TrackTextFact::Value { value },
                Some(_) | None => TrackTextFact::Missing,
            };
            let handler_title = match stream.tags.and_then(|tags| tags.handler_name) {
                Some(value)
                    if !value.is_empty()
                        && !matches!(
                            value.as_str(),
                            "VideoHandler" | "SoundHandler" | "SubtitleHandler"
                        ) =>
                {
                    TrackTextFact::Value { value }
                }
                Some(_) | None => TrackTextFact::Missing,
            };
            goop_core::validate_track_text_fact(&tag)?;
            goop_core::validate_track_text_fact(&handler_title)?;
            Ok(StreamCodecTag {
                index: stream.index,
                tag,
                handler_title,
            })
        })
        .collect()
}

fn required_tag(
    tags: &[StreamCodecTag],
    index: u32,
    label: &str,
) -> Result<TrackTextFact, GoopError> {
    let tag = tags
        .iter()
        .find(|fact| fact.index == index)
        .map(|fact| fact.tag.clone())
        .ok_or_else(|| {
            invalid(format!(
                "{label} codec tag is unavailable for stream {index}"
            ))
        })?;
    if !matches!(&tag, TrackTextFact::Value { value } if !value.is_empty()) {
        return Err(invalid(format!(
            "{label} codec tag is missing for stream {index}"
        )));
    }
    Ok(tag)
}

pub(crate) fn populate_source_codec_tags(
    summary: &mut VideoTrackExecutionSummary,
    tags: &[StreamCodecTag],
) -> Result<(), GoopError> {
    for outcome in &mut summary.retained {
        outcome.source_codec_tag = required_tag(tags, outcome.source.index, "Source")?;
    }
    Ok(())
}

fn expected_output_codec_tag(target: TargetFormat, codec: &str) -> Option<&'static str> {
    match target {
        TargetFormat::Mp4 => match codec {
            "aac" | "mp3" => Some("mp4a"),
            "ac3" => Some("ac-3"),
            "eac3" => Some("ec-3"),
            "alac" => Some("alac"),
            "flac" => Some("fLaC"),
            "opus" => Some("Opus"),
            "mov_text" => Some("tx3g"),
            _ => None,
        },
        TargetFormat::Mov => match codec {
            "aac" => Some("mp4a"),
            "mp3" => Some(".mp3"),
            "ac3" => Some("ac-3"),
            "eac3" => Some("ec-3"),
            "alac" => Some("alac"),
            "dts" => Some("dtsc"),
            "pcm_s16le" => Some("sowt"),
            "mov_text" => Some("text"),
            _ => None,
        },
        TargetFormat::Mkv => Some("[0][0][0][0]"),
        _ => None,
    }
}

fn validate_output_codec_tag(
    target: TargetFormat,
    codec: &str,
    tag: &TrackTextFact,
) -> Result<(), GoopError> {
    let expected = expected_output_codec_tag(target, codec).ok_or_else(|| {
        invalid(format!(
            "No verified {} container tag exists for {codec}",
            target.extension()
        ))
    })?;
    if !matches!(tag, TrackTextFact::Value { value } if value == expected) {
        return Err(invalid(format!(
            "Completed output has container tag {tag:?}, expected {expected} for {codec}"
        )));
    }
    Ok(())
}

pub(crate) fn populate_output_codec_tags(
    summary: &mut VideoTrackExecutionSummary,
    tags: &[StreamCodecTag],
    target: TargetFormat,
) -> Result<(), GoopError> {
    for outcome in &mut summary.retained {
        let tag = required_tag(tags, outcome.output_stream_index, "Completed output")?;
        let codec = codec_value_from_fact(&outcome.output_codec_name).ok_or_else(|| {
            invalid(format!(
                "Completed output codec is unavailable for stream {}",
                outcome.output_stream_index
            ))
        })?;
        validate_output_codec_tag(target, codec, &tag)?;
        outcome.output_codec_tag = tag;
    }
    Ok(())
}

pub(crate) fn validate_output_container_facts(
    summary: &mut VideoTrackExecutionSummary,
    actual: &ProbeResult,
    tags: &[StreamCodecTag],
    target: TargetFormat,
) -> Result<(), GoopError> {
    populate_output_codec_tags(summary, tags, target)?;
    if !matches!(target, TargetFormat::Mp4 | TargetFormat::Mov) {
        return Ok(());
    }
    let inventory = actual
        .track_inventory
        .as_ref()
        .ok_or_else(|| invalid("Completed video is missing its verified stream inventory"))?;
    for outcome in &summary.retained {
        let actual_track = inventory
            .streams
            .iter()
            .find(|track| track.index == outcome.output_stream_index)
            .ok_or_else(|| invalid("Completed auxiliary stream is unavailable"))?;
        let actual_title = if matches!(actual_track.title, TrackTextFact::Missing)
            && matches!(outcome.output_title, TrackTextFact::Value { .. })
        {
            tags.iter()
                .find(|facts| facts.index == outcome.output_stream_index)
                .map(|facts| &facts.handler_title)
                .unwrap_or(&actual_track.title)
        } else {
            &actual_track.title
        };
        if actual_title != &outcome.output_title {
            return Err(invalid(format!(
                "Completed auxiliary stream {} does not preserve its title",
                outcome.output_stream_index
            )));
        }
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> GoopError {
    GoopError::InvalidRequest(message.into())
}

fn codec_value(track: &TrackIdentity) -> Result<&str, GoopError> {
    match &track.codec_name {
        TrackTextFact::Value { value } if !value.is_empty() => Ok(value),
        _ => Err(invalid(format!(
            "Retained {} stream {} requires a known codec",
            track.codec_type, track.index
        ))),
    }
}

fn text_value(fact: &TrackTextFact) -> Option<&str> {
    match fact {
        TrackTextFact::Value { value } => Some(value),
        TrackTextFact::Missing | TrackTextFact::Malformed => None,
    }
}

fn codec_value_from_fact(fact: &TrackTextFact) -> Option<&str> {
    match fact {
        TrackTextFact::Value { value } if !value.is_empty() => Some(value),
        TrackTextFact::Value { .. } | TrackTextFact::Missing | TrackTextFact::Malformed => None,
    }
}

fn policy_retains(policy: &TrackStreamPolicy, index: u32) -> bool {
    match policy {
        TrackStreamPolicy::KeepAll => true,
        TrackStreamPolicy::Choose { stream_indices } => stream_indices.contains(&index),
        TrackStreamPolicy::None => false,
    }
}

fn subtitle_copyable(target: TargetFormat, codec: &str) -> bool {
    match target {
        TargetFormat::Mp4 | TargetFormat::Mov => codec == "mov_text",
        TargetFormat::Mkv => ["subrip", "ass", "ssa", "webvtt"].contains(&codec),
        _ => false,
    }
}

fn audio_copyable(target: TargetFormat, codec: &str) -> bool {
    if target == TargetFormat::Mkv {
        return [
            "aac",
            "mp3",
            "mp2",
            "ac3",
            "eac3",
            "alac",
            "flac",
            "opus",
            "vorbis",
            "dts",
            "truehd",
            "pcm_s16le",
            "pcm_s24le",
            "pcm_s32le",
            "pcm_f32le",
            "pcm_f64le",
        ]
        .contains(&codec);
    }
    crate::subtitle::copyable_audio_codecs(target).is_some_and(|allowed| allowed.contains(&codec))
}

fn video_options(request: &ConvertRequest) -> Result<&TrackConvertOptions, GoopError> {
    match request.track_options.as_ref() {
        Some(options @ TrackConvertOptions::Video { .. }) => Ok(options),
        _ => Err(invalid(
            "Explicit video track policies require a source-bound video policy",
        )),
    }
}

fn validate_fresh_source(
    options: &TrackConvertOptions,
    probe: &ProbeResult,
) -> Result<(), GoopError> {
    goop_core::validate_track_options(options)?;
    let TrackConvertOptions::Video { source, .. } = options else {
        return Err(invalid("Expected video track policies"));
    };
    if probe.track_inventory.as_ref() != Some(&source.inventory) {
        return Err(invalid(
            "The source track inventory changed; reinspect it before converting",
        ));
    }
    let details = probe
        .video_details
        .as_ref()
        .ok_or_else(|| invalid("Video track policies require complete fresh processing facts"))?;
    if details.streams.len() != source.inventory.streams.len() {
        return Err(invalid(
            "Fresh processing facts do not cover the complete source inventory",
        ));
    }
    for (identity, facts) in source.inventory.streams.iter().zip(&details.streams) {
        if identity.index != facts.index || identity.codec_type != facts.codec_type {
            return Err(invalid(
                "Fresh processing facts do not match the bound source order and types",
            ));
        }
        if let TrackTextFact::Value { value } = &identity.codec_name {
            if facts.codec_name.as_deref() != Some(value) {
                return Err(invalid(
                    "Fresh processing codec facts do not match the bound source",
                ));
            }
        }
    }
    Ok(())
}

fn push_metadata_and_disposition(
    args: &mut Vec<String>,
    track: &TrackIdentity,
    target: TargetFormat,
    family: &str,
    ordinal: u32,
) {
    let selector = format!("{family}:{ordinal}");
    for (name, fact) in [("language", &track.language), ("title", &track.title)] {
        if let Some(value) = text_value(fact) {
            let name = if name == "title" && matches!(target, TargetFormat::Mp4 | TargetFormat::Mov)
            {
                "handler_name"
            } else {
                name
            };
            args.extend([format!("-metadata:s:{selector}"), format!("{name}={value}")]);
        }
    }
    let mut values = Vec::new();
    if track.disposition.default == Some(true) {
        values.push("default");
    }
    if track.disposition.forced == Some(true) {
        values.push("forced");
    }
    args.extend([
        format!("-disposition:{selector}"),
        if values.is_empty() {
            "0".into()
        } else {
            values.join("+")
        },
    ]);
}

pub fn resolve(
    request: &ConvertRequest,
    probe: &ProbeResult,
    encoders: &DetectedEncoders,
) -> Result<ResolvedVideoTrackPlan, GoopError> {
    goop_core::validate_video_request(request)?;
    goop_core::validate_track_request(request)?;
    let requested = video_options(request)?;
    validate_fresh_source(requested, probe)?;
    let TrackConvertOptions::Video {
        source,
        audio,
        subtitles,
    } = requested
    else {
        unreachable!()
    };

    for track in &source.inventory.streams {
        if matches!(track.codec_type.as_str(), "audio" | "subtitle") {
            codec_value(track)?;
        }
    }

    if matches!(request.target, TargetFormat::Mp4 | TargetFormat::Mov) {
        let retained_audio = source
            .inventory
            .streams
            .iter()
            .filter(|track| track.codec_type == "audio" && policy_retains(audio, track.index));
        let (count, has_default) =
            retained_audio.fold((0_usize, false), |(count, has_default), track| {
                (
                    count + 1,
                    has_default || track.disposition.default == Some(true),
                )
            });
        if count > 0 && !has_default {
            return Err(invalid(
                "MP4 and MOV require one retained source-default audio stream; the muxer would otherwise promote a different track",
            ));
        }
    }

    let mut base = crate::video_options::resolve_without_auxiliary(request, probe, encoders)?;
    let copy_mode = matches!(request.video_options, Some(VideoConvertOptions::Copy));
    let mut retained = Vec::new();
    let mut omitted_audio = Vec::new();
    let mut omitted_subtitles = Vec::new();
    let mut audio_ordinal = 0_u32;
    let mut subtitle_ordinal = 0_u32;

    for track in &source.inventory.streams {
        let (policy, family, ordinal) = match track.codec_type.as_str() {
            "audio" => (audio, "a", &mut audio_ordinal),
            "subtitle" => (subtitles, "s", &mut subtitle_ordinal),
            "video" => continue,
            _ => return Err(invalid("Unsupported stream family in video track policy")),
        };
        if !policy_retains(policy, track.index) {
            if track.codec_type == "audio" {
                omitted_audio.push(track.clone());
            } else {
                omitted_subtitles.push(track.clone());
            }
            continue;
        }

        let codec = codec_value(track)?;
        let processing = if track.codec_type == "subtitle" {
            if !subtitle_copyable(request.target, codec) {
                return Err(invalid(format!(
                    "{} subtitle stream {} cannot be copied into {}",
                    codec,
                    track.index,
                    request.target.extension()
                )));
            }
            VideoTrackProcessing::Copied
        } else if audio_copyable(request.target, codec) {
            VideoTrackProcessing::Copied
        } else if copy_mode {
            return Err(invalid(format!(
                "Copy streams cannot copy {} audio stream {} into {}",
                codec,
                track.index,
                request.target.extension()
            )));
        } else {
            if !encoders.is_available("aac") {
                return Err(invalid(
                    "Required audio fallback encoder aac is unavailable",
                ));
            }
            VideoTrackProcessing::EncodedAac { bitrate_kbps: 192 }
        };

        base.plan
            .args
            .extend(["-map".into(), format!("0:{}", track.index)]);
        match processing {
            VideoTrackProcessing::Copied => base
                .plan
                .args
                .extend([format!("-c:{family}:{}", *ordinal), "copy".into()]),
            VideoTrackProcessing::EncodedAac { .. } => {
                base.plan.args.extend([
                    format!("-c:a:{}", *ordinal),
                    "aac".into(),
                    format!("-b:a:{}", *ordinal),
                    "192k".into(),
                ]);
                base.plan.reencoded = true;
            }
        }
        push_metadata_and_disposition(&mut base.plan.args, track, request.target, family, *ordinal);
        retained.push(VideoTrackStreamOutcome {
            source: track.clone(),
            output_stream_index: retained.len() as u32 + 1,
            output_type_index: *ordinal,
            processing: processing.clone(),
            source_codec_tag: TrackTextFact::Missing,
            output_codec_name: match processing {
                VideoTrackProcessing::Copied => track.codec_name.clone(),
                VideoTrackProcessing::EncodedAac { .. } => TrackTextFact::Value {
                    value: "aac".into(),
                },
            },
            output_codec_tag: TrackTextFact::Missing,
            output_language: track.language.clone(),
            output_title: track.title.clone(),
            output_default: track.disposition.default,
            output_forced: track.disposition.forced,
        });
        *ordinal += 1;
    }

    let mut notices = Vec::new();
    if !omitted_audio.is_empty() {
        notices.push(format!(
            "{} audio stream(s) omitted by request.",
            omitted_audio.len()
        ));
    }
    if !omitted_subtitles.is_empty() {
        notices.push(format!(
            "{} subtitle stream(s) omitted by request.",
            omitted_subtitles.len()
        ));
    }
    let encoded = retained
        .iter()
        .filter(|outcome| matches!(outcome.processing, VideoTrackProcessing::EncodedAac { .. }))
        .count();
    if encoded > 0 {
        notices.push(format!(
            "{encoded} incompatible audio stream(s) encoded as AAC at 192 kbps."
        ));
    }

    Ok(ResolvedVideoTrackPlan {
        plan: base.plan,
        video_summary: base.summary,
        track_summary: VideoTrackExecutionSummary {
            requested: requested.clone(),
            retained,
            omitted_audio,
            omitted_subtitles,
            notices,
        },
    })
}

fn availability(available: bool, reason: impl FnOnce() -> String) -> TrackModeAvailability {
    TrackModeAvailability {
        available,
        reason: (!available).then(reason),
    }
}

fn policy_modes(
    choices: &[VideoTrackChoiceCapability],
    mode: impl Fn(&VideoTrackChoiceCapability) -> &TrackModeAvailability,
    label: &str,
) -> VideoTrackPolicyModeCapabilities {
    let all = choices.iter().all(|choice| mode(choice).available);
    let any = choices.iter().any(|choice| mode(choice).available);
    VideoTrackPolicyModeCapabilities {
        keep_all: availability(all, || format!("Not every {label} stream is supported")),
        choose: availability(any, || format!("No {label} stream is supported")),
        none: availability(true, String::new),
    }
}

fn require_supported_default(
    modes: &mut VideoTrackPolicyModeCapabilities,
    choices: &[VideoTrackChoiceCapability],
    mode: impl Fn(&VideoTrackChoiceCapability) -> &TrackModeAvailability,
    target: TargetFormat,
) {
    if choices.is_empty()
        || choices
            .iter()
            .any(|choice| choice.track.disposition.default == Some(true) && mode(choice).available)
    {
        return;
    }
    let reason = format!(
        "{} requires every nonempty audio selection to retain a supported source-default stream",
        target.extension().to_uppercase()
    );
    modes.keep_all = TrackModeAvailability {
        available: false,
        reason: Some(reason.clone()),
    };
    modes.choose = TrackModeAvailability {
        available: false,
        reason: Some(reason),
    };
}

fn disable_policy_modes(modes: &mut VideoTrackPolicyModeCapabilities, reason: &str) {
    for mode in [&mut modes.keep_all, &mut modes.choose, &mut modes.none] {
        mode.available = false;
        mode.reason = Some(reason.to_owned());
    }
}

pub fn settings(
    probe: &ProbeResult,
    target: TargetFormat,
    encoders: &DetectedEncoders,
    source: &TrackSourceBinding,
) -> Result<VideoTrackSettingsCapabilities, GoopError> {
    let structural = TrackConvertOptions::Video {
        source: source.clone(),
        audio: TrackStreamPolicy::KeepAll,
        subtitles: TrackStreamPolicy::KeepAll,
    };
    validate_fresh_source(&structural, probe)?;
    let mut audio_tracks = Vec::new();
    let mut subtitle_tracks = Vec::new();
    let mut source_codecs_known = true;
    for track in &source.inventory.streams {
        match track.codec_type.as_str() {
            "audio" => {
                let Some(codec) = codec_value_from_fact(&track.codec_name) else {
                    source_codecs_known = false;
                    let reason = || "The source audio codec is unavailable".into();
                    audio_tracks.push(VideoTrackChoiceCapability {
                        track: track.clone(),
                        copy: availability(false, reason),
                        custom: availability(false, reason),
                    });
                    continue;
                };
                let copyable = audio_copyable(target, codec);
                let custom = copyable || encoders.is_available("aac");
                audio_tracks.push(VideoTrackChoiceCapability {
                    track: track.clone(),
                    copy: availability(copyable, || {
                        format!("{codec} audio cannot be copied into {}", target.extension())
                    }),
                    custom: availability(custom, || {
                        "The AAC fallback encoder is unavailable".into()
                    }),
                });
            }
            "subtitle" => {
                let Some(codec) = codec_value_from_fact(&track.codec_name) else {
                    source_codecs_known = false;
                    let reason = || "The source subtitle codec is unavailable".into();
                    subtitle_tracks.push(VideoTrackChoiceCapability {
                        track: track.clone(),
                        copy: availability(false, reason),
                        custom: availability(false, reason),
                    });
                    continue;
                };
                let copyable = subtitle_copyable(target, codec);
                let reason = || {
                    format!(
                        "{codec} subtitles cannot be copied into {}",
                        target.extension()
                    )
                };
                subtitle_tracks.push(VideoTrackChoiceCapability {
                    track: track.clone(),
                    copy: availability(copyable, reason),
                    custom: availability(copyable, reason),
                });
            }
            _ => {}
        }
    }
    let mut audio_policy = VideoTrackPolicyCapabilities {
        copy: policy_modes(&audio_tracks, |choice| &choice.copy, "audio"),
        custom: policy_modes(&audio_tracks, |choice| &choice.custom, "audio"),
    };
    let mut subtitle_policy = VideoTrackPolicyCapabilities {
        copy: policy_modes(&subtitle_tracks, |choice| &choice.copy, "subtitle"),
        custom: policy_modes(&subtitle_tracks, |choice| &choice.custom, "subtitle"),
    };
    if matches!(target, TargetFormat::Mp4 | TargetFormat::Mov) {
        require_supported_default(
            &mut audio_policy.copy,
            &audio_tracks,
            |choice| &choice.copy,
            target,
        );
        require_supported_default(
            &mut audio_policy.custom,
            &audio_tracks,
            |choice| &choice.custom,
            target,
        );
    }
    if !source_codecs_known {
        let reason = "Every source audio and subtitle stream needs a known codec";
        disable_policy_modes(&mut audio_policy.copy, reason);
        disable_policy_modes(&mut audio_policy.custom, reason);
        disable_policy_modes(&mut subtitle_policy.copy, reason);
        disable_policy_modes(&mut subtitle_policy.custom, reason);
    }
    Ok(VideoTrackSettingsCapabilities {
        source: source.clone(),
        audio_policy,
        subtitle_policy,
        audio_tracks,
        subtitle_tracks,
    })
}

fn video_only_probe(probe: &ProbeResult) -> ProbeResult {
    let mut result = probe.clone();
    if let Some(details) = &mut result.video_details {
        details
            .streams
            .retain(|stream| stream.codec_type == "video");
    }
    result.has_audio = false;
    result.has_subtitles = false;
    result.audio_codec = None;
    result.audio_codecs.clear();
    result.subtitle_codecs.clear();
    result.audio_details = None;
    result
}

fn rational_interval_ms(fact: Option<&VideoRationalFact>, frame_rate: bool) -> Option<u64> {
    let VideoRationalFact::Exact {
        numerator,
        denominator,
    } = fact?
    else {
        return None;
    };
    let (numerator, denominator) = (u64::from(*numerator), u64::from(*denominator));
    if frame_rate {
        1_000_u64
            .checked_mul(denominator)?
            .checked_add(numerator - 1)
            .map(|n| n / numerator)
    } else {
        1_000_u64
            .checked_mul(numerator)?
            .checked_add(denominator - 1)
            .map(|n| n / denominator)
    }
}

fn timing_tolerance(video: &VideoStreamInfo) -> Result<u64, GoopError> {
    let frame = rational_interval_ms(video.average_frame_rate.as_ref(), true)
        .ok_or_else(|| invalid("Source frame rate cannot provide a bounded timing tolerance"))?;
    let tick = rational_interval_ms(video.time_base.as_ref(), false)
        .ok_or_else(|| invalid("Source time base cannot provide a bounded timing tolerance"))?;
    Ok(frame.saturating_add(tick))
}

fn endpoint(stream: &VideoStreamInfo) -> Result<(i64, i128), GoopError> {
    let start = stream
        .start_time_ms
        .ok_or_else(|| invalid("Retained stream start time is unavailable"))?;
    let duration = stream
        .duration_ms
        .filter(|duration| *duration > 0)
        .ok_or_else(|| invalid("Retained stream endpoint is unavailable"))?;
    Ok((start, i128::from(start) + i128::from(duration)))
}

pub fn validate_output_against_source(
    video_expected: &VideoExecutionSummary,
    track_expected: &VideoTrackExecutionSummary,
    source: &ProbeResult,
    actual: &ProbeResult,
    target: TargetFormat,
) -> Result<VideoTrackExecutionSummary, GoopError> {
    let source_video_only = video_only_probe(source);
    let actual_video_only = video_only_probe(actual);
    crate::video_options::validate_output(video_expected, &actual_video_only)?;
    if matches!(video_expected.requested, VideoConvertOptions::Copy) {
        crate::video_options::validate_copy_facts(&source_video_only, &actual_video_only)?;
    }

    let actual_inventory = actual
        .track_inventory
        .as_ref()
        .ok_or_else(|| invalid("Completed video is missing its verified stream inventory"))?;
    if actual_inventory.streams.len() != track_expected.retained.len() + 1 {
        return Err(invalid(
            "Completed video stream count does not match the exact retained set",
        ));
    }
    let first = &actual_inventory.streams[0];
    if first.index != 0 || first.codec_type != "video" {
        return Err(invalid("Completed video stream 0 is not the primary video"));
    }

    let mut completed = track_expected.clone();
    for (outcome, actual_track) in completed
        .retained
        .iter_mut()
        .zip(actual_inventory.streams.iter().skip(1))
    {
        if actual_track.index != outcome.output_stream_index
            || actual_track.codec_type != outcome.source.codec_type
            || actual_track.codec_name != outcome.output_codec_name
            || actual_track.language != outcome.output_language
            || (!matches!(target, TargetFormat::Mp4 | TargetFormat::Mov)
                && actual_track.title != outcome.output_title)
            || actual_track.disposition.default != outcome.output_default
            || actual_track.disposition.forced != outcome.output_forced
            || actual_track.disposition.malformed
            || actual_track
                .disposition
                .other
                .values()
                .any(|active| *active)
        {
            return Err(invalid(format!(
                "Completed auxiliary stream {} does not match expected output {}: type {:?}/{:?}, codec {:?}/{:?}, language {:?}/{:?}, title {:?}/{:?}, default {:?}/{:?}, forced {:?}/{:?}",
                actual_track.index,
                outcome.output_stream_index,
                actual_track.codec_type,
                outcome.source.codec_type,
                actual_track.codec_name,
                outcome.output_codec_name,
                actual_track.language,
                outcome.output_language,
                actual_track.title,
                outcome.output_title,
                actual_track.disposition.default,
                outcome.output_default,
                actual_track.disposition.forced,
                outcome.output_forced,
            )));
        }
        outcome.output_codec_name = actual_track.codec_name.clone();
        outcome.output_language = actual_track.language.clone();
        if !matches!(target, TargetFormat::Mp4 | TargetFormat::Mov) {
            outcome.output_title = actual_track.title.clone();
        }
        outcome.output_default = actual_track.disposition.default;
        outcome.output_forced = actual_track.disposition.forced;
    }

    let source_details = source
        .video_details
        .as_ref()
        .ok_or_else(|| invalid("Source timing facts are unavailable"))?;
    let actual_details = actual
        .video_details
        .as_ref()
        .ok_or_else(|| invalid("Completed timing facts are unavailable"))?;
    let source_video = source_details
        .streams
        .iter()
        .find(|stream| stream.codec_type == "video")
        .ok_or_else(|| invalid("Source video timing facts are unavailable"))?;
    let actual_video = actual_details
        .streams
        .iter()
        .find(|stream| stream.index == 0 && stream.codec_type == "video")
        .ok_or_else(|| invalid("Completed video timing facts are unavailable"))?;
    let tolerance = timing_tolerance(source_video)?;
    let (source_video_start, source_video_end) = endpoint(source_video)?;
    let (actual_video_start, actual_video_end) = endpoint(actual_video)?;
    let source_video_duration = source_video_end - i128::from(source_video_start);
    let actual_video_duration = actual_video_end - i128::from(actual_video_start);
    if source_video_duration.abs_diff(actual_video_duration) > u128::from(tolerance) {
        return Err(invalid(
            "Completed video endpoint is outside the accepted timing tolerance",
        ));
    }

    for outcome in &completed.retained {
        if outcome.source.codec_type != "audio" {
            continue;
        }
        let source_audio = source_details
            .streams
            .iter()
            .find(|stream| stream.index == outcome.source.index)
            .ok_or_else(|| invalid("Source retained audio timing facts are unavailable"))?;
        let actual_audio = actual_details
            .streams
            .iter()
            .find(|stream| stream.index == outcome.output_stream_index)
            .ok_or_else(|| invalid("Completed retained audio timing facts are unavailable"))?;
        let (source_start, source_end) = endpoint(source_audio)?;
        let (actual_start, actual_end) = endpoint(actual_audio)?;
        let source_offset = i128::from(source_start) - i128::from(source_video_start);
        let actual_offset = i128::from(actual_start) - i128::from(actual_video_start);
        let source_relative_end = source_end - i128::from(source_video_start);
        let actual_relative_end = actual_end - i128::from(actual_video_start);
        if source_offset.abs_diff(actual_offset) > u128::from(tolerance)
            || source_relative_end.abs_diff(actual_relative_end) > u128::from(tolerance)
        {
            return Err(invalid(
                "Completed retained audio timing is outside the accepted tolerance",
            ));
        }
    }

    Ok(completed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrong_but_nonempty_output_container_tags_are_rejected() {
        assert!(validate_output_codec_tag(
            TargetFormat::Mp4,
            "aac",
            &TrackTextFact::Value {
                value: "wrong".into(),
            },
        )
        .is_err());
        assert!(validate_output_codec_tag(
            TargetFormat::Mkv,
            "ass",
            &TrackTextFact::Value {
                value: "[0][0][0][0]".into(),
            },
        )
        .is_ok());
    }
}
