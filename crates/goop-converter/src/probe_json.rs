use goop_core::{GoopError, ProbeResult, VideoProbeDetails, VideoRationalFact, VideoStreamInfo};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
struct FfprobeRoot {
    format: Option<FfprobeFormat>,
    streams: Option<Vec<FfprobeStream>>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
    size: Option<String>,
    format_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    #[serde(flatten)]
    facts: std::collections::HashMap<String, Value>,
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

pub fn parse_probe_json(raw: &[u8]) -> Result<ProbeResult, GoopError> {
    let root: FfprobeRoot = serde_json::from_slice(raw)?;

    let duration_ms = root
        .format
        .as_ref()
        .and_then(|f| f.duration.as_deref())
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|secs| secs.is_finite() && *secs > 0.0)
        .map(|secs| (secs * 1000.0).round() as u64)
        .unwrap_or(0);

    let file_size = root
        .format
        .as_ref()
        .and_then(|f| f.size.as_deref())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let container = root.format.as_ref().and_then(|f| f.format_name.clone());

    let streams = root.streams.unwrap_or_default();

    let video = streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"));
    let audio = streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"));

    let subtitle_codecs: Vec<String> = streams
        .iter()
        .filter(|s| s.codec_type.as_deref() == Some("subtitle"))
        .map(|s| s.codec_name.clone().unwrap_or_default())
        .collect();

    let audio_codecs: Vec<String> = streams
        .iter()
        .filter(|s| s.codec_type.as_deref() == Some("audio"))
        .map(|s| s.codec_name.clone().unwrap_or_default())
        .collect();

    let has_video = video.is_some();
    let has_audio = audio.is_some();
    let has_subtitles = !subtitle_codecs.is_empty();
    // A container's kind is decided by its richest stream: a video with
    // embedded subs is still a video. Only a file whose *only* content is
    // a subtitle stream (a bare .srt / .vtt) is a Subtitle source.
    let source_kind = if has_video {
        goop_core::SourceKind::Video
    } else if has_audio {
        goop_core::SourceKind::Audio
    } else if has_subtitles {
        goop_core::SourceKind::Subtitle
    } else {
        goop_core::SourceKind::Video // fallback; image sources use a different probe
    };

    Ok(ProbeResult {
        video_details: if has_video {
            stream_details(&streams)
        } else {
            None
        },
        duration_ms,
        width: video.and_then(|s| s.width),
        height: video.and_then(|s| s.height),
        video_codec: video.and_then(|s| s.codec_name.clone()),
        audio_codec: audio.and_then(|s| s.codec_name.clone()),
        file_size,
        container,
        has_video,
        has_audio,
        source_kind,
        color_space: None,
        image_format: None,
        has_subtitles,
        subtitle_codecs,
        audio_codecs,
        image_has_alpha: None,
    })
}

fn valid_display_matrix(matrix: &Value, rotation: &Value) -> bool {
    let Some(text) = matrix.as_str() else {
        return false;
    };
    let rows: Option<Vec<Vec<i64>>> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let (_, values) = line.split_once(':')?;
            values.split_whitespace().map(|n| n.parse().ok()).collect()
        })
        .collect();
    let Some(rows) = rows else {
        return false;
    };
    if rows.len() != 3 || rows.iter().any(|r| r.len() != 3) {
        return false;
    }
    let angle = rotation
        .as_i64()
        .or_else(|| rotation.as_str().and_then(|s| s.parse().ok()));
    let (a, b, c, d) = match angle.map(|a| a.rem_euclid(360)) {
        Some(0) => (65536, 0, 0, 65536),
        Some(90) => (0, -65536, 65536, 0),
        Some(180) => (-65536, 0, 0, -65536),
        Some(270) => (0, 65536, -65536, 0),
        _ => return false,
    };
    rows == vec![vec![a, b, 0], vec![c, d, 0], vec![0, 0, 1073741824]]
}

