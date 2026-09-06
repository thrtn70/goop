use crate::encoders::DetectedEncoders;
use goop_core::{
    CompressMode, GifOptions, GifSizePreset, QualityPreset, ResolutionCap, TargetFormat,
};

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
    // `force_preset` is `Some(q)` when the caller asked for a re-encoding
    // preset. Binding the preset here (rather than using a parallel `bool`
    // flag) lets the branches below destructure it without panicking if a
    // new variant is added in future.
    let force_preset = match quality {
        Some(q @ (QualityPreset::Fast | QualityPreset::Balanced | QualityPreset::Small)) => Some(q),
        _ => None,
    };

    let mut plan = match target {
        TargetFormat::Mp4 => match force_preset {
            Some(q) => plan_mp4_encode(q),
            None => plan_mp4(vcodec, acodec),
        },
        TargetFormat::Mkv => match force_preset {
            Some(q) => plan_mkv_encode(q),
            None => remux("mkv"),
        },
        TargetFormat::Webm => match force_preset {
            Some(q) => plan_webm_encode(q),
            None => plan_webm(vcodec, acodec),
        },
        TargetFormat::Gif => plan_gif(gif_opts),
        TargetFormat::Avi => match force_preset {
            Some(_) => plan_avi_encode(),
            None => plan_avi(vcodec, acodec),
        },
        TargetFormat::Mov => {
            let mut p = match force_preset {
                Some(q) => plan_mp4_encode(q),
                None => plan_mp4(vcodec, acodec),
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
        TargetFormat::Srt | TargetFormat::Vtt => crate::subtitle::plan_extract(target),
        // Image targets are handled by ImageMagick, not ffmpeg.
        TargetFormat::Png
        | TargetFormat::Jpeg
        | TargetFormat::Webp
        | TargetFormat::Bmp
        | TargetFormat::Tiff
        | TargetFormat::Avif
        | TargetFormat::JpegXl => Plan {
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
            && !target.is_subtitle()
            && plan.args.iter().all(|a| a != "-vn")
        {
            let w = match cap {
                ResolutionCap::R1080p => 1920,
                ResolutionCap::R720p => 1280,
                ResolutionCap::R480p => 854,
                ResolutionCap::Original => unreachable!(),
            };
            // A cap is a ceiling, not a target. `scale={w}:-2` has no
            // source dimensions in play, so it enlarged anything already
            // smaller — a 640x480 clip came out of a "1080p cap" at
            // 1920x1440, spending bitrate to invent detail that was never
            // in the source. `min(w,iw)` clamps it to a real ceiling.
            //
            // `trunc(../2)*2` then forces that width even. `-2` only ever
            // rounded the height; the width was safe by luck before, being
            // always the even cap constant. Clamping hands the source's
            // own width through instead, so an odd one survives to the
            // output. No plan here pins a pixel format, so ffmpeg carries
            // 4:4:4 through and encodes it happily — but 4:2:0 cannot
            // represent an odd width at all, and it is what nearly
            // everything downstream expects. Rounding down keeps the
            // output encodable anywhere without ever rounding *up* into
            // the upscale this whole clamp exists to prevent.
            //
            // The quotes are ffmpeg's, not a shell's: args go straight to
            // the process, and the commas inside the expression would
            // otherwise read as filter separators once `video_filters` is
            // joined into one `-vf`.
            plan.video_filters
                .insert(0, format!("scale='trunc(min({w},iw)/2)*2':-2"));
            // A filtergraph cannot be applied to a copied stream: ffmpeg
            // rejects the whole command with "Filtering and streamcopy
            // cannot be used together" and writes no output. So a cap on
            // top of a remux plan has to become a real encode, not just a
            // `reencoded` flag flip.
            force_video_encode(&mut plan, target, quality);
            plan.reencoded = true;
        }
    }

    plan
}

/// Swap a plan's video stream-copy for `target`'s encode args, in place.
///
/// A no-op when the plan already encodes video. The audio side is carried
/// over untouched — a resolution cap is a video filter, so audio the plan
/// was going to copy stays copied (faster, and no extra lossy generation)
/// and audio it was already re-encoding keeps those args.
fn force_video_encode(plan: &mut Plan, target: TargetFormat, quality: Option<QualityPreset>) {
    if !copies_video(&plan.args) {
        return;
    }
    let Some(encode) = video_encode_plan(target, quality) else {
        // Unreachable while `video_encode_plan` stays exhaustive, but the
        // failure mode is silent and identical to the bug this function
        // exists to prevent — `-c copy` left under the filter the caller
        // just inserted — so say so loudly rather than ship it.
        debug_assert!(
            false,
            "{target:?} stream-copies video but has no encode plan; a \
             resolution cap on it would pair -vf with -c copy"
        );
        return;
    };

    // Every plan built above orders its args video-first, so the audio
    // block is everything from the first `-c:a` onward. A plain `-c copy`
    // has no such marker: it was copying audio too, so say so explicitly
    // now that the blanket selector is going away.
    let audio_start = |argv: &[String]| argv.iter().position(|a| a == "-c:a");
    let audio: Vec<String> = match audio_start(&plan.args) {
        Some(i) => plan.args[i..].to_vec(),
        None => args(&["-c:a", "copy"]),
    };

    let mut new_args = match audio_start(&encode.args) {
        Some(i) => encode.args[..i].to_vec(),
        None => encode.args.clone(),
    };
    new_args.extend(audio);
    plan.args = new_args;

    debug_assert!(
        !copies_video(&plan.args),
        "{target:?} still stream-copies video after the rewrite: {:?}",
        plan.args
    );
}

/// Whether `args` hands the video stream to the `copy` pseudo-encoder,
/// either on its own (`-c:v copy`), via a stream-indexed selector
/// (`-c:v:0 copy`), or via the blanket selector (`-c copy`).
///
/// The indexed form matches nothing built today, but reading it as "not a
/// copy" would be the silent-failure direction: the caller would leave
/// `-vf` paired with a stream copy, which is the bug this guards.
fn copies_video(args: &[String]) -> bool {
    args.windows(2)
        .any(|w| (w[0] == "-c" || w[0].starts_with("-c:v")) && w[1] == "copy")
}

/// The encoding plan for a video container target, used when something
/// (today: a resolution cap) forces an encode a remux plan didn't expect.
///
/// `None` for targets that never stream-copy video under a filter —
/// audio-only, images, subtitles, and GIF, which always encodes.
fn video_encode_plan(target: TargetFormat, quality: Option<QualityPreset>) -> Option<Plan> {
    // `Original` maps to the same knobs as `Balanced` in every preset
    // table below, so it needs no special case.
    let q = quality.unwrap_or(QualityPreset::Balanced);
    // Exhaustive on purpose rather than a `_ => None` wildcard: a new video
    // container that stream-copies would otherwise fall through to `None`,
    // silently keeping `-c copy` under a `scale` filter — the exact command
    // ffmpeg refuses. Adding a variant stops this compiling instead, which
    // is the prompt to decide which arm it belongs in.
    match target {
        TargetFormat::Mp4 | TargetFormat::Mov => Some(plan_mp4_encode(q)),
        TargetFormat::Mkv => Some(plan_mkv_encode(q)),
        TargetFormat::Webm => Some(plan_webm_encode(q)),
        TargetFormat::Avi => Some(plan_avi_encode()),
        // GIF always encodes, so it never reaches here with a copy plan.
        // The rest carry no video stream for a filter to act on: audio-only
        // and subtitle targets, and images (handled by ImageMagick).
        TargetFormat::Gif
        | TargetFormat::Mp3
        | TargetFormat::M4a
        | TargetFormat::Opus
        | TargetFormat::Wav
        | TargetFormat::Flac
        | TargetFormat::Ogg
        | TargetFormat::Aac
        | TargetFormat::ExtractAudioKeepCodec
        | TargetFormat::Srt
        | TargetFormat::Vtt
        | TargetFormat::Png
        | TargetFormat::Jpeg
        | TargetFormat::Webp
        | TargetFormat::Bmp
        | TargetFormat::Tiff
        | TargetFormat::Avif
        | TargetFormat::JpegXl => None,
    }
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
        _ => plan_avi_encode(),
    }
}

/// MPEG-4 part 2 video + MP3 audio, the pairing AVI holds natively and
/// the one `plan_avi` stream-copies, so an encode here round-trips.
///
/// Deliberately ffmpeg's built-in `mpeg4` encoder rather than `libxvid`,
/// which this named previously: libxvid is an external GPL library that
/// has to be compiled in, and the two prebuilt sidecars disagree about
/// it — gyan's Windows build carries it, the osxexperts macOS build does
/// not. Every AVI conversion needing a video encode — which is
/// essentially all of them, h.264 being the norm — died on macOS with
/// "Unknown encoder 'libxvid'". `mpeg4` is part of libavcodec itself, so
/// it is present in both builds and produces the same codec.
///
/// `-vtag xvid` keeps the FourCC libxvid used to write. AVI's whole
/// reason for being on the target list is players too old to know
/// anything newer, and those dispatch on the FourCC — they recognise
/// `xvid` where they may not recognise the native encoder's `FMP4`.
/// It relabels only the container tag; the bitstream is unchanged, and
/// ffprobe still reports the stream as `mpeg4`.
fn plan_avi_encode() -> Plan {
    Plan {
        args: args(&[
            "-c:v",
            "mpeg4",
            "-vtag",
            "xvid",
            // The same 1-31 qscale libxvid took, lower being better, so
            // the output quality target is unchanged.
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

pub(crate) fn h264_preset(q: QualityPreset) -> (&'static str, &'static str) {
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
// Hardware-accelerated h.264 substitution (v0.1.9)
//
// Plans built above default to libx264 (software). When the user has HW
// acceleration enabled and a GPU encoder is available, we replace the
// `-c:v libx264 -preset X -crf Y` block with the equivalent for the
// detected encoder. Audio + filter args pass through untouched.
// ---------------------------------------------------------------------------

/// Walk `args`, find the `-c:v libx264` block and its trailing `-preset` /
/// `-crf` arguments, and rewrite them to use `hw_encoder` with quality args
/// chosen for `quality`. Returns `Some(replacement)` on substitution and
/// `None` if `args` doesn't contain a libx264 codec selector.
pub fn substitute_h264_hw(
    args: &[String],
    hw_encoder: &str,
    quality: Option<QualityPreset>,
) -> Option<Vec<String>> {
    let codec_idx = args
        .windows(2)
        .position(|w| w[0] == "-c:v" && w[1] == "libx264")?;
    let mut out = Vec::with_capacity(args.len() + 4);
    out.extend(args[..codec_idx].iter().cloned());
    out.push("-c:v".into());
    out.push(hw_encoder.into());
    let mut i = codec_idx + 2;
    // Skip any -preset / -crf pair following the codec selector. Other
    // args pass through (e.g. -pix_fmt) — we don't drop them.
    while i + 1 < args.len() && (args[i] == "-preset" || args[i] == "-crf") {
        i += 2;
    }
    out.extend(
        hw_h264_quality_args(hw_encoder, quality)
            .iter()
            .map(|s| (*s).to_string()),
    );
    out.extend(args[i..].iter().cloned());
    Some(out)
}

/// Apply HW h.264 substitution in place, returning the encoder name used
/// (or `None` if no substitution applied). Convenience wrapper that hides
/// the encoder-availability check.
pub fn maybe_apply_hw_h264(
    plan: &mut Plan,
    encoders: &DetectedEncoders,
    quality: Option<QualityPreset>,
) -> Option<&'static str> {
    let hw = encoders.preferred_h264()?;
    let new_args = substitute_h264_hw(&plan.args, hw, quality)?;
    plan.args = new_args;
    Some(hw)
}

fn hw_h264_quality_args(encoder: &str, q: Option<QualityPreset>) -> &'static [&'static str] {
    let q = q.unwrap_or(QualityPreset::Balanced);
    match (encoder, q) {
        ("h264_videotoolbox", QualityPreset::Fast) => &["-q:v", "50"],
        ("h264_videotoolbox", QualityPreset::Original | QualityPreset::Balanced) => &["-q:v", "65"],
        ("h264_videotoolbox", QualityPreset::Small) => &["-q:v", "80"],
        ("h264_nvenc", QualityPreset::Fast) => &["-preset", "p3", "-cq", "28"],
        ("h264_nvenc", QualityPreset::Original | QualityPreset::Balanced) => {
            &["-preset", "p5", "-cq", "23"]
        }
        ("h264_nvenc", QualityPreset::Small) => &["-preset", "p7", "-cq", "20"],
        ("h264_qsv", QualityPreset::Fast) => &["-preset", "fast", "-global_quality", "28"],
        ("h264_qsv", QualityPreset::Original | QualityPreset::Balanced) => {
            &["-preset", "medium", "-global_quality", "23"]
        }
        ("h264_qsv", QualityPreset::Small) => &["-preset", "slow", "-global_quality", "20"],
        ("h264_amf", QualityPreset::Fast) => &[
            "-quality", "speed", "-rc", "cqp", "-qp_i", "28", "-qp_p", "30",
        ],
        ("h264_amf", QualityPreset::Original | QualityPreset::Balanced) => &[
            "-quality", "balanced", "-rc", "cqp", "-qp_i", "23", "-qp_p", "25",
        ],
        ("h264_amf", QualityPreset::Small) => &[
            "-quality", "quality", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22",
        ],
        // Unknown encoder — emit no quality args; ffmpeg uses encoder defaults.
        _ => &[],
    }
}

// ---------------------------------------------------------------------------
// Compression (v0.1.6)
// ---------------------------------------------------------------------------

/// Build a compression plan for the Compress tab.
///
/// `target` is the source's existing format (Compress keeps the container).
/// `duration_ms` is required for `TargetSizeBytes` on video/audio; pass 0 for
/// image targets (which route through the ImageMagick backend rather than
/// this function).
///
/// Image targets (`Png`, `Jpeg`, `Webp`, `Bmp`) are **not** handled here.
/// The caller is expected to dispatch image compression to the ImageMagick
/// backend's in-memory encode path, which performs iterative quality search
/// for `TargetSizeBytes`. This function returns an empty plan for image
/// targets so ffmpeg never processes them.
pub fn decide_compression(
    target: TargetFormat,
    vcodec: Option<&str>,
    acodec: Option<&str>,
    mode: CompressMode,
    duration_ms: u64,
) -> Plan {
    if target.is_image() {
        return Plan {
            args: vec![],
            video_filters: vec![],
            reencoded: true,
            ext: target.extension(),
        };
    }

    match target {
        TargetFormat::Mp4 | TargetFormat::Mkv | TargetFormat::Mov | TargetFormat::Avi => {
            let mut p = compress_video_h264(mode, duration_ms, vcodec, acodec);
            p.ext = target.extension();
            p
        }
        TargetFormat::Webm => compress_video_vp9(mode, duration_ms),
        TargetFormat::Gif => {
            // GIFs are already heavily compressed via palettegen; quality/size
            // controls don't translate cleanly. Fall back to the standard GIF
            // plan (same as Convert) so the user still gets a result.
            plan_gif(None)
        }
        TargetFormat::Mp3 => compress_audio(mode, duration_ms, "libmp3lame", "mp3", 32, 320),
        TargetFormat::M4a | TargetFormat::Aac => {
            compress_audio(mode, duration_ms, "aac", target.extension(), 32, 320)
        }
        TargetFormat::Opus => compress_audio(mode, duration_ms, "libopus", "opus", 16, 256),
        TargetFormat::Ogg => compress_audio(mode, duration_ms, "libvorbis", "ogg", 32, 320),
        TargetFormat::Flac | TargetFormat::Wav => {
            // Lossless formats — Quality/TargetSize don't reduce size
            // meaningfully. Return the same plan as a normal encode (caller
            // will get a warning in the UI when they pick these sources).
            match target {
                TargetFormat::Flac => audio_flac(acodec),
                TargetFormat::Wav => audio_wav(acodec),
                _ => unreachable!(),
            }
        }
        TargetFormat::ExtractAudioKeepCodec => plan_extract_audio(acodec),
        // Subtitle extraction has no size to compress — the Compress tab
        // never offers these targets, so fall back to the convert plan.
        TargetFormat::Srt | TargetFormat::Vtt => crate::subtitle::plan_extract(target),
        // Image targets handled above.
        TargetFormat::Png
        | TargetFormat::Jpeg
        | TargetFormat::Webp
        | TargetFormat::Bmp
        | TargetFormat::Tiff
        | TargetFormat::Avif
        | TargetFormat::JpegXl => {
            unreachable!("image targets short-circuit at the top of decide_compression")
        }
    }
}

/// Linear slider-to-CRF mapping: 100 -> crf 18, 50 -> crf 28, 1 -> crf 40.
/// Clamped to [18, 40].
pub(crate) fn slider_to_crf(slider: u8) -> u8 {
    let slider = slider.clamp(1, 100) as i32;
    // 40 at slider=1, 18 at slider=100 -> linear between them.
    let crf = 40 - ((slider - 1) * 22) / 99;
    crf.clamp(18, 40) as u8
}

/// Linear slider-to-audio-bitrate mapping, clamped to [min_kbps, max_kbps].
/// 100 -> max, 50 -> roughly center, 1 -> min.
pub(crate) fn slider_to_audio_kbps(slider: u8, min_kbps: u32, max_kbps: u32) -> u32 {
    let slider = slider.clamp(1, 100) as u32;
    let range = max_kbps.saturating_sub(min_kbps);
    min_kbps + (range * (slider - 1) / 99)
}

/// Target-size bitrate math for audio (single stream).
/// Returns kbps clamped to [min_kbps, max_kbps]. Returns min_kbps if duration
/// is zero (undefined math, pick the safest floor).
pub(crate) fn target_bytes_to_audio_kbps(
    target_bytes: u64,
    duration_ms: u64,
    min_kbps: u32,
    max_kbps: u32,
) -> u32 {
    if duration_ms == 0 {
        return min_kbps;
    }
    let kbps = (target_bytes.saturating_mul(8) / 1000) / (duration_ms / 1000).max(1);
    (kbps as u32).clamp(min_kbps, max_kbps)
}

/// Target-size bitrate math for video. Reserves 128 kbps for audio and gives
/// the rest to video. Enforces a 100-kbps video floor for readability.
pub(crate) fn target_bytes_to_video_kbps(target_bytes: u64, duration_ms: u64) -> (u32, u32) {
    let audio_reserve: u32 = 128;
    if duration_ms == 0 {
        return (100, audio_reserve);
    }
    let total_kbps = (target_bytes.saturating_mul(8) / 1000) / (duration_ms / 1000).max(1);
    let total = total_kbps as u32;
    let video = total.saturating_sub(audio_reserve).max(100);
    (video, audio_reserve)
}

fn compress_video_h264(
    mode: CompressMode,
    duration_ms: u64,
    _vcodec: Option<&str>,
    _acodec: Option<&str>,
) -> Plan {
    match mode {
        CompressMode::Quality(slider) => {
            let crf = slider_to_crf(slider).to_string();
            Plan {
                args: args(&[
                    "-c:v", "libx264", "-preset", "medium", "-crf", &crf, "-c:a", "aac", "-b:a",
                    "192k",
                ]),
                video_filters: vec![],
                reencoded: true,
                ext: "mp4",
            }
        }
        CompressMode::TargetSizeBytes(bytes) => {
            let (v_kbps, a_kbps) = target_bytes_to_video_kbps(bytes, duration_ms);
            let maxrate = (v_kbps * 3 / 2).to_string();
            let bufsize = (v_kbps * 2).to_string();
            let b_v = format!("{v_kbps}k");
            let maxrate_k = format!("{maxrate}k");
            let bufsize_k = format!("{bufsize}k");
            let b_a = format!("{a_kbps}k");
            Plan {
                args: vec![
                    "-c:v".into(),
                    "libx264".into(),
                    "-preset".into(),
                    "medium".into(),
                    "-b:v".into(),
                    b_v,
                    "-maxrate".into(),
                    maxrate_k,
                    "-bufsize".into(),
                    bufsize_k,
                    "-c:a".into(),
                    "aac".into(),
                    "-b:a".into(),
                    b_a,
                ],
                video_filters: vec![],
                reencoded: true,
                ext: "mp4",
            }
        }
        CompressMode::LosslessReoptimize => {
            // Not meaningful for video; fall back to a quality=50 encode so
            // we still produce output rather than silently doing nothing.
            compress_video_h264(CompressMode::Quality(50), duration_ms, _vcodec, _acodec)
        }
    }
}

fn compress_video_vp9(mode: CompressMode, duration_ms: u64) -> Plan {
    match mode {
        CompressMode::Quality(slider) => {
            let crf = slider_to_crf(slider).to_string();
            Plan {
                args: args(&[
                    "-c:v",
                    "libvpx-vp9",
                    "-deadline",
                    "good",
                    "-b:v",
                    "0",
                    "-crf",
                    &crf,
                    "-c:a",
                    "libopus",
                ]),
                video_filters: vec![],
                reencoded: true,
                ext: "webm",
            }
        }
        CompressMode::TargetSizeBytes(bytes) => {
            let (v_kbps, a_kbps) = target_bytes_to_video_kbps(bytes, duration_ms);
            let b_v = format!("{v_kbps}k");
            let minrate_k = format!("{}k", v_kbps / 2);
            let maxrate_k = format!("{}k", v_kbps * 3 / 2);
            let b_a = format!("{a_kbps}k");
            Plan {
                args: vec![
                    "-c:v".into(),
                    "libvpx-vp9".into(),
                    "-deadline".into(),
                    "good".into(),
                    "-b:v".into(),
                    b_v,
                    "-minrate".into(),
                    minrate_k,
                    "-maxrate".into(),
                    maxrate_k,
                    "-c:a".into(),
                    "libopus".into(),
                    "-b:a".into(),
                    b_a,
                ],
                video_filters: vec![],
                reencoded: true,
                ext: "webm",
            }
        }
        CompressMode::LosslessReoptimize => {
            compress_video_vp9(CompressMode::Quality(50), duration_ms)
        }
    }
}

fn compress_audio(
    mode: CompressMode,
    duration_ms: u64,
    codec: &'static str,
    ext: &'static str,
    min_kbps: u32,
    max_kbps: u32,
) -> Plan {
    let kbps = match mode {
        CompressMode::Quality(slider) => slider_to_audio_kbps(slider, min_kbps, max_kbps),
        CompressMode::TargetSizeBytes(bytes) => {
            target_bytes_to_audio_kbps(bytes, duration_ms, min_kbps, max_kbps)
        }
        CompressMode::LosslessReoptimize => slider_to_audio_kbps(50, min_kbps, max_kbps),
    };
    let b_a = format!("{kbps}k");
    Plan {
        args: vec![
            "-vn".into(),
            "-c:a".into(),
            codec.into(),
            "-b:a".into(),
            b_a,
        ],
        video_filters: vec![],
        reencoded: true,
        ext,
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

    // --- Subtitle targets + burn-in prerequisites ---

    #[test]
    fn srt_target_extracts_first_subtitle_stream() {
        let p = d(TargetFormat::Srt, None, None);
        assert_eq!(p.args, vec!["-map", "0:s:0", "-c:s", "srt"]);
        assert_eq!(p.ext, "srt");
        assert!(p.reencoded);
        assert!(p.video_filters.is_empty());
    }

    #[test]
    fn vtt_target_extracts_first_subtitle_stream() {
        let p = d(TargetFormat::Vtt, None, None);
        assert_eq!(p.args, vec!["-map", "0:s:0", "-c:s", "webvtt"]);
        assert_eq!(p.ext, "vtt");
    }

    #[test]
    fn resolution_cap_is_ignored_for_subtitle_targets() {
        // A subtitle-only output has no video stream to scale; a stray cap
        // (e.g. left over from a preset) must not add a `scale` filter.
        let p = decide(
            TargetFormat::Srt,
            None,
            None,
            None,
            Some(ResolutionCap::R720p),
            None,
        );
        assert!(p.video_filters.is_empty());
    }

    #[test]
    fn avi_quality_preset_forces_reencode() {
        // Every other target honours an explicit preset; AVI used to ignore
        // it and remux, which would silently skip burn-in.
        let p = decide(
            TargetFormat::Avi,
            Some("mpeg4"),
            Some("mp3"),
            Some(QualityPreset::Fast),
            None,
            None,
        );
        assert!(p.reencoded, "an explicit preset must force an encode");
        assert!(p.args.iter().any(|a| a == "mpeg4"));
    }

    #[test]
    fn avi_without_preset_still_remuxes_compatible_streams() {
        let p = d(TargetFormat::Avi, Some("mpeg4"), Some("mp3"));
        assert!(!p.reencoded);
        assert_eq!(p.args, vec!["-c", "copy"]);
    }

    #[test]
    fn hw_substitution_preserves_trailing_subtitle_args() {
        // Soft-embed appends `-map`/`-c:s` to the end of plan.args. The HW
        // encoder rewrite walks the `-c:v libx264` window; everything after
        // it must survive verbatim and in order, or the muxed subtitle
        // track vanishes whenever GPU encoding kicks in.
        let mut p = decide(
            TargetFormat::Mp4,
            Some("hevc"),
            Some("aac"),
            Some(QualityPreset::Balanced),
            None,
            None,
        );
        p.args
            .extend(args(&["-map", "0:v:0?", "-map", "1:0", "-c:s", "mov_text"]));
        let out = substitute_h264_hw(&p.args, "h264_videotoolbox", Some(QualityPreset::Balanced))
            .expect("libx264 plan must substitute");
        assert!(out.windows(2).any(|w| w == ["-c:v", "h264_videotoolbox"]));
        let tail: Vec<&str> = out
            .iter()
            .skip_while(|a| *a != "-map")
            .map(String::as_str)
            .collect();
        assert_eq!(
            tail,
            vec!["-map", "0:v:0?", "-map", "1:0", "-c:s", "mov_text"]
        );
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
        // `mpeg4` (libavcodec's own) rather than `libxvid` (an external
        // library the macOS sidecar isn't built with) — see
        // `plan_avi_encode`. Pinned because the arg vector is the only
        // place the choice is visible without running ffmpeg.
        assert!(p.args.iter().any(|s| s == "mpeg4"));
        assert!(!p.args.iter().any(|s| s == "libxvid"));
    }

    #[test]
    fn avi_encode_lands_on_the_codecs_the_remux_path_accepts() {
        // Otherwise re-running an AVI conversion on its own output
        // re-encodes every time instead of stream-copying.
        let encoded = d(TargetFormat::Avi, Some("h264"), Some("aac"));
        assert!(encoded.reencoded);
        let again = d(TargetFormat::Avi, Some("mpeg4"), Some("mp3"));
        assert!(!again.reencoded, "goop's own AVI output must remux");
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
        assert!(p.video_filters.iter().any(|f| f == CAPPED_720P));
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
        assert!(p
            .video_filters
            .iter()
            .any(|x| x == "scale='trunc(min(1920,iw)/2)*2':-2"));
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

    /// The exact filter a 720p cap must produce. Asserted whole rather than
    /// by substring: the `min()` clamp and its quoting are the point, and a
    /// `contains("scale=1280")` check passed happily while the filter was
    /// still upscaling every source smaller than the cap.
    const CAPPED_720P: &str = "scale='trunc(min(1280,iw)/2)*2':-2";

    /// Every `(target, vcodec, acodec)` whose no-preset plan stream-copies
    /// the video — the exact set a resolution cap has to convert into an
    /// encode.
    const REMUXING_SOURCES: &[(TargetFormat, Option<&str>, Option<&str>)] = &[
        // `-c copy` (both streams)
        (TargetFormat::Mp4, Some("h264"), Some("aac")),
        (TargetFormat::Mkv, Some("hevc"), Some("flac")),
        (TargetFormat::Mov, Some("h264"), Some("aac")),
        (TargetFormat::Avi, Some("mpeg4"), Some("mp3")),
        (TargetFormat::Webm, Some("vp9"), Some("opus")),
        // `-c:v copy` with the audio already re-encoded
        (TargetFormat::Mp4, Some("h264"), Some("mp3")),
        (TargetFormat::Mov, Some("h264"), Some("mp3")),
    ];

    #[test]
    fn a_capped_plan_never_stream_copies_the_video() {
        // A filtergraph and stream copy are mutually exclusive — ffmpeg
        // refuses the command outright with "Filtering and streamcopy
        // cannot be used together" and writes nothing. Inserting the
        // `scale` filter therefore has to replace the copy codec args,
        // not just flip the `reencoded` flag.
        for &(target, v, a) in REMUXING_SOURCES {
            let uncapped = decide(target, v, a, None, None, None);
            assert!(
                copies_video(&uncapped.args),
                "{target:?} {v:?}/{a:?} is meant to be a stream-copy case, \
                 got {:?}",
                uncapped.args
            );

            let p = decide(target, v, a, None, Some(ResolutionCap::R720p), None);
            assert!(
                p.video_filters.iter().any(|f| f == CAPPED_720P),
                "{target:?} {v:?}/{a:?} lost the cap: {:?}",
                p.video_filters
            );
            assert!(p.reencoded, "{target:?} {v:?}/{a:?}");
            assert!(
                !copies_video(&p.args),
                "{target:?} {v:?}/{a:?} pairs -vf with a video stream copy: {:?}",
                p.args
            );
        }
    }

    #[test]
    fn a_capped_plan_encodes_with_the_same_codec_as_a_forced_encode() {
        // Asserted against the target's own encode plan rather than a
        // hardcoded encoder name: the cap path must not invent a codec the
        // container (or the bundled ffmpeg) doesn't take.
        for &(target, v, a) in REMUXING_SOURCES {
            let capped = decide(target, v, a, None, Some(ResolutionCap::R720p), None);
            let forced = decide(target, v, a, Some(QualityPreset::Balanced), None, None);
            let vcodec = |args: &[String]| {
                args.windows(2)
                    .find(|w| w[0] == "-c:v")
                    .map(|w| w[1].clone())
            };
            assert_eq!(
                vcodec(&capped.args),
                vcodec(&forced.args),
                "{target:?} {v:?}/{a:?}: capped {:?} vs forced {:?}",
                capped.args,
                forced.args
            );
        }
    }

    #[test]
    fn a_capped_plan_keeps_the_audio_it_would_have_copied() {
        // The cap is a *video* filter. Re-encoding audio that was going to
        // be copied costs time and a generation of quality for nothing.
        let p = decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            Some(ResolutionCap::R720p),
            None,
        );
        assert!(
            p.args.windows(2).any(|w| w == ["-c:a", "copy"]),
            "{:?}",
            p.args
        );
    }

    #[test]
    fn a_capped_plan_keeps_the_audio_re_encode_it_already_had() {
        // h264+mp3 into MP4 copies video but transcodes audio to AAC. The
        // cap replaces only the video half; dropping `-c:a aac` here would
        // leave MP4 with an MP3 track it can't legally carry.
        let p = decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("mp3"),
            None,
            Some(ResolutionCap::R720p),
            None,
        );
        assert!(
            p.args.windows(2).any(|w| w == ["-c:a", "aac"]),
            "{:?}",
            p.args
        );
        assert!(
            p.args.windows(2).any(|w| w == ["-b:a", "192k"]),
            "{:?}",
            p.args
        );
    }

    #[test]
    fn a_capped_plan_that_already_encodes_is_left_alone() {
        // The cap must not overwrite an explicit preset's own args.
        let forced = decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            Some(QualityPreset::Small),
            None,
            None,
        );
        let capped = decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            Some(QualityPreset::Small),
            Some(ResolutionCap::R720p),
            None,
        );
        assert_eq!(capped.args, forced.args);
        assert!(capped.video_filters.iter().any(|f| f == CAPPED_720P));
    }

    #[test]
    fn a_capped_remux_still_takes_the_hw_encoder() {
        // `substitute_h264_hw` finds its target by scanning for a
        // `-c:v libx264` window. If the cap rewrite emitted the codec any
        // other way, GPU encoding would silently stop applying to exactly
        // the conversions that most need it — a scale plus a full encode.
        let plan = decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            Some(ResolutionCap::R720p),
            None,
        );
        let out = substitute_h264_hw(&plan.args, "h264_videotoolbox", None)
            .expect("a capped remux must expose a libx264 window to substitute");
        assert!(out.windows(2).any(|w| w == ["-c:v", "h264_videotoolbox"]));
        // The carried-over audio copy has to survive that rewrite too.
        assert!(out.windows(2).any(|w| w == ["-c:a", "copy"]), "{out:?}");
    }

    /// Every `TargetFormat`, so the two structural tests below cannot go
    /// stale by omission. Exhaustive `match` rather than a literal list:
    /// adding a variant stops this compiling, which is the prompt to add
    /// it here too.
    const ALL_TARGETS: &[TargetFormat] = &[
        TargetFormat::Mp4,
        TargetFormat::Mov,
        TargetFormat::Mkv,
        TargetFormat::Webm,
        TargetFormat::Avi,
        TargetFormat::Gif,
        TargetFormat::Mp3,
        TargetFormat::M4a,
        TargetFormat::Opus,
        TargetFormat::Wav,
        TargetFormat::Flac,
        TargetFormat::Ogg,
        TargetFormat::Aac,
        TargetFormat::ExtractAudioKeepCodec,
        TargetFormat::Srt,
        TargetFormat::Vtt,
        TargetFormat::Png,
        TargetFormat::Jpeg,
        TargetFormat::Webp,
        TargetFormat::Bmp,
        TargetFormat::Tiff,
        TargetFormat::Avif,
        TargetFormat::JpegXl,
    ];

    #[test]
    fn all_targets_is_complete() {
        fn seen(t: TargetFormat) -> bool {
            match t {
                TargetFormat::Mp4
                | TargetFormat::Mov
                | TargetFormat::Mkv
                | TargetFormat::Webm
                | TargetFormat::Avi
                | TargetFormat::Gif
                | TargetFormat::Mp3
                | TargetFormat::M4a
                | TargetFormat::Opus
                | TargetFormat::Wav
                | TargetFormat::Flac
                | TargetFormat::Ogg
                | TargetFormat::Aac
                | TargetFormat::ExtractAudioKeepCodec
                | TargetFormat::Srt
                | TargetFormat::Vtt
                | TargetFormat::Png
                | TargetFormat::Jpeg
                | TargetFormat::Webp
                | TargetFormat::Bmp
                | TargetFormat::Tiff
                | TargetFormat::Avif
                | TargetFormat::JpegXl => true,
            }
        }
        for &t in ALL_TARGETS {
            assert!(seen(t));
        }
        assert_eq!(ALL_TARGETS.len(), 23, "a variant was added or removed");
    }

    #[test]
    fn every_target_that_can_stream_copy_video_has_an_encode_plan() {
        // `force_video_encode`'s `None` arm is guarded only by a
        // `debug_assert!`, which compiles away in the release binary the
        // app actually ships. Exhaustiveness makes `video_encode_plan`
        // cover every variant but says nothing about which *arm* each one
        // lands in — so moving a container to the `None` arm while its
        // plan still stream-copies would compile, pass a debug test run
        // only by luck, and in release silently leave `-c copy` under the
        // `scale` filter: this exact bug, back again.
        //
        // Pin the real invariant instead: whatever can produce a
        // copy-plan must have somewhere to be re-encoded to.
        const PROBES: &[(Option<&str>, Option<&str>)] = &[
            (Some("h264"), Some("aac")),
            (Some("h264"), Some("mp3")),
            (Some("mpeg4"), Some("mp3")),
            (Some("vp9"), Some("opus")),
            (Some("hevc"), Some("flac")),
            (None, None),
        ];
        for &target in ALL_TARGETS {
            for &(v, a) in PROBES {
                let plan = decide(target, v, a, None, None, None);
                if copies_video(&plan.args) {
                    assert!(
                        video_encode_plan(target, None).is_some(),
                        "{target:?} stream-copies video for {v:?}/{a:?} but has \
                         no encode plan, so a cap on it would pair -vf with -c copy"
                    );
                }
            }
        }
    }

    #[test]
    fn an_encode_plan_puts_nothing_but_audio_after_its_first_c_a() {
        // `force_video_encode` splits both arg vectors at the first `-c:a`
        // and treats the tail as the audio half. That is only sound while
        // every plan keeps its video and container flags ahead of that
        // marker — a convention no type enforces. A trailing
        // `-movflags +faststart`, say, would be silently reclassified as
        // audio and dropped whenever the source plan used a blanket
        // `-c copy` (whose tail is synthesised, not carried over).
        const AUDIO_FLAGS: &[&str] = &["-c:a", "-b:a", "-q:a", "-ar", "-ac", "-af"];
        for &target in ALL_TARGETS {
            for q in [
                None,
                Some(QualityPreset::Fast),
                Some(QualityPreset::Balanced),
                Some(QualityPreset::Small),
            ] {
                let Some(plan) = video_encode_plan(target, q) else {
                    continue;
                };
                let Some(i) = plan.args.iter().position(|x| x == "-c:a") else {
                    continue;
                };
                for flag in plan.args[i..].iter().filter(|x| x.starts_with('-')) {
                    assert!(
                        AUDIO_FLAGS.contains(&flag.as_str()),
                        "{target:?} {q:?}: {flag} sits after -c:a, where \
                         force_video_encode reads it as an audio arg: {:?}",
                        plan.args
                    );
                }
            }
        }
    }

    #[test]
    fn an_uncapped_plan_still_stream_copies() {
        // The mirror of the tests above: nothing in the cap handling may
        // cost the no-cap path its remux.
        for &(target, v, a) in REMUXING_SOURCES {
            let p = decide(target, v, a, None, Some(ResolutionCap::Original), None);
            assert!(
                copies_video(&p.args),
                "{target:?} {v:?}/{a:?} lost its remux: {:?}",
                p.args
            );
        }
    }

    // --- v0.1.6 compression tests ---

    #[test]
    fn slider_to_crf_endpoints_and_middle() {
        assert_eq!(slider_to_crf(100), 18);
        assert_eq!(slider_to_crf(1), 40);
        // Middle (slider 50) sits near CRF ~29 — within linear tolerance.
        let mid = slider_to_crf(50);
        assert!(
            (28..=30).contains(&mid),
            "expected ~29 at slider=50, got {mid}"
        );
    }

    #[test]
    fn slider_to_crf_clamps_out_of_range() {
        assert_eq!(slider_to_crf(0), 40);
        assert_eq!(slider_to_crf(200), 18);
    }

    #[test]
    fn slider_to_audio_kbps_covers_range() {
        assert_eq!(slider_to_audio_kbps(1, 48, 320), 48);
        assert_eq!(slider_to_audio_kbps(100, 48, 320), 320);
        let mid = slider_to_audio_kbps(50, 48, 320);
        assert!(
            (180..=200).contains(&mid),
            "expected ~190 at slider=50, got {mid}"
        );
    }

    #[test]
    fn target_bytes_to_audio_kbps_matches_formula() {
        // 3 MB over 2 minutes = 3*1024*1024 bytes over 120_000 ms
        //   = 3*1024*1024*8 bits / 120 s = ~209 kbps
        let kbps = target_bytes_to_audio_kbps(3 * 1024 * 1024, 120_000, 48, 320);
        assert!((200..=220).contains(&kbps), "got {kbps}");
    }

    #[test]
    fn target_bytes_to_audio_kbps_clamps_to_bounds() {
        // tiny target -> clamp up to minimum
        assert_eq!(target_bytes_to_audio_kbps(1000, 120_000, 48, 320), 48);
        // huge target -> clamp down to maximum
        assert_eq!(
            target_bytes_to_audio_kbps(u64::MAX / 100, 120_000, 48, 320),
            320
        );
    }

    #[test]
    fn target_bytes_to_audio_kbps_handles_zero_duration() {
        assert_eq!(target_bytes_to_audio_kbps(1_000_000, 0, 48, 320), 48);
    }

    #[test]
    fn target_bytes_to_video_kbps_reserves_audio_and_floors_video() {
        // Plenty of headroom: 50 MB over 60s -> total ~6990 kbps, video ~6862
        let (v, a) = target_bytes_to_video_kbps(50 * 1024 * 1024, 60_000);
        assert_eq!(a, 128);
        assert!(v > 6000, "video got {v}");

        // Tight budget: 500 KB over 60s -> total ~66 kbps, video floors to 100
        let (v, a) = target_bytes_to_video_kbps(500 * 1024, 60_000);
        assert_eq!(a, 128);
        assert_eq!(v, 100);
    }

    #[test]
    fn decide_compression_video_quality_uses_libx264() {
        let p = decide_compression(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            CompressMode::Quality(50),
            60_000,
        );
        assert!(p.reencoded);
        assert_eq!(p.ext, "mp4");
        assert!(p.args.iter().any(|a| a == "libx264"));
        assert!(p.args.iter().any(|a| a == "-crf"));
    }

    #[test]
    fn decide_compression_video_target_size_sets_bitrate() {
        let p = decide_compression(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            CompressMode::TargetSizeBytes(10 * 1024 * 1024),
            60_000,
        );
        assert!(p.reencoded);
        assert!(p.args.windows(2).any(|w| w[0] == "-b:v"));
        assert!(p.args.windows(2).any(|w| w[0] == "-maxrate"));
    }

    #[test]
    fn decide_compression_audio_quality_sets_bitrate() {
        let p = decide_compression(
            TargetFormat::Mp3,
            None,
            Some("mp3"),
            CompressMode::Quality(75),
            180_000,
        );
        assert!(p.reencoded);
        assert_eq!(p.ext, "mp3");
        assert!(p.args.iter().any(|a| a == "libmp3lame"));
        assert!(p.args.windows(2).any(|w| w[0] == "-b:a"));
    }

    #[test]
    fn decide_compression_audio_target_size_computes_kbps() {
        let p = decide_compression(
            TargetFormat::Mp3,
            None,
            Some("mp3"),
            CompressMode::TargetSizeBytes(2 * 1024 * 1024),
            180_000,
        );
        assert!(p.reencoded);
        let idx = p.args.iter().position(|a| a == "-b:a").unwrap();
        let bitrate = &p.args[idx + 1];
        assert!(bitrate.ends_with("k"));
    }

    #[test]
    fn decide_compression_mov_uses_mov_ext() {
        let p = decide_compression(
            TargetFormat::Mov,
            Some("h264"),
            Some("aac"),
            CompressMode::Quality(60),
            60_000,
        );
        assert_eq!(p.ext, "mov");
    }

    #[test]
    fn decide_compression_webm_uses_vp9() {
        let p = decide_compression(
            TargetFormat::Webm,
            Some("vp9"),
            Some("opus"),
            CompressMode::Quality(50),
            60_000,
        );
        assert!(p.args.iter().any(|a| a == "libvpx-vp9"));
        assert_eq!(p.ext, "webm");
    }

    #[test]
    fn decide_compression_image_targets_short_circuit() {
        for t in [
            TargetFormat::Png,
            TargetFormat::Jpeg,
            TargetFormat::Webp,
            TargetFormat::Bmp,
        ] {
            let p = decide_compression(t, None, None, CompressMode::Quality(50), 0);
            assert!(p.args.is_empty(), "expected empty plan for {t:?}");
            assert_eq!(p.ext, t.extension());
        }
    }

    #[test]
    fn decide_compression_opus_uses_libopus() {
        let p = decide_compression(
            TargetFormat::Opus,
            None,
            Some("opus"),
            CompressMode::Quality(50),
            120_000,
        );
        assert!(p.args.iter().any(|a| a == "libopus"));
        assert_eq!(p.ext, "opus");
    }

    #[test]
    fn decide_compression_ogg_uses_libvorbis() {
        let p = decide_compression(
            TargetFormat::Ogg,
            None,
            Some("vorbis"),
            CompressMode::Quality(50),
            120_000,
        );
        assert!(p.args.iter().any(|a| a == "libvorbis"));
    }

    // -----------------------------------------------------------------------
    // HW substitution
    // -----------------------------------------------------------------------

    #[test]
    fn substitute_replaces_libx264_with_videotoolbox() {
        let plan = decide(
            TargetFormat::Mp4,
            Some("vp9"),
            Some("opus"),
            Some(QualityPreset::Balanced),
            None,
            None,
        );
        assert!(plan.args.iter().any(|a| a == "libx264"));
        let out = substitute_h264_hw(
            &plan.args,
            "h264_videotoolbox",
            Some(QualityPreset::Balanced),
        )
        .expect("should substitute");
        assert!(out.iter().any(|a| a == "h264_videotoolbox"));
        assert!(!out.iter().any(|a| a == "libx264"));
        assert!(!out.iter().any(|a| a == "-preset"));
        assert!(!out.iter().any(|a| a == "-crf"));
        assert!(out.windows(2).any(|w| w[0] == "-q:v" && w[1] == "65"));
    }

    #[test]
    fn substitute_keeps_audio_args_intact() {
        let plan = decide(
            TargetFormat::Mp4,
            Some("vp9"),
            Some("opus"),
            Some(QualityPreset::Balanced),
            None,
            None,
        );
        let out = substitute_h264_hw(&plan.args, "h264_nvenc", Some(QualityPreset::Balanced))
            .expect("should substitute");
        // Audio block survives the rewrite.
        assert!(out.windows(2).any(|w| w[0] == "-c:a" && w[1] == "aac"));
        assert!(out.windows(2).any(|w| w[0] == "-b:a" && w[1] == "192k"));
    }

    #[test]
    fn substitute_returns_none_when_no_libx264() {
        let plan = decide(TargetFormat::Mp3, None, Some("aac"), None, None, None);
        assert!(substitute_h264_hw(&plan.args, "h264_videotoolbox", None).is_none());
    }

    #[test]
    fn maybe_apply_returns_none_when_no_hw_available() {
        let mut plan = decide(
            TargetFormat::Mp4,
            Some("vp9"),
            Some("opus"),
            Some(QualityPreset::Balanced),
            None,
            None,
        );
        let original_args = plan.args.clone();
        let used = maybe_apply_hw_h264(&mut plan, &DetectedEncoders::empty(), None);
        assert_eq!(used, None);
        assert_eq!(plan.args, original_args);
    }
}
