use goop_core::{GifOptions, GifSizePreset, QualityPreset, ResolutionCap, TargetFormat};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub args: Vec<String>,
    pub video_filters: Vec<String>,
    pub reencoded: bool,
    pub ext: &'static str,
}

/// Build a conversion plan based on the target format, source codecs, and
/// optional quality / resolution / GIF parameters.
///
/// Quality preset `Some(Original)` or `None` preserves v0.1.3 behavior
/// (remux when codecs are compatible). Any other preset forces re-encode.
pub fn decide(
    target: TargetFormat,
    vcodec: Option<&str>,
    acodec: Option<&str>,
    quality: Option<QualityPreset>,
    res_cap: Option<ResolutionCap>,
    gif_opts: Option<&GifOptions>,
) -> Plan {
    let force_reencode = matches!(
        quality,
        Some(QualityPreset::Fast) | Some(QualityPreset::Balanced) | Some(QualityPreset::Small)
    );

    let mut plan = match target {
        TargetFormat::Mp4 => {
            if force_reencode {
                plan_mp4_encode(quality.unwrap())
            } else {
                plan_mp4(vcodec, acodec)
            }
        }
        TargetFormat::Mkv => {
            if force_reencode {
                plan_mkv_encode(quality.unwrap())
            } else {
                remux("mkv")
            }
        }
        TargetFormat::Webm => {
            if force_reencode {
                plan_webm_encode(quality.unwrap())
            } else {
                plan_webm(vcodec, acodec)
            }
        }
        TargetFormat::Gif => plan_gif(gif_opts),
        TargetFormat::Avi => plan_avi(vcodec, acodec),
        TargetFormat::Mov => {
            let mut p = if force_reencode {
                plan_mp4_encode(quality.unwrap())
            } else {
                plan_mp4(vcodec, acodec)
            };
            p.ext = "mov";
            p
        }
        TargetFormat::Mp3 => plan_audio_only(acodec, audio_mp3),
        TargetFormat::M4a => plan_audio_only(acodec, audio_m4a),
        TargetFormat::Opus => plan_audio_only(acodec, audio_opus),
        TargetFormat::Wav => plan_audio_only(acodec, audio_wav),
        TargetFormat::Flac => plan_audio_only(acodec, audio_flac),
        TargetFormat::Ogg => plan_audio_only(acodec, audio_ogg),
        TargetFormat::Aac => plan_audio_only(acodec, audio_aac_raw),
        TargetFormat::ExtractAudioKeepCodec => plan_extract_audio(acodec),
        // Image targets are handled by ImageMagick, not ffmpeg.
        TargetFormat::Png | TargetFormat::Jpeg | TargetFormat::Webp | TargetFormat::Bmp => Plan {
            args: vec![],
            video_filters: vec![],
            reencoded: false,
            ext: target.extension(),
        },
    };

    // Apply resolution cap as a video filter (skip for audio-only or image targets).
    if let Some(cap) = res_cap {
        if cap != ResolutionCap::Original
            && !target.is_image()
            && plan.args.iter().all(|a| a != "-vn")
        {
            let w = match cap {
                ResolutionCap::R1080p => 1920,
                ResolutionCap::R720p => 1280,
                ResolutionCap::R480p => 854,
                ResolutionCap::Original => unreachable!(),
            };
            plan.video_filters.insert(0, format!("scale={w}:-2"));
            plan.reencoded = true;
        }
    }

    plan
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn args(strs: &[&str]) -> Vec<String> {
    strs.iter().map(|s| (*s).to_string()).collect()
}

fn remux(ext: &'static str) -> Plan {
    Plan {
        args: args(&["-c", "copy"]),
        video_filters: vec![],
        reencoded: false,
        ext,
    }
}

// ---------------------------------------------------------------------------
// MP4
// ---------------------------------------------------------------------------

fn plan_mp4(vcodec: Option<&str>, acodec: Option<&str>) -> Plan {
    match (vcodec, acodec) {
        (Some("h264"), Some("aac")) => Plan {
            args: args(&["-c", "copy"]),
            video_filters: vec![],
            reencoded: false,
            ext: "mp4",
        },
        (Some("h264"), Some("mp3")) => Plan {
            args: args(&["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"]),
            video_filters: vec![],
            reencoded: true,
            ext: "mp4",
        },
        _ => plan_mp4_encode(QualityPreset::Balanced),
    }
}

fn plan_mp4_encode(q: QualityPreset) -> Plan {
    let (preset, crf) = h264_preset(q);
    let ab = audio_bitrate(q);
    Plan {
        args: args(&[
            "-c:v", "libx264", "-preset", preset, "-crf", crf, "-c:a", "aac", "-b:a", ab,
        ]),
        video_filters: vec![],
        reencoded: true,
        ext: "mp4",
    }
}

// ---------------------------------------------------------------------------
// MKV (encode path)
// ---------------------------------------------------------------------------

fn plan_mkv_encode(q: QualityPreset) -> Plan {
    let (preset, crf) = h264_preset(q);
    let ab = audio_bitrate(q);
    Plan {
        args: args(&[
            "-c:v", "libx264", "-preset", preset, "-crf", crf, "-c:a", "aac", "-b:a", ab,
        ]),
        video_filters: vec![],
        reencoded: true,
        ext: "mkv",
    }
}

// ---------------------------------------------------------------------------
// WebM
// ---------------------------------------------------------------------------

fn plan_webm(vcodec: Option<&str>, acodec: Option<&str>) -> Plan {
    let v_copy = matches!(vcodec, Some("vp8") | Some("vp9") | Some("av1"));
    let a_copy = matches!(acodec, Some("opus") | Some("vorbis"));
    if v_copy && a_copy {
        Plan {
            args: args(&["-c", "copy"]),
            video_filters: vec![],
            reencoded: false,
            ext: "webm",
        }
    } else {
        plan_webm_encode(QualityPreset::Balanced)
    }
}

fn plan_webm_encode(q: QualityPreset) -> Plan {
    let (deadline, crf) = vp9_preset(q);
    Plan {
        args: args(&[
            "-c:v",
            "libvpx-vp9",
            "-deadline",
            deadline,
            "-b:v",
            "0",
            "-crf",
            crf,
            "-c:a",
            "libopus",
        ]),
        video_filters: vec![],
        reencoded: true,
        ext: "webm",
    }
}

// ---------------------------------------------------------------------------
// GIF (always re-encodes, palettegen two-pass via filtergraph)
// ---------------------------------------------------------------------------

fn plan_gif(opts: Option<&GifOptions>) -> Plan {
    let width = opts
        .map(|o| o.size_preset.width())
        .unwrap_or(GifSizePreset::Medium.width());

    let filter = format!(
        "fps=15,scale={width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"
    );

    let mut pre_input: Vec<String> = vec![];
    if let Some(o) = opts {
        if let Some(start) = o.trim_start_ms {
            let secs = start as f64 / 1000.0;
            pre_input.push("-ss".into());
            pre_input.push(format!("{secs:.3}"));
        }
        if let Some(end) = o.trim_end_ms {
            let secs = end as f64 / 1000.0;
            pre_input.push("-to".into());
            pre_input.push(format!("{secs:.3}"));
        }
    }

    // The pre-input args (-ss, -to) go BEFORE -i. The caller (ffmpeg.rs)
    // must prepend them. We store them at the start of `args` and document
    // the convention: args before the sentinel "__INPUT__" go before -i.
    let mut all_args = pre_input;
    all_args.push("__INPUT__".into());
    all_args.extend(args(&["-loop", "0"]));

    Plan {
        args: all_args,
        video_filters: vec![filter],
        reencoded: true,
        ext: "gif",
    }
}

// ---------------------------------------------------------------------------
// AVI
// ---------------------------------------------------------------------------

fn plan_avi(vcodec: Option<&str>, acodec: Option<&str>) -> Plan {
    match (vcodec, acodec) {
        (Some("mpeg4"), Some("mp3")) => Plan {
            args: args(&["-c", "copy"]),
            video_filters: vec![],
            reencoded: false,
            ext: "avi",
        },
        _ => Plan {
            args: args(&[
                "-c:v",
                "libxvid",
                "-q:v",
                "4",
                "-c:a",
                "libmp3lame",
                "-q:a",
                "2",
            ]),
            video_filters: vec![],
            reencoded: true,
            ext: "avi",
        },
    }
}

// ---------------------------------------------------------------------------
// Audio format helpers
// ---------------------------------------------------------------------------

fn plan_audio_only(acodec: Option<&str>, f: fn(Option<&str>) -> Plan) -> Plan {
    f(acodec)
}

fn audio_mp3(acodec: Option<&str>) -> Plan {
    match acodec {
        Some("mp3") => audio_copy("mp3"),
        _ => Plan {
            args: args(&["-vn", "-c:a", "libmp3lame", "-q:a", "2"]),
            video_filters: vec![],
            reencoded: true,
            ext: "mp3",
        },
    }
}

fn audio_m4a(acodec: Option<&str>) -> Plan {
    match acodec {
        Some("aac") => audio_copy("m4a"),
        _ => Plan {
            args: args(&["-vn", "-c:a", "aac", "-b:a", "192k"]),
            video_filters: vec![],
            reencoded: true,
            ext: "m4a",
        },
    }
}

fn audio_opus(acodec: Option<&str>) -> Plan {
    match acodec {
        Some("opus") => audio_copy("opus"),
        _ => Plan {
            args: args(&["-vn", "-c:a", "libopus", "-b:a", "128k"]),
            video_filters: vec![],
            reencoded: true,
            ext: "opus",
        },
    }
}

fn audio_wav(acodec: Option<&str>) -> Plan {
    match acodec {
        Some("pcm_s16le") => audio_copy("wav"),
        _ => Plan {
            args: args(&["-vn", "-c:a", "pcm_s16le"]),
            video_filters: vec![],
            reencoded: true,
            ext: "wav",
        },
    }
}

fn audio_flac(acodec: Option<&str>) -> Plan {
    match acodec {
        Some("flac") => audio_copy("flac"),
        _ => Plan {
            args: args(&["-vn", "-c:a", "flac"]),
            video_filters: vec![],
            reencoded: true,
            ext: "flac",
        },
    }
}

fn audio_ogg(acodec: Option<&str>) -> Plan {
    match acodec {
        Some("vorbis") => audio_copy("ogg"),
        _ => Plan {
            args: args(&["-vn", "-c:a", "libvorbis", "-q:a", "5"]),
            video_filters: vec![],
            reencoded: true,
            ext: "ogg",
        },
    }
}

fn audio_aac_raw(acodec: Option<&str>) -> Plan {
    match acodec {
        Some("aac") => audio_copy("aac"),
        _ => Plan {
            args: args(&["-vn", "-c:a", "aac", "-b:a", "192k"]),
            video_filters: vec![],
            reencoded: true,
            ext: "aac",
        },
    }
}

fn audio_copy(ext: &'static str) -> Plan {
    Plan {
        args: args(&["-vn", "-c:a", "copy"]),
        video_filters: vec![],
        reencoded: false,
        ext,
    }
}

fn plan_extract_audio(acodec: Option<&str>) -> Plan {
    let ext = match acodec {
        Some("aac") => "m4a",
        Some("mp3") => "mp3",
        Some("opus") => "opus",
        Some("vorbis") => "ogg",
        _ => "mka",
    };
    audio_copy(ext)
}

// ---------------------------------------------------------------------------
// Quality preset mappings
// ---------------------------------------------------------------------------

fn h264_preset(q: QualityPreset) -> (&'static str, &'static str) {
    match q {
        QualityPreset::Original | QualityPreset::Balanced => ("medium", "23"),
        QualityPreset::Fast => ("ultrafast", "28"),
        QualityPreset::Small => ("slow", "32"),
    }
}

fn vp9_preset(q: QualityPreset) -> (&'static str, &'static str) {
    match q {
        QualityPreset::Original | QualityPreset::Balanced => ("good", "32"),
        QualityPreset::Fast => ("realtime", "40"),
        QualityPreset::Small => ("best", "38"),
    }
}

fn audio_bitrate(q: QualityPreset) -> &'static str {
    match q {
        QualityPreset::Original | QualityPreset::Balanced => "192k",
        QualityPreset::Fast => "128k",
        QualityPreset::Small => "96k",
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn d(target: TargetFormat, vc: Option<&str>, ac: Option<&str>) -> Plan {
        decide(target, vc, ac, None, None, None)
    }

    // --- Existing v0.1.3 tests (adapted to new signature) ---

    #[test]
    fn mp4_h264_aac_remuxes() {
        let p = d(TargetFormat::Mp4, Some("h264"), Some("aac"));
        assert!(!p.reencoded);
        assert_eq!(p.ext, "mp4");
        assert_eq!(p.args, vec!["-c", "copy"]);
    }

    #[test]
    fn mp4_h264_mp3_only_reencodes_audio() {
        let p = d(TargetFormat::Mp4, Some("h264"), Some("mp3"));
        assert!(p.reencoded);
        assert!(p.args.windows(2).any(|w| w == ["-c:v", "copy"]));
        assert!(p.args.windows(2).any(|w| w == ["-c:a", "aac"]));
    }

    #[test]
    fn mp4_other_vcodec_fully_reencodes() {
        let p = d(TargetFormat::Mp4, Some("vp9"), Some("opus"));
        assert!(p.reencoded);
        assert!(p.args.iter().any(|s| s == "libx264"));
    }

    #[test]
    fn mkv_always_remuxes() {
        let p = d(TargetFormat::Mkv, Some("hevc"), Some("flac"));
        assert!(!p.reencoded);
        assert_eq!(p.ext, "mkv");
    }

    #[test]
    fn webm_vp9_opus_remuxes() {
        let p = d(TargetFormat::Webm, Some("vp9"), Some("opus"));
        assert!(!p.reencoded);
    }

    #[test]
    fn webm_h264_forces_reencode() {
        let p = d(TargetFormat::Webm, Some("h264"), Some("aac"));
        assert!(p.reencoded);
        assert!(p.args.iter().any(|s| s == "libvpx-vp9"));
    }

    #[test]
    fn mp3_from_mp3_copies() {
        let p = d(TargetFormat::Mp3, None, Some("mp3"));
        assert!(!p.reencoded);
        assert!(p.args.iter().any(|s| s == "-vn"));
    }

    #[test]
    fn mp3_from_other_uses_lame() {
        let p = d(TargetFormat::Mp3, None, Some("aac"));
        assert!(p.reencoded);
        assert!(p.args.iter().any(|s| s == "libmp3lame"));
    }

    #[test]
    fn m4a_from_aac_copies() {
        let p = d(TargetFormat::M4a, None, Some("aac"));
        assert!(!p.reencoded);
    }

    #[test]
    fn opus_from_opus_copies() {
        let p = d(TargetFormat::Opus, None, Some("opus"));
        assert!(!p.reencoded);
    }

    #[test]
    fn wav_from_pcm_copies() {
        let p = d(TargetFormat::Wav, None, Some("pcm_s16le"));
        assert!(!p.reencoded);
    }

    #[test]
    fn wav_from_other_uses_pcm() {
        let p = d(TargetFormat::Wav, None, Some("aac"));
        assert!(p.reencoded);
        assert!(p.args.iter().any(|s| s == "pcm_s16le"));
    }

    #[test]
    fn extract_audio_keeps_codec_picks_ext() {
        assert_eq!(
            d(TargetFormat::ExtractAudioKeepCodec, None, Some("aac")).ext,
            "m4a"
        );
        assert_eq!(
            d(TargetFormat::ExtractAudioKeepCodec, None, Some("mp3")).ext,
            "mp3"
        );
        assert_eq!(
            d(TargetFormat::ExtractAudioKeepCodec, None, Some("opus")).ext,
            "opus"
        );
        assert_eq!(
            d(TargetFormat::ExtractAudioKeepCodec, None, Some("vorbis")).ext,
            "ogg"
        );
        assert_eq!(
            d(TargetFormat::ExtractAudioKeepCodec, None, Some("flac")).ext,
            "mka"
        );
        assert_eq!(
            d(TargetFormat::ExtractAudioKeepCodec, None, None).ext,
            "mka"
        );
    }

    #[test]
    fn extract_audio_always_copies() {
        let p = d(
            TargetFormat::ExtractAudioKeepCodec,
            Some("h264"),
            Some("aac"),
        );
        assert!(!p.reencoded);
        assert_eq!(p.args, vec!["-vn", "-c:a", "copy"]);
    }

    // --- v0.1.4 new format tests ---

    #[test]
    fn gif_always_reencodes_with_palettegen() {
        let p = d(TargetFormat::Gif, Some("h264"), Some("aac"));
        assert!(p.reencoded);
        assert_eq!(p.ext, "gif");
        assert!(p.video_filters[0].contains("palettegen"));
        assert!(p.args.iter().any(|s| s == "-loop"));
    }

    #[test]
    fn gif_uses_size_preset() {
        let opts = GifOptions {
            size_preset: GifSizePreset::Small,
            trim_start_ms: None,
            trim_end_ms: None,
        };
        let p = decide(TargetFormat::Gif, None, None, None, None, Some(&opts));
        assert!(p.video_filters[0].contains("scale=320"));

        let opts = GifOptions {
            size_preset: GifSizePreset::Large,
            trim_start_ms: None,
            trim_end_ms: None,
        };
        let p = decide(TargetFormat::Gif, None, None, None, None, Some(&opts));
        assert!(p.video_filters[0].contains("scale=720"));
    }

    #[test]
    fn gif_trim_adds_ss_and_to() {
        let opts = GifOptions {
            size_preset: GifSizePreset::Medium,
            trim_start_ms: Some(5000),
            trim_end_ms: Some(15000),
        };
        let p = decide(TargetFormat::Gif, None, None, None, None, Some(&opts));
        assert!(p.args.iter().any(|s| s == "-ss"));
        assert!(p.args.iter().any(|s| s == "-to"));
    }

    #[test]
    fn avi_mpeg4_mp3_remuxes() {
        let p = d(TargetFormat::Avi, Some("mpeg4"), Some("mp3"));
        assert!(!p.reencoded);
        assert_eq!(p.ext, "avi");
    }

    #[test]
    fn avi_other_reencodes() {
        let p = d(TargetFormat::Avi, Some("h264"), Some("aac"));
        assert!(p.reencoded);
        assert!(p.args.iter().any(|s| s == "libxvid"));
    }

    #[test]
    fn mov_h264_aac_remuxes_with_mov_ext() {
        let p = d(TargetFormat::Mov, Some("h264"), Some("aac"));
        assert!(!p.reencoded);
        assert_eq!(p.ext, "mov");
    }

    #[test]
    fn mov_other_reencodes() {
        let p = d(TargetFormat::Mov, Some("vp9"), Some("opus"));
        assert!(p.reencoded);
        assert_eq!(p.ext, "mov");
    }

    #[test]
    fn flac_from_flac_copies() {
        let p = d(TargetFormat::Flac, None, Some("flac"));
        assert!(!p.reencoded);
        assert_eq!(p.ext, "flac");
    }

    #[test]
    fn flac_from_other_reencodes() {
        let p = d(TargetFormat::Flac, None, Some("aac"));
        assert!(p.reencoded);
    }

    #[test]
    fn ogg_from_vorbis_copies() {
        let p = d(TargetFormat::Ogg, None, Some("vorbis"));
        assert!(!p.reencoded);
    }

    #[test]
    fn ogg_from_other_reencodes() {
        let p = d(TargetFormat::Ogg, None, Some("aac"));
        assert!(p.reencoded);
        assert!(p.args.iter().any(|s| s == "libvorbis"));
    }

    #[test]
    fn aac_from_aac_copies() {
        let p = d(TargetFormat::Aac, None, Some("aac"));
        assert!(!p.reencoded);
        assert_eq!(p.ext, "aac");
    }

    #[test]
    fn aac_from_other_reencodes() {
        let p = d(TargetFormat::Aac, None, Some("mp3"));
        assert!(p.reencoded);
    }

    // --- Compression preset tests ---

    #[test]
    fn fast_h264_uses_ultrafast() {
        let p = decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            Some(QualityPreset::Fast),
            None,
            None,
        );
        assert!(p.reencoded);
        assert!(p.args.iter().any(|s| s == "ultrafast"));
        assert!(p.args.iter().any(|s| s == "28"));
    }

    #[test]
    fn small_h264_uses_slow() {
        let p = decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            Some(QualityPreset::Small),
            None,
            None,
        );
        assert!(p.reencoded);
        assert!(p.args.iter().any(|s| s == "slow"));
        assert!(p.args.iter().any(|s| s == "32"));
    }

    #[test]
    fn balanced_webm_uses_good_deadline() {
        let p = decide(
            TargetFormat::Webm,
            Some("vp9"),
            Some("opus"),
            Some(QualityPreset::Balanced),
            None,
            None,
        );
        assert!(p.reencoded);
        assert!(p.args.iter().any(|s| s == "good"));
    }

    #[test]
    fn original_preset_preserves_remux() {
        let p = decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            Some(QualityPreset::Original),
            None,
            None,
        );
        assert!(!p.reencoded);
        assert_eq!(p.args, vec!["-c", "copy"]);
    }

    // --- Resolution cap tests ---

    #[test]
    fn r720p_adds_scale_filter() {
        let p = decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            Some(ResolutionCap::R720p),
            None,
        );
        assert!(p.reencoded);
        assert!(p.video_filters.iter().any(|f| f.contains("1280")));
    }

    #[test]
    fn r1080p_adds_scale_filter() {
        let p = decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            Some(ResolutionCap::R1080p),
            None,
        );
        assert!(p.video_filters.iter().any(|f| f.contains("1920")));
    }

    #[test]
    fn original_cap_no_filter() {
        let p = decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            Some(ResolutionCap::Original),
            None,
        );
        assert!(p.video_filters.is_empty());
    }

    #[test]
    fn resolution_cap_skipped_for_audio_only() {
        let p = decide(
            TargetFormat::Mp3,
            None,
            Some("aac"),
            None,
            Some(ResolutionCap::R720p),
            None,
        );
        assert!(p.video_filters.is_empty());
    }
}