fn rational_fact(value: Option<&Value>) -> Option<VideoRationalFact> {
    let value = value?;
    let exact = || {
        let text = value.as_str()?;
        let (numerator, denominator) = text.split_once('/')?;
        let numerator = numerator.parse::<u32>().ok()?;
        let denominator = denominator.parse::<u32>().ok()?;
        if numerator == 0 || denominator == 0 {
            return None;
        }
        let divisor = gcd(numerator, denominator);
        Some(VideoRationalFact::Exact {
            numerator: numerator / divisor,
            denominator: denominator / divisor,
        })
    };
    Some(exact().unwrap_or(VideoRationalFact::Malformed))
}

fn gcd(mut left: u32, mut right: u32) -> u32 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

const MAX_SAFE_INTEGER_MS: i64 = 9_007_199_254_740_991;
const FIRST_UNSAFE_INTEGER_MS: f64 = 9_007_199_254_740_992.0;

fn seconds_to_milliseconds(seconds: f64) -> Option<i64> {
    let milliseconds = seconds * 1_000.0;
    if !milliseconds.is_finite()
        || milliseconds <= -FIRST_UNSAFE_INTEGER_MS
        || milliseconds >= FIRST_UNSAFE_INTEGER_MS
    {
        return None;
    }
    Some(milliseconds.round() as i64)
}

fn decimal_milliseconds(value: Option<&Value>) -> Option<i64> {
    seconds_to_milliseconds(value?.as_str()?.parse::<f64>().ok()?)
}

fn duration_milliseconds(facts: &std::collections::HashMap<String, Value>) -> Option<u64> {
    let direct = decimal_milliseconds(facts.get("duration"))
        .and_then(|milliseconds| u64::try_from(milliseconds).ok())
        .filter(|milliseconds| *milliseconds > 0);
    direct
        .or_else(|| {
            let ticks = facts
                .get("duration_ts")?
                .as_i64()
                .or_else(|| facts.get("duration_ts")?.as_str()?.parse().ok())?;
            let VideoRationalFact::Exact {
                numerator,
                denominator,
            } = rational_fact(facts.get("time_base"))?
            else {
                return None;
            };
            let milliseconds = i128::from(ticks)
                .checked_mul(i128::from(numerator))?
                .checked_mul(1_000)?
                .checked_div(i128::from(denominator))?;
            u64::try_from(milliseconds)
                .ok()
                .filter(|value| *value > 0 && *value <= MAX_SAFE_INTEGER_MS as u64)
        })
        .or_else(|| {
            let text = facts.get("tags")?.get("DURATION")?.as_str()?;
            let mut parts = text.split(':');
            let hours = parts.next()?.parse::<f64>().ok()?;
            let minutes = parts.next()?.parse::<f64>().ok()?;
            let seconds = parts.next()?.parse::<f64>().ok()?;
            if parts.next().is_some()
                || !hours.is_finite()
                || !minutes.is_finite()
                || !seconds.is_finite()
                || hours < 0.0
                || !(0.0..60.0).contains(&minutes)
                || !(0.0..60.0).contains(&seconds)
            {
                return None;
            }
            seconds_to_milliseconds(hours * 3_600.0 + minutes * 60.0 + seconds)
                .and_then(|milliseconds| u64::try_from(milliseconds).ok())
                .filter(|milliseconds| *milliseconds > 0)
        })
}

