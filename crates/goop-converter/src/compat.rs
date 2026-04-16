use goop_core::TargetFormat;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub args: Vec<String>,
    pub reencoded: bool,
    pub ext: &'static str,
}

pub fn decide(target: TargetFormat, vcodec: Option<&str>, acodec: Option<&str>) -> Plan {
    match target {
        TargetFormat::Mp4 => plan_mp4(vcodec, acodec),
        TargetFormat::Mkv => remux("mkv"),
        TargetFormat::Webm => plan_webm(vcodec, acodec),
        TargetFormat::Mp3 => plan_audio_only(acodec, "mp3", audio_mp3),
        TargetFormat::M4a => plan_audio_only(acodec, "m4a", audio_m4a),
        TargetFormat::Opus => plan_audio_only(acodec, "opus", audio_opus),
        TargetFormat::Wav => plan_audio_only(acodec, "wav", audio_wav),
        TargetFormat::ExtractAudioKeepCodec => plan_extract_audio(acodec),
    }
}

fn args(strs: &[&str]) -> Vec<String> {
    strs.iter().map(|s| (*s).to_string()).collect()
}

fn remux(ext: &'static str) -> Plan {
    Plan {
        args: args(&["-c", "copy"]),
        reencoded: false,
        ext,
    }
}

fn plan_mp4(vcodec: Option<&str>, acodec: Option<&str>) -> Plan {
    match (vcodec, acodec) {
        (Some("h264"), Some("aac")) => Plan {
            args: args(&["-c", "copy"]),
            reencoded: false,
            ext: "mp4",
        },
        (Some("h264"), Some("mp3")) => Plan {
            args: args(&["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"]),
            reencoded: true,
            ext: "mp4",
        },
        _ => Plan {
            args: args(&[
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a",
                "192k",
            ]),
            reencoded: true,
            ext: "mp4",
        },
    }
}

fn plan_webm(vcodec: Option<&str>, acodec: Option<&str>) -> Plan {
    let v_copy = matches!(vcodec, Some("vp8") | Some("vp9") | Some("av1"));
    let a_copy = matches!(acodec, Some("opus") | Some("vorbis"));
    if v_copy && a_copy {
        Plan {
            args: args(&["-c", "copy"]),
            reencoded: false,
            ext: "webm",
        }
    } else {
        Plan {
            args: args(&[
                "-c:v",
                "libvpx-vp9",
                "-b:v",
                "0",
                "-crf",
                "32",
                "-c:a",
                "libopus",
            ]),
            reencoded: true,
            ext: "webm",
        }
    }
}

fn audio_mp3(acodec: Option<&str>) -> Plan {
    match acodec {
        Some("mp3") => Plan {
            args: args(&["-vn", "-c:a", "copy"]),
            reencoded: false,
            ext: "mp3",
        },
        _ => Plan {
            args: args(&["-vn", "-c:a", "libmp3lame", "-q:a", "2"]),
            reencoded: true,
            ext: "mp3",
        },
    }
}

fn audio_m4a(acodec: Option<&str>) -> Plan {
    match acodec {
        Some("aac") => Plan {
            args: args(&["-vn", "-c:a", "copy"]),
            reencoded: false,
            ext: "m4a",
        },
        _ => Plan {
            args: args(&["-vn", "-c:a", "aac", "-b:a", "192k"]),
            reencoded: true,
            ext: "m4a",
        },
    }
}

fn audio_opus(acodec: Option<&str>) -> Plan {
    match acodec {
        Some("opus") => Plan {
            args: args(&["-vn", "-c:a", "copy"]),
            reencoded: false,
            ext: "opus",
        },
        _ => Plan {
            args: args(&["-vn", "-c:a", "libopus", "-b:a", "128k"]),
            reencoded: true,
            ext: "opus",
        },
    }
}

fn audio_wav(acodec: Option<&str>) -> Plan {
    match acodec {
        Some("pcm_s16le") => Plan {
            args: args(&["-vn", "-c:a", "copy"]),
            reencoded: false,
            ext: "wav",
        },
        _ => Plan {
            args: args(&["-vn", "-c:a", "pcm_s16le"]),
            reencoded: true,
            ext: "wav",
        },
    }
}

fn plan_audio_only(acodec: Option<&str>, _ext: &'static str, f: fn(Option<&str>) -> Plan) -> Plan {
    f(acodec)
}

