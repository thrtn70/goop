use goop_core::{GoopError, ProbeResult};
use serde::Deserialize;

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

    let has_video = video.is_some();
    let has_audio = audio.is_some();
    let source_kind = if has_video {
        goop_core::SourceKind::Video
    } else if has_audio {
        goop_core::SourceKind::Audio
    } else {
        goop_core::SourceKind::Video // fallback; image sources use a different probe
    };

    Ok(ProbeResult {
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
    })
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
}