// Missing indices/dispositions leave the richer inventory unavailable while
// preserving legacy first-video routing and basic probe behavior.
fn stream_details(streams: &[FfprobeStream]) -> Option<VideoProbeDetails> {
    let mut result = Vec::with_capacity(streams.len());
    for stream in streams {
        let facts = &stream.facts;
        let index = u32::try_from(facts.get("index")?.as_u64()?).ok()?;
        let attached = facts.get("disposition")?.get("attached_pic")?.as_u64()?;
        if attached > 1 {
            return None;
        }
        let text = |key: &str| {
            facts
                .get(key)
                .map(|v| v.as_str().unwrap_or("malformed").to_owned())
        };
        let mut rotations = Vec::new();
        let mut ambiguous = false;
        let mut record = |value: &Value| -> bool {
            let angle = value
                .as_i64()
                .or_else(|| value.as_str().and_then(|s| s.parse::<i64>().ok()));
            match angle.and_then(|n| i32::try_from(n).ok()) {
                Some(n) if n % 90 == 0 => {
                    rotations.push(n.rem_euclid(360));
                    false
                }
                _ => true,
            }
        };
        if let Some(tags) = facts.get("tags") {
            if let Some(rotate) = tags.get("rotate") {
                ambiguous |= record(rotate);
            } else if !tags.is_object() {
                ambiguous = true;
            }
        }
        if let Some(side) = facts.get("side_data_list") {
            if let Some(items) = side.as_array() {
                for item in items {
                    if let Some(rotation) = item.get("rotation") {
                        ambiguous |= record(rotation);
                        if let Some(matrix) = item.get("displaymatrix") {
                            ambiguous |= !valid_display_matrix(matrix, rotation);
                        } else if item.get("side_data_type").and_then(Value::as_str)
                            == Some("Display Matrix")
                        {
                            ambiguous = true;
                        }
                    } else if item.get("side_data_type").and_then(Value::as_str)
                        == Some("Display Matrix")
                    {
                        ambiguous = true;
                    }
                }
            } else {
                ambiguous = true;
            }
        }
        ambiguous |= rotations.windows(2).any(|pair| pair[0] != pair[1]);
        result.push(VideoStreamInfo {
            index,
            codec_type: stream
                .codec_type
                .clone()
                .unwrap_or_else(|| "unknown".into()),
            codec_name: stream.codec_name.clone(),
            pixel_format: text("pix_fmt"),
            color_transfer: text("color_transfer"),
            color_primaries: text("color_primaries"),
            color_space: text("color_space"),
            color_range: text("color_range"),
            field_order: text("field_order"),
            sample_aspect_ratio: text("sample_aspect_ratio"),
            average_frame_rate: rational_fact(facts.get("avg_frame_rate")),
            base_frame_rate: rational_fact(facts.get("r_frame_rate")),
            time_base: rational_fact(facts.get("time_base")),
            rotation_degrees: rotations.first().copied(),
            rotation_ambiguous: ambiguous,
            attached_pic: attached == 1,
            start_time_ms: decimal_milliseconds(facts.get("start_time")),
            duration_ms: duration_milliseconds(facts),
        });
    }
    Some(VideoProbeDetails { streams: result })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MP4_JSON: &[u8] = br#"{
      "format": {
        "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
        "duration": "10.500000",
        "size": "1048576"
      },
      "streams": [
        { "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080 },
        { "codec_type": "audio", "codec_name": "aac" }
      ]
    }"#;

    const AUDIO_ONLY: &[u8] = br#"{
      "format": { "duration": "180.0", "size": "2048000", "format_name": "ogg" },
      "streams": [
        { "codec_type": "audio", "codec_name": "opus" }
      ]
    }"#;

    /// Real `ffprobe` output for a bare `.srt` — note there is no
    /// `duration` key at all, and the only stream is a subtitle one.
    const SRT_JSON: &[u8] = br#"{
      "format": { "format_name": "srt", "size": "92" },
      "streams": [
        { "codec_type": "subtitle", "codec_name": "subrip" }
      ]
    }"#;

    const VTT_JSON: &[u8] = br#"{
      "format": { "format_name": "webvtt", "size": "64" },
      "streams": [
        { "codec_type": "subtitle", "codec_name": "webvtt" }
      ]
    }"#;

    const MKV_WITH_SUBS: &[u8] = br#"{
      "format": { "format_name": "matroska,webm", "duration": "60.0", "size": "8000000" },
      "streams": [
        { "codec_type": "video", "codec_name": "h264", "width": 1280, "height": 720 },
        { "codec_type": "audio", "codec_name": "aac" },
        { "codec_type": "subtitle", "codec_name": "subrip" }
      ]
    }"#;

    #[test]
    fn parses_bare_srt_as_subtitle_source() {
        let r = parse_probe_json(SRT_JSON).unwrap();
        // Regression: before subtitle support this fell through to the
        // Video fallback, leaving the target picker fully disabled.
        assert_eq!(r.source_kind, goop_core::SourceKind::Subtitle);
        assert!(r.has_subtitles);
        assert_eq!(r.subtitle_codecs, vec!["subrip"]);
        assert!(!r.has_video);
        assert!(!r.has_audio);
        assert_eq!(r.duration_ms, 0);
    }

    #[test]
    fn parses_bare_vtt_as_subtitle_source() {
        let r = parse_probe_json(VTT_JSON).unwrap();
        assert_eq!(r.source_kind, goop_core::SourceKind::Subtitle);
        assert_eq!(r.subtitle_codecs, vec!["webvtt"]);
    }

    #[test]
    fn video_with_embedded_subs_stays_a_video_source() {
        let r = parse_probe_json(MKV_WITH_SUBS).unwrap();
        assert_eq!(r.source_kind, goop_core::SourceKind::Video);
        assert!(r.has_video);
        assert!(r.has_audio);
        assert!(r.has_subtitles);
        assert_eq!(r.subtitle_codecs, vec!["subrip"]);
    }

    #[test]
    fn sources_without_subtitles_report_none() {
        let r = parse_probe_json(MP4_JSON).unwrap();
        assert!(!r.has_subtitles);
        assert!(r.subtitle_codecs.is_empty());
    }

    #[test]
    fn every_audio_stream_is_listed_in_order() {
        // `audio_codec` names only the first stream; carrying the rest
        // through a stream copy needs each one checked on its own account.
        let json = br#"{"streams":[
            {"codec_type":"video","codec_name":"h264"},
            {"codec_type":"audio","codec_name":"aac"},
            {"codec_type":"audio","codec_name":"ac3"},
            {"codec_type":"audio","codec_name":"vorbis"}
        ]}"#;
        let r = parse_probe_json(json).unwrap();
        assert_eq!(r.audio_codecs, vec!["aac", "ac3", "vorbis"]);
        assert_eq!(
            r.audio_codec.as_deref(),
            Some("aac"),
            "the single-stream field still names the first"
        );
    }

    #[test]
    fn a_source_without_audio_lists_no_audio_codecs() {
        let r = parse_probe_json(br#"{"streams":[{"codec_type":"video","codec_name":"h264"}]}"#)
            .unwrap();
        assert!(r.audio_codecs.is_empty());
        assert!(!r.has_audio);
    }

    #[test]
    fn parses_mp4() {
        let r = parse_probe_json(MP4_JSON).unwrap();
        assert_eq!(r.duration_ms, 10_500);
        assert_eq!(r.file_size, 1_048_576);
        assert_eq!(r.width, Some(1920));
        assert_eq!(r.height, Some(1080));
        assert_eq!(r.video_codec.as_deref(), Some("h264"));
        assert_eq!(r.audio_codec.as_deref(), Some("aac"));
        assert!(r.has_video);
        assert!(r.has_audio);
    }

    #[test]
    fn parses_audio_only() {
        let r = parse_probe_json(AUDIO_ONLY).unwrap();
        assert_eq!(r.duration_ms, 180_000);
        assert!(!r.has_video);
        assert!(r.has_audio);
        assert!(r.width.is_none());
    }

    #[test]
    fn handles_missing_fields() {
        let r = parse_probe_json(br#"{"streams":[]}"#).unwrap();
        assert_eq!(r.duration_ms, 0);
        assert_eq!(r.file_size, 0);
        assert!(!r.has_video);
        assert!(!r.has_audio);
    }

    #[test]
    fn rejects_invalid_json() {
        assert!(parse_probe_json(b"not json").is_err());
    }

    #[test]
    fn timestamp_milliseconds_reject_the_first_js_unsafe_integers() {
        assert_eq!(
            seconds_to_milliseconds(9_007_199_254_740.99),
            Some(9_007_199_254_740_990)
        );
        assert_eq!(seconds_to_milliseconds(9_007_199_254_740.992), None);
        assert_eq!(seconds_to_milliseconds(-9_007_199_254_740.992), None);
    }
}
