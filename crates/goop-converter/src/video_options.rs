//! Admission and deterministic software plans for explicit video controls.
use crate::{compat::Plan, encoders::DetectedEncoders};
use goop_core::*;
use std::collections::HashSet;

pub const PREVIEW_REASON: &str =
    "Explicit video previews are not available yet. Use Automatic for a viewing sample.";
#[derive(Debug)]
/// Concrete FFmpeg arguments and the independently resolved stream outcomes.
pub struct ResolvedVideoPlan {
    pub plan: Plan,
    pub summary: VideoExecutionSummary,
}
fn invalid(message: impl Into<String>) -> GoopError {
    GoopError::InvalidRequest(message.into())
}

fn streams(probe: &ProbeResult) -> Result<(&VideoStreamInfo, Option<&VideoStreamInfo>), GoopError> {
    if probe.source_kind != SourceKind::Video {
        return Err(invalid("Explicit video settings require a video source"));
    }
    let details = probe.video_details.as_ref().ok_or_else(|| {
        invalid("Complete stream indices and disposition facts require a fresh video probe")
    })?;
    let mut indices = HashSet::new();
    let mut video = None;
    let mut audio = None;
    for stream in &details.streams {
        if !indices.insert(stream.index) {
            return Err(invalid("Duplicate source stream indices"));
        }
        if stream.attached_pic {
            return Err(invalid(
                "Attached artwork is not supported by explicit video settings",
            ));
        }
        if stream
            .codec_name
            .as_deref()
            .is_none_or(|c| c.is_empty() || c == "unknown")
        {
            return Err(invalid("Every source stream requires a known codec"));
        }
        match stream.codec_type.as_str() {
            "video" if video.is_none() => video = Some(stream),
            "audio" if audio.is_none() => audio = Some(stream),
            kind => {
                return Err(invalid(format!(
                    "Additional or unsupported {kind} stream; explicit video settings support one video and at most one audio stream"
                )));
            }
        }
    }
    let video = video.ok_or_else(|| invalid("Exactly one ordinary video stream is required"))?;
    if video.rotation_ambiguous || video.rotation_degrees.is_some_and(|r| r % 90 != 0) {
        return Err(invalid(
            "Video rotation is malformed or ambiguous; only multiples of 90 degrees are supported",
        ));
    }
    Ok((video, audio))
}
fn dimensions(probe: &ProbeResult, video: &VideoStreamInfo) -> Result<(u32, u32), GoopError> {
    let (mut w, mut h) = probe
        .width
        .zip(probe.height)
        .filter(|(w, h)| *w > 0 && *h > 0 && *w <= 32768 && *h <= 32768)
        .ok_or_else(|| invalid("Video dimensions are missing or unsupported"))?;
    if video.rotation_degrees.unwrap_or(0).rem_euclid(180) == 90 {
        std::mem::swap(&mut w, &mut h);
    }
    Ok((w, h))
}
fn encode_source(video: &VideoStreamInfo, w: u32, h: u32) -> Result<Vec<String>, GoopError> {
    if video.field_order.as_deref() != Some("progressive") {
        return Err(invalid("Custom encode requires explicitly progressive video; field order is interlaced or unknown"));
    }
    if video.pixel_format.as_deref() != Some("yuv420p") {
        return Err(invalid("Custom encode supports 8-bit yuv420p video only; high bit depth, alpha and other pixel layouts are unavailable"));
    }
    if video.sample_aspect_ratio.as_deref() != Some("1:1") {
        return Err(invalid(
            "Custom encode requires verified square pixels (sample aspect ratio 1:1)",
        ));
    }
    if !w.is_multiple_of(2) || !h.is_multiple_of(2) {
        return Err(invalid("Custom encode requires even upright dimensions"));
    }
    let mut unspecified = false;
    for (label, value, allowed) in [
        (
            "transfer",
            &video.color_transfer,
            &[
                "bt709",
                "smpte170m",
                "smpte240m",
                "gamma22",
                "gamma28",
                "bt470m",
                "bt470bg",
            ][..],
        ),
        (
            "primaries",
            &video.color_primaries,
            &["bt709", "bt470m", "bt470bg", "smpte170m", "smpte240m"][..],
        ),
        (
            "matrix",
            &video.color_space,
            &["bt709", "bt470bg", "smpte170m", "smpte240m", "fcc"][..],
        ),
        ("range", &video.color_range, &["tv", "pc"][..]),
    ] {
        match value.as_deref() {
            None | Some("unknown" | "unspecified") => unspecified = true,
            Some(value) if allowed.contains(&value) => {}
            Some(_) => {
                return Err(invalid(format!(
                    "Unsupported or malformed color {label}; HDR and wide-gamut custom encoding are unavailable"
                )));
            }
        }
    }
    Ok(if unspecified {
        vec!["Color tags are unspecified; no color correction is performed.".into()]
    } else {
        vec![]
    })
}
fn audio_copyable(target: TargetFormat, codec: &str) -> bool {
    if target == TargetFormat::Mkv {
        // Matroska's legacy path accepts arbitrary codecs. Explicit mode admits
        // the known audio families whose CodecIDs are supported by this muxer.
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

/// Validate complete fresh source facts and inventory before allocating output.
pub fn resolve(
    req: &ConvertRequest,
    probe: &ProbeResult,
    encoders: &DetectedEncoders,
) -> Result<ResolvedVideoPlan, GoopError> {
    validate_video_request(req)?;
    let options = req
        .video_options
        .as_ref()
        .ok_or_else(|| invalid("Explicit video settings are required"))?;
    let (video, audio) = streams(probe)?;
    let (mut width, mut height) = dimensions(probe, video)?;
    if probe.duration_ms == 0 || probe.file_size == 0 {
        return Err(invalid(
            "Video requires a usable duration and nonempty source data",
        ));
    }
    let mut args = vec!["-map".into(), format!("0:{}", video.index)];
    if let Some(audio) = audio {
        args.extend(["-map".into(), format!("0:{}", audio.index)]);
    }
    let mut filters = vec![];
    let (codec, encoder, mut notices) = match options {
        VideoConvertOptions::Copy => {
            let codec = match video.codec_name.as_deref() {
                Some("h264") => VideoCodec::H264,
                Some("hevc") => VideoCodec::Hevc,
                _ => {
                    return Err(invalid(
                        "Copy streams currently requires H.264 or HEVC video",
                    ))
                }
            };
            args.extend(["-c:v".into(), "copy".into()]);
            let notice = "Video streams are copied without encoding. Container metadata and dynamic HDR side data are not guaranteed to be preserved.";
            (codec, None, vec![notice.into()])
        }
        VideoConvertOptions::Encode {
            codec,
            rate_control,
            speed,
            ..
        } => {
            let notices = encode_source(video, width, height)?;
            let name = match codec {
                VideoCodec::H264 => "libx264",
                VideoCodec::Hevc => "libx265",
            };
            if !encoders.is_available(name) {
                return Err(invalid(format!("Required software encoder {name} is unavailable; bundled encoder discovery may have failed")));
            }
            args.extend([
                "-c:v".into(),
                name.into(),
                "-preset".into(),
                match speed {
                    VideoSpeed::Fast => "fast",
                    VideoSpeed::Medium => "medium",
                    VideoSpeed::Slow => "slow",
                }
                .into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
            ]);
            match rate_control {
                VideoRateControl::ConstantQuality { crf } => {
                    args.extend(["-crf".into(), crf.to_string()])
                }
                VideoRateControl::AverageBitrate { kbps } => {
                    args.extend(["-b:v".into(), format!("{kbps}k")])
                }
            };
            let cap = match req.resolution_cap {
                Some(ResolutionCap::R1080p) => Some(1920),
                Some(ResolutionCap::R720p) => Some(1280),
                Some(ResolutionCap::R480p) => Some(854),
                _ => None,
            };
            if let Some(cap) = cap {
                let out_w = width.min(cap);
                // Match FFmpeg scale's nearest even height for a square-pixel source.
                let out_h = ((u64::from(height) * u64::from(out_w) + u64::from(width))
                    / (2 * u64::from(width)))
                    * 2;
                if out_h == 0 || out_h > u64::from(height) {
                    return Err(invalid(
                        "Resolution cap cannot produce valid video geometry without enlargement",
                    ));
                }
                width = out_w;
                height = out_h as u32;
                filters.push(format!("scale='trunc(min({cap},iw)/2)*2':-2"));
                // Even-height rounding must not change the admitted square pixels.
                filters.push("setsar=1".into());
            }
            (*codec, Some(name.into()), notices)
        }
    };
    if codec == VideoCodec::Hevc && matches!(req.target, TargetFormat::Mp4 | TargetFormat::Mov) {
        args.extend(["-tag:v".into(), "hvc1".into()]);
    }
    let copied =
        audio.is_some_and(|a| audio_copyable(req.target, a.codec_name.as_deref().unwrap_or("")));
    let audio_codec = if let Some(audio) = audio {
        if copied {
            args.extend(["-c:a".into(), "copy".into()]);
            audio.codec_name.clone()
        } else if matches!(options, VideoConvertOptions::Copy) {
            return Err(invalid(format!(
                "Copy streams cannot copy {} audio into {}; choose Custom encode for AAC audio",
                audio.codec_name.as_deref().unwrap_or("unknown"),
                req.target.extension()
            )));
        } else {
            if !encoders.is_available("aac") {
                return Err(invalid(
                    "Required audio fallback encoder aac is unavailable",
                ));
            }
            args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
            notices.push(
                "Incompatible audio is encoded as AAC at 192 kbps independently of video settings."
                    .into(),
            );
            Some("aac".into())
        }
    } else {
        None
    };
    Ok(ResolvedVideoPlan {
        plan: Plan {
            args,
            video_filters: filters,
            reencoded: encoder.is_some(),
            ext: req.target.extension(),
        },
        summary: VideoExecutionSummary {
            requested: options.clone(),
            encoder,
            video_codec: codec,
            video_stream_index: video.index,
            audio_stream_index: audio.map(|a| a.index),
            audio_codec,
            audio_copied: copied,
            width,
            height,
            notices,
        },
    })
}

/// Verify staged output before publication; rate and speed are proven by the plan.
pub fn validate_output(
    expected: &VideoExecutionSummary,
    actual: &ProbeResult,
) -> Result<(), GoopError> {
    let (video, audio) = streams(actual)?;
    let codec = match expected.video_codec {
        VideoCodec::H264 => "h264",
        VideoCodec::Hevc => "hevc",
    };
    if video.codec_name.as_deref() != Some(codec)
        || audio.and_then(|a| a.codec_name.as_deref()) != expected.audio_codec.as_deref()
    {
        return Err(invalid(
            "Completed video/audio codecs or stream counts do not match the requested output",
        ));
    }
    if dimensions(actual, video)? != (expected.width, expected.height) {
        return Err(invalid(
            "Completed video geometry does not match the requested output",
        ));
    }
    if matches!(expected.requested, VideoConvertOptions::Encode { .. }) {
        if video.rotation_degrees.unwrap_or(0).rem_euclid(360) != 0 {
            return Err(invalid(
                "Encoded video retained unexpected display rotation",
            ));
        }
        encode_source(video, expected.width, expected.height)?;
    }
    if actual.duration_ms == 0 || actual.file_size == 0 {
        return Err(invalid(
            "Completed video has no usable duration or media data",
        ));
    }
    Ok(())
}

/// Advertise source-specific modes using the same resolver as execution.
pub fn capabilities(
    probe: &ProbeResult,
    target: TargetFormat,
    encoders: &DetectedEncoders,
) -> VideoSettingsCapabilities {
    let request = |options| ConvertRequest {
        batch_id: None,
        input_path: String::new(),
        output_path: String::new(),
        target,
        video_options: Some(options),
        quality_preset: None,
        resolution_cap: None,
        gif_options: None,
        compress_mode: None,
        metadata_policy: None,
        subtitle: None,
        image_options: None,
    };
    let mode = |result: Result<ResolvedVideoPlan, GoopError>| {
        let reason = result.err().map(|e| e.user_message());
        VideoModeAvailability {
            available: reason.is_none(),
            reason,
        }
    };
    let copy = mode(resolve(
        &request(VideoConvertOptions::Copy),
        probe,
        encoders,
    ));
    let codecs: Vec<_> = [
        (VideoCodec::H264, "libx264", 23),
        (VideoCodec::Hevc, "libx265", 28),
    ]
    .into_iter()
    .map(|(codec, encoder, recommended_crf)| {
        let state = mode(resolve(
            &request(VideoConvertOptions::Encode {
                codec,
                rate_control: VideoRateControl::ConstantQuality { crf: 23 },
                speed: VideoSpeed::Medium,
                processor: VideoProcessor::Software,
            }),
            probe,
            encoders,
        ));
        VideoCodecCapability {
            codec,
            encoder: encoder.into(),
            available: state.available,
            reason: state.reason,
            recommended_crf,
        }
    })
    .collect();
    let available = codecs.iter().any(|c| c.available);
    VideoSettingsCapabilities {
        copy,
        encode: VideoModeAvailability {
            available,
            reason: if available {
                None
            } else {
                codecs.first().and_then(|c| c.reason.clone())
            },
        },
        codecs,
        crf_min: 1,
        crf_max: 51,
        default_crf: 23,
        bitrate_min_kbps: 100,
        bitrate_max_kbps: 200000,
        default_bitrate_kbps: 5000,
        speeds: vec![VideoSpeed::Fast, VideoSpeed::Medium, VideoSpeed::Slow],
        default_speed: VideoSpeed::Medium,
        processor: VideoProcessor::Software,
        preview_available: false,
        preview_unavailable_reason: Some(PREVIEW_REASON.into()),
    }
}

/// Copy keeps coded geometry and stream display facts, including non-square pixels.
pub(crate) fn validate_copy_facts(
    source: &ProbeResult,
    actual: &ProbeResult,
) -> Result<(), GoopError> {
    let (before, _) = streams(source)?;
    let (after, _) = streams(actual)?;
    let normalized_rotation = |s: &VideoStreamInfo| s.rotation_degrees.unwrap_or(0).rem_euclid(360);
    if source.width != actual.width
        || source.height != actual.height
        || normalized_rotation(before) != normalized_rotation(after)
        || before.pixel_format != after.pixel_format
        || before.sample_aspect_ratio != after.sample_aspect_ratio
    {
        return Err(invalid(
            "Copied video changed its coded geometry, pixel format or display metadata",
        ));
    }
    Ok(())
}