fn plan_extract_audio(acodec: Option<&str>) -> Plan {
    let ext = match acodec {
        Some("aac") => "m4a",
        Some("mp3") => "mp3",
        Some("opus") => "opus",
        Some("vorbis") => "ogg",
        _ => "mka",
    };
    Plan {
        args: args(&["-vn", "-c:a", "copy"]),
        reencoded: false,
        ext,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mp4_h264_aac_remuxes() {
        let p = decide(TargetFormat::Mp4, Some("h264"), Some("aac"));
        assert!(!p.reencoded);
        assert_eq!(p.ext, "mp4");
        assert_eq!(p.args, vec!["-c", "copy"]);
    }

    #[test]
    fn mp4_h264_mp3_only_reencodes_audio() {
        let p = decide(TargetFormat::Mp4, Some("h264"), Some("mp3"));
        assert!(p.reencoded);
        assert!(p.args.windows(2).any(|w| w == ["-c:v", "copy"]));
        assert!(p.args.windows(2).any(|w| w == ["-c:a", "aac"]));
    }

    #[test]
    fn mp4_other_vcodec_fully_reencodes() {
        let p = decide(TargetFormat::Mp4, Some("vp9"), Some("opus"));
        assert!(p.reencoded);
        assert!(p.args.iter().any(|s| s == "libx264"));
    }

    #[test]
    fn mkv_always_remuxes() {
        let p = decide(TargetFormat::Mkv, Some("hevc"), Some("flac"));
        assert!(!p.reencoded);
        assert_eq!(p.ext, "mkv");
    }

    #[test]
    fn webm_vp9_opus_remuxes() {
        let p = decide(TargetFormat::Webm, Some("vp9"), Some("opus"));
        assert!(!p.reencoded);
    }

    #[test]
    fn webm_h264_forces_reencode() {
        let p = decide(TargetFormat::Webm, Some("h264"), Some("aac"));
        assert!(p.reencoded);
        assert!(p.args.iter().any(|s| s == "libvpx-vp9"));
    }

    #[test]
    fn mp3_from_mp3_copies() {
        let p = decide(TargetFormat::Mp3, None, Some("mp3"));
        assert!(!p.reencoded);
        assert!(p.args.iter().any(|s| s == "-vn"));
    }

    #[test]
    fn mp3_from_other_uses_lame() {
        let p = decide(TargetFormat::Mp3, None, Some("aac"));
        assert!(p.reencoded);
        assert!(p.args.iter().any(|s| s == "libmp3lame"));
    }

    #[test]
    fn m4a_from_aac_copies() {
        let p = decide(TargetFormat::M4a, None, Some("aac"));
        assert!(!p.reencoded);
    }

    #[test]
    fn opus_from_opus_copies() {
        let p = decide(TargetFormat::Opus, None, Some("opus"));
        assert!(!p.reencoded);
    }

    #[test]
    fn wav_from_pcm_copies() {
        let p = decide(TargetFormat::Wav, None, Some("pcm_s16le"));
        assert!(!p.reencoded);
    }

    #[test]
    fn wav_from_other_uses_pcm() {
        let p = decide(TargetFormat::Wav, None, Some("aac"));
        assert!(p.reencoded);
        assert!(p.args.iter().any(|s| s == "pcm_s16le"));
    }

    #[test]
    fn extract_audio_keeps_codec_picks_ext() {
        assert_eq!(
            decide(TargetFormat::ExtractAudioKeepCodec, None, Some("aac")).ext,
            "m4a"
        );
        assert_eq!(
            decide(TargetFormat::ExtractAudioKeepCodec, None, Some("mp3")).ext,
            "mp3"
        );
        assert_eq!(
            decide(TargetFormat::ExtractAudioKeepCodec, None, Some("opus")).ext,
            "opus"
        );
        assert_eq!(
            decide(TargetFormat::ExtractAudioKeepCodec, None, Some("vorbis")).ext,
            "ogg"
        );
        assert_eq!(
            decide(TargetFormat::ExtractAudioKeepCodec, None, Some("flac")).ext,
            "mka"
        );
        assert_eq!(
            decide(TargetFormat::ExtractAudioKeepCodec, None, None).ext,
            "mka"
        );
    }

    #[test]
    fn extract_audio_always_copies() {
        let p = decide(
            TargetFormat::ExtractAudioKeepCodec,
            Some("h264"),
            Some("aac"),
        );
        assert!(!p.reencoded);
        assert_eq!(p.args, vec!["-vn", "-c:a", "copy"]);
    }
}
