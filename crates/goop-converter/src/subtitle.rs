//! Subtitle handling for the ffmpeg backend.
//!
//! Three capabilities share this module:
//!
//! * **Soft-embed** — mux an external `.srt` / `.vtt` as a selectable track.
//!   Appends `-map` / `-c:s` args and asks the caller for a second `-i`.
//! * **Burn-in** — render the subtitles into the video frames via libass.
//!   Appends a `subtitles=` video filter; always re-encodes.
//! * **Extraction** — write a subtitle stream out as a standalone `.srt` /
//!   `.vtt`, which is also how srt↔vtt conversion works.
//!
//! `Plan` deliberately carries no filesystem paths (input and output are
//! passed to `run_ffmpeg` separately), so [`apply_to_plan`] *returns* the
//! path that needs a second `-i` rather than storing it on the plan.

use std::path::{Path, PathBuf};

use goop_core::{GoopError, SubtitleMode, TargetFormat};

use crate::compat::Plan;

/// The subtitle codec to transcode into when muxing a soft track, or
/// `None` for targets that can't carry a text subtitle stream.
///
/// MKV takes SubRip rather than WebVTT even from a `.vtt` source: WebVTT-in-
/// Matroska support is uneven across players, while SubRip is universal.
pub(crate) fn soft_codec(target: TargetFormat) -> Option<&'static str> {
    match target {
        TargetFormat::Mp4 | TargetFormat::Mov => Some("mov_text"),
        TargetFormat::Mkv => Some("srt"),
        TargetFormat::Webm => Some("webvtt"),
        _ => None,
    }
}

/// Whether `target` can accept a subtitle in `mode`.
///
/// Burn-in only needs a video stream to draw on, so it covers AVI too —
/// the one container here that has no usable text-subtitle track.
pub(crate) fn supports(target: TargetFormat, mode: SubtitleMode) -> bool {
    match mode {
        SubtitleMode::Soft => soft_codec(target).is_some(),
        SubtitleMode::BurnIn => matches!(
            target,
            TargetFormat::Mp4
                | TargetFormat::Mov
                | TargetFormat::Mkv
                | TargetFormat::Webm
                | TargetFormat::Avi
        ),
    }
}

/// Plan for writing a subtitle stream out on its own — the srt↔vtt
/// conversion path, and the extraction path for subs inside a container.
///
/// The `0:s:0` map is deliberately not optional (`0:s:0?`): a source with
/// no subtitle stream should fail loudly rather than produce an empty file.
pub(crate) fn plan_extract(target: TargetFormat) -> Plan {
    let codec = match target {
        TargetFormat::Vtt => "webvtt",
        // `srt` here is the encoder name; `subrip` is its codec alias.
        _ => "srt",
    };
    Plan {
        args: vec![
            "-map".to_string(),
            "0:s:0".to_string(),
            "-c:s".to_string(),
            codec.to_string(),
        ],
        video_filters: vec![],
        reencoded: true,
        ext: target.extension(),
    }
}

/// Subtitle codecs that carry text, and can therefore be transcoded into
/// any of the codecs in [`soft_codec`].
///
/// Bitmap subtitles (`hdmv_pgs_subtitle` from Blu-ray, `dvd_subtitle` from
/// DVD) are deliberately absent: ffmpeg can only convert text-to-text or
/// bitmap-to-bitmap, so asking it to turn one into `mov_text` aborts the
/// whole conversion.
const TEXT_SUBTITLE_CODECS: &[&str] = &[
    "subrip",
    "srt",
    "ass",
    "ssa",
    "mov_text",
    "webvtt",
    "text",
    "subviewer",
    "subviewer1",
    "mpl2",
    "microdvd",
    "sami",
    "realtext",
    "stl",
];

/// The `-sub_charenc` value ffmpeg needs in order to read `bytes` as text,
/// or `None` when it already reads them correctly.
///
/// ffmpeg assumes UTF-8 for text subtitles and *discards* every cue it
/// cannot decode, exiting 0 regardless — so a legacy-codepage file loses
/// exactly the lines that motivated its encoding, and reports success. It
/// only fails outright when no cue at all decodes. Guessing here is what
/// closes that hole.
///
/// `None` for valid UTF-8 keeps the overwhelmingly common path byte-for-byte
/// identical to not having this function at all.
pub(crate) fn detect_charenc(bytes: &[u8]) -> Option<&'static str> {
    if bytes.is_empty() || std::str::from_utf8(bytes).is_ok() {
        return None;
    }
    // ffmpeg detects UTF-16 from the BOM and converts it itself; its docs
    // say explicitly not to name an encoding in that case.
    //
    // The UTF-32 BOMs are listed too, not because ffmpeg handles them, but
    // because the detector has no UTF-32 candidate: left to guess it would
    // return a confident 8-bit codepage for text that is nothing of the
    // sort. Declining to guess fails visibly; guessing wrong does not.
    // Note UTF-32LE (`FF FE 00 00`) starts with the UTF-16LE BOM, so it is
    // already covered by the case above — listed here for the reader.
    const BOMS: [&[u8]; 4] = [
        &[0xFF, 0xFE],             // UTF-16LE (and UTF-32LE's prefix)
        &[0xFE, 0xFF],             // UTF-16BE
        &[0x00, 0x00, 0xFE, 0xFF], // UTF-32BE
        &[0xFF, 0xFE, 0x00, 0x00], // UTF-32LE
    ];
    if BOMS.iter().any(|bom| bytes.starts_with(bom)) {
        return None;
    }
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let guess = detector.guess(None, true);
    // Bytes that failed the UTF-8 check above cannot be UTF-8, so a UTF-8
    // guess means the detector had nothing to go on. Passing it would be a
    // no-op that only makes the command harder to read.
    (guess != encoding_rs::UTF_8).then(|| guess.name())
}

/// Anything larger than this is not a subtitle file, whatever its extension
/// claims. The largest real `.srt` is a few hundred kilobytes — a full
/// feature film's dialogue is well under one megabyte — so this is orders of
/// magnitude of headroom, and its job is only to stop a mis-picked video
/// file from being read into memory in full.
const MAX_SUBTITLE_BYTES: u64 = 32 * 1024 * 1024;

/// [`detect_charenc`] for a file on disk.
///
/// Reads the whole file rather than a prefix: subtitle files are kilobytes,
/// and a detector fed only the first block would miss a lone accented line
/// near the end — which is precisely the silent-loss case.
///
/// An unreadable or implausibly large file yields `None`, skipping detection
/// rather than guessing from a binary blob; the conversion then proceeds on
/// ffmpeg's own defaults instead of having a bogus encoding forced onto it.
pub(crate) fn detect_charenc_of_file(path: &Path) -> Option<String> {
    let too_big = std::fs::metadata(path)
        .map(|m| m.len() > MAX_SUBTITLE_BYTES)
        .unwrap_or(true);
    if too_big {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    detect_charenc(&bytes).map(str::to_string)
}

/// Whether `label` is safe to interpolate into a filtergraph unescaped.
///
/// Every encoding label in use is alphanumerics, hyphens and underscores
/// (`Shift_JIS` supplies the underscore), none of which mean anything to the
/// filtergraph parser. That is a property of the detector's current label
/// set, though, not a guarantee — so it is checked rather than trusted, and
/// a future label carrying a `:` or `,` drops detection instead of quietly
/// producing a malformed filter.
fn is_safe_filter_label(label: &str) -> bool {
    !label.is_empty()
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Subtitle codecs Matroska stores untouched.
///
/// Deliberately narrower than [`TEXT_SUBTITLE_CODECS`], which answers "can
/// ffmpeg transcode this into a text codec". This one answers "can it be
/// written into a `.mkv` as-is": `mov_text`, `microdvd` and the rest are
/// text but have no Matroska mapping, and asking for a copy aborts the mux
/// with "Subtitle codec … is not supported".
const MATROSKA_NATIVE_SUBTITLE_CODECS: &[&str] = &["subrip", "srt", "text", "ass", "ssa", "webvtt"];

/// Whether every existing subtitle stream can be carried into `target`.
///
/// Unknown codecs count as "not text": preserving them risks aborting the
/// conversion, while skipping them only costs a track the user didn't ask
/// about. The user's own attached subtitle is added either way.
pub(crate) fn can_preserve_existing(subtitle_codecs: &[String]) -> bool {
    !subtitle_codecs.is_empty()
        && subtitle_codecs
            .iter()
            .all(|c| TEXT_SUBTITLE_CODECS.contains(&c.as_str()))
}

/// Whether `plan` transcodes audio rather than stream-copying it.
///
/// A re-encoding plan rewrites *every* mapped audio stream into the one
/// codec it names, which is what makes carrying the source's secondary
/// tracks safe even when they started out in something exotic.
fn reencodes_audio(plan: &Plan) -> bool {
    plan.args
        .windows(2)
        .any(|w| w[0] == "-c:a" && w[1] != "copy")
}

/// Audio codecs `target` can stream-copy into a mapping that players other
/// than ffmpeg will recognise.
///
/// The entries are the codecs that land on a **dedicated, registered codec
/// tag** — `ac-3`, `ec-3`, `alac`, `fLaC`, `Opus`, `.mp3`, `dtsc`, `sowt` —
/// plus AAC and MP3, which are the canonical payloads of MP4's `mp4a` box.
///
/// What rules a codec *out* is the `mp4a` catch-all. Handed a codec it has
/// no mapping for, the MP4 muxer does not refuse: it writes the packets
/// under `mp4a` and records the real codec only in the ESDS descriptor.
/// ffmpeg reads that back and decodes the track perfectly, so a round-trip
/// through ffmpeg alone reports success — while every ordinary player sees
/// an AAC track full of something that is not AAC. Vorbis and DTS into MP4
/// both do this, and are absent here for that reason.
///
/// Measured against the bundled ffmpeg 7.0 by copying each codec into each
/// container and reading back the resulting `codec_tag_string`; a wrong
/// entry here fails silently, so nothing goes in on inference alone.
///
/// `None` means the target never takes a wide audio map: audio-only, image
/// and GIF targets hold exactly one audio stream by definition, and
/// Matroska is handled ahead of this list because it accepts anything.
fn copyable_audio_codecs(target: TargetFormat) -> Option<&'static [&'static str]> {
    match target {
        // flac -> fLaC and opus -> Opus are ISOBMFF-registered; both are
        // rejected outright by the MOV muxer, hence the two lists.
        TargetFormat::Mp4 => Some(&["aac", "mp3", "ac3", "eac3", "alac", "flac", "opus"]),
        // dts -> dtsc and pcm_s16le -> sowt are proper QuickTime tags. dts
        // is MOV-only because MP4 falls back to `mp4a` for it; pcm_s16le is
        // listed here but left off MP4's list conservatively — MP4 gives it
        // the registered `ipcm` tag and it does round-trip, so it could be
        // added, but nothing needed it and an untested entry on a list whose
        // whole job is preventing mis-tagged audio is not worth the trade.
        TargetFormat::Mov => Some(&["aac", "mp3", "ac3", "eac3", "alac", "dts", "pcm_s16le"]),
        // The muxer accepts nothing else — it aborts the job rather than
        // mis-tagging, but a job that fails is still worse than one that
        // quietly keeps the track it was always going to keep.
        TargetFormat::Webm => Some(&["opus", "vorbis"]),
        // mp3 (0x0055), ac3 (0x2000) and pcm_s16le (0x0001) are registered
        // `wFormatTag` values. aac (0x00ff) is not registered — it is a de
        // facto convention, understood by ffmpeg, VLC and mpv but not
        // guaranteed elsewhere. Kept because AVI is a legacy target where
        // AAC audio is common and the alternative is dropping the track.
        TargetFormat::Avi => Some(&["mp3", "ac3", "aac", "pcm_s16le"]),
        _ => None,
    }
}

/// Whether every one of `audio_codecs` survives a stream copy into `target`.
///
/// All-or-nothing, because the `-map` selector is: `0:a?` takes every audio
/// stream or none, so one unvettable track makes the wide map unsafe for
/// the whole file. An empty list fails closed for the same reason
/// [`can_preserve_existing`] does — nothing to vet means nothing to carry.
///
/// Answers `false` for Matroska, which has no list because it needs none.
/// Ask [`audio_map`] rather than this function directly: it settles the
/// containers that accept anything before the list is ever consulted.
fn all_audio_copyable(target: TargetFormat, audio_codecs: &[String]) -> bool {
    let Some(allowed) = copyable_audio_codecs(target) else {
        return false;
    };
    !audio_codecs.is_empty() && audio_codecs.iter().all(|c| allowed.contains(&c.as_str()))
}

/// The `-map` selector for the source's audio streams.
///
/// Explicit maps replace ffmpeg's automatic selection wholesale, and that
/// default keeps exactly one audio stream — so `0:a:0?` costs a
/// multi-language film every track but the first. Mapping all of them is
/// only safe when each one lands somewhere the container can describe:
///
/// * **Matroska** identifies codecs by CodecID string and accepts anything
///   ffmpeg can demux, so it always takes the wide map.
/// * **A re-encoding plan** rewrites every mapped stream into the one codec
///   it names, so what the source carried stops mattering.
/// * **Otherwise** each stream is vetted individually against
///   [`copyable_audio_codecs`]. Under a stream copy the plan itself was
///   chosen from the *first* audio stream alone — `ProbeResult::audio_codec`
///   is single-stream — so the rest need checking on their own account.
///
/// All three behaviours verified against the bundled ffmpeg 7.0.
fn audio_map(target: TargetFormat, plan: &Plan, audio_codecs: &[String]) -> &'static str {
    match target {
        TargetFormat::Mkv => "0:a?",
        _ if reencodes_audio(plan) => "0:a?",
        _ if all_audio_copyable(target, audio_codecs) => "0:a?",
        _ => "0:a:0?",
    }
}

/// Video containers that can hold more than one audio stream.
///
/// Audio-only, image and GIF targets carry exactly one by definition, and
/// giving them stream maps would override ffmpeg's selection to no purpose.
pub(crate) fn holds_multiple_audio_streams(target: TargetFormat) -> bool {
    matches!(
        target,
        TargetFormat::Mp4
            | TargetFormat::Mov
            | TargetFormat::Mkv
            | TargetFormat::Webm
            | TargetFormat::Avi
    )
}

/// Map the source's audio streams through when there is no subtitle work to
/// justify a map of its own.
///
/// Without this a source carrying several audio tracks and *no* subtitles
/// got no `-map` at all, leaving ffmpeg's automatic selection to thin it to
/// one track — silently, at exit 0. [`preserve_existing_in_plan`] covers
/// the same ground for sources that do have subtitles.
///
/// Returns whether any args were added; `false` leaves the plan untouched
/// so ffmpeg's defaults stay in place.
pub(crate) fn preserve_audio_in_plan(
    plan: &mut Plan,
    target: TargetFormat,
    audio_codecs: &[String],
) -> bool {
    // A single stream is exactly what automatic selection already keeps, so
    // maps would be noise — and noise that overrides ffmpeg's own pick of
    // the *best* stream rather than merely the first.
    if !holds_multiple_audio_streams(target) || audio_codecs.len() < 2 {
        return false;
    }
    if audio_map(target, plan, audio_codecs) != "0:a?" {
        return false;
    }
    plan.args.extend([
        "-map".to_string(),
        // Matches the automatic selection this replaces; `0:v?` would
        // additionally promote an attached cover image into a second,
        // re-encoded video track.
        "0:v:0?".to_string(),
        "-map".to_string(),
        "0:a?".to_string(),
    ]);
    true
}

/// The `-c:s` value for carrying the source's *own* subtitle streams into
/// `target`, or `None` when `target` holds no text subtitle at all.
///
/// Matroska gets `copy` whenever every source stream is one it stores
/// natively: rewriting an ASS track to SubRip would silently flatten its
/// styling, and there is nothing to gain by doing so. Every other container
/// (and any Matroska source carrying something exotic) is rewritten into
/// the container's single text codec.
pub(crate) fn preserve_codec(
    target: TargetFormat,
    source_codecs: &[String],
) -> Option<&'static str> {
    let codec = soft_codec(target)?;
    let all_native = source_codecs
        .iter()
        .all(|c| MATROSKA_NATIVE_SUBTITLE_CODECS.contains(&c.as_str()));
    if target == TargetFormat::Mkv && all_native {
        return Some("copy");
    }
    Some(codec)
}

/// Map the source's own streams through when nothing is being attached.
///
/// Without this ffmpeg falls back to automatic stream selection, which
/// keeps at most one subtitle stream — and none at all for MP4, whose
/// muxer has no default subtitle codec, so the tracks vanish and the job
/// still reports success.
///
/// Returns whether any args were added. Callers must have checked
/// [`can_preserve_existing`] first; targets that carry no text subtitle
/// (audio-only, GIF, images) and sources with no subtitle streams are
/// left untouched here as well, so no stream maps are invented for files
/// that don't need them.
pub(crate) fn preserve_existing_in_plan(
    plan: &mut Plan,
    target: TargetFormat,
    source_codecs: &[String],
    audio_codecs: &[String],
) -> bool {
    if source_codecs.is_empty() {
        return false;
    }
    // The abort this whole gate exists to prevent. Cheap insurance against a
    // future caller dropping the `can_preserve_existing` check upstream.
    debug_assert!(
        can_preserve_existing(source_codecs),
        "preserving {source_codecs:?} would force a bitmap subtitle into a text \
         codec and abort the mux"
    );
    let Some(codec) = preserve_codec(target, source_codecs) else {
        return false;
    };
    let audio = audio_map(target, plan, audio_codecs);
    plan.args.extend([
        "-map".to_string(),
        // Only the first video stream, matching the automatic selection
        // this replaces. `0:v?` would additionally promote an attached
        // cover image into a second, re-encoded video track.
        "0:v:0?".to_string(),
        "-map".to_string(),
        audio.to_string(),
        "-map".to_string(),
        "0:s?".to_string(),
        "-c:s".to_string(),
        codec.to_string(),
    ]);
    true
}

/// Attach `sub_path` to `plan` according to `mode`.
///
/// `preserve_existing` maps the source's own subtitle streams through
/// alongside the new one; see [`can_preserve_existing`] for when that is
/// safe. It is ignored for burn-in, which adds no stream maps at all.
///
/// `charenc` is the source's character encoding, from [`detect_charenc`].
/// Burn-in consumes it here, on the filter, because the file is read through
/// the filtergraph where `-sub_charenc` never reaches it; soft-embed leaves
/// it for the caller to pass as an input option instead.
///
/// Returns the path ffmpeg must open as a **second input** (`-i`), which is
/// `Some` for soft-embed and `None` for burn-in — burn-in reads the file
/// through the filter graph instead.
pub(crate) fn apply_to_plan(
    plan: &mut Plan,
    target: TargetFormat,
    mode: SubtitleMode,
    sub_path: &Path,
    preserve_existing: bool,
    charenc: Option<&str>,
    audio_codecs: &[String],
) -> Result<Option<PathBuf>, GoopError> {
    if !supports(target, mode) {
        let what = match mode {
            SubtitleMode::Soft => "a subtitle track",
            SubtitleMode::BurnIn => "burned-in subtitles",
        };
        return Err(GoopError::InvalidRequest(format!(
            "{} output can't carry {what}",
            target.extension()
        )));
    }

    match mode {
        SubtitleMode::Soft => {
            let codec = soft_codec(target).expect("supports() checked this target has a codec");
            // Explicit maps: the first video stream and *every* audio
            // stream from input 0, plus the subtitle from input 1. The `?`
            // suffixes keep a video-only or silent source working. Without
            // explicit maps ffmpeg's default stream selection ignores the
            // second input entirely.
            //
            // See [`audio_map`] for why the audio selector is not narrowed
            // to `0:a:0?` the way the video one is: attaching a subtitle
            // must not cost a film its other language tracks.
            let audio = audio_map(target, plan, audio_codecs);
            plan.args.extend([
                "-map".to_string(),
                "0:v:0?".to_string(),
                "-map".to_string(),
                audio.to_string(),
            ]);
            // Because the maps above are exhaustive, subtitle streams the
            // source already had are dropped unless they are named too.
            if preserve_existing {
                plan.args.extend(["-map".to_string(), "0:s?".to_string()]);
            }
            plan.args.extend([
                "-map".to_string(),
                "1:0".to_string(),
                "-c:s".to_string(),
                codec.to_string(),
            ]);
            Ok(Some(sub_path.to_path_buf()))
        }
        SubtitleMode::BurnIn => {
            if !plan.reencoded {
                // Unreachable via `build_plan`, which coerces the quality
                // preset so burn-in always lands on an encoding plan. Kept
                // as a guard so a future caller can't silently drop the
                // subtitles by handing over a stream-copy plan.
                return Err(GoopError::InvalidRequest(
                    "burning in subtitles requires re-encoding the video".to_string(),
                ));
            }
            // Appended last so it runs *after* any resolution cap: drawing
            // at the final size keeps the text crisp instead of scaling
            // already-rendered glyphs.
            //
            let charenc = charenc
                .filter(|enc| is_safe_filter_label(enc))
                .map(|enc| format!(":charenc={enc}"))
                .unwrap_or_default();
            plan.video_filters.push(format!(
                "subtitles=filename={}{charenc}",
                escape_subtitles_path(&sub_path.to_string_lossy())
            ));
            Ok(None)
        }
    }
}

/// Escape a path for the `filename` option of the `subtitles` filter.
///
/// The value is unescaped twice on the way in — once by the filtergraph
/// parser and once by the AVOption parser — so every metacharacter needs
/// two rounds of escaping.
///
/// Args are passed to ffmpeg via `Command::arg`, never a shell, so no
/// third (shell) round applies.
pub(crate) fn escape_subtitles_path(path: &str) -> String {
    escape_for_filter(path, cfg!(windows))
}

/// `windows_paths` decides whether a backslash means "directory separator"
/// (Windows, where it is rewritten to `/` because Win32 accepts either, so
/// only the drive-letter colon needs escaping: `C:\x\y.srt` becomes
/// `C\\:/x/y.srt`) or an ordinary filename character (everywhere else,
/// where rewriting it would point ffmpeg at a different file).
///
/// Split out from `escape_subtitles_path` so the Windows behaviour stays
/// under test on every host.
fn escape_for_filter(path: &str, windows_paths: bool) -> String {
    let normalized = if windows_paths {
        path.replace('\\', "/")
    } else {
        path.to_string()
    };
    // Backslash first in each layer, so the escapes added after it aren't
    // escaped a second time.
    let layer1 = normalized
        .replace('\\', r"\\")
        .replace('\'', r"\'")
        .replace(':', r"\:");
    let mut layer2 = layer1.replace('\\', r"\\").replace('\'', r"\'");
    for ch in ['[', ']', ',', ';'] {
        layer2 = layer2.replace(ch, &format!("\\{ch}"));
    }
    layer2
}

#[cfg(test)]
mod tests {
    use super::*;
    use goop_core::{QualityPreset, ResolutionCap};

    // --- Character encoding detection ---------------------------------
    //
    // ffmpeg assumes UTF-8 for text subtitles and *discards* every cue it
    // can't decode, exiting 0 all the same. A 20-cue cp1252 file with one
    // accented cue therefore yields 19 cues and a success report. Only a
    // file where every cue fails decoding errors out. So detection has to
    // happen for us, not for ffmpeg.

    #[test]
    fn valid_utf8_needs_no_charenc() {
        // Plain ASCII, accented UTF-8, and CJK are all already what ffmpeg
        // expects; naming an encoding could only make things worse.
        assert_eq!(
            detect_charenc(b"1\n00:00:01,000 --> 00:00:02,000\nhi\n"),
            None
        );
        assert_eq!(detect_charenc("Café déjà vu".as_bytes()), None);
        assert_eq!(detect_charenc("你好世界 こんにちは".as_bytes()), None);
    }

    #[test]
    fn utf8_bom_needs_no_charenc() {
        // A BOM is valid UTF-8 and ffmpeg consumes it without leaking a
        // glyph into the first cue; verified against the bundled binary.
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("Café".as_bytes());
        assert_eq!(detect_charenc(&bytes), None);
    }

    #[test]
    fn windows_1252_is_detected() {
        // 0xE9 0xE0 0xE7 = e-acute, a-grave, c-cedilla in cp1252, and are
        // not valid UTF-8 in this arrangement.
        let bytes = b"Caf\xE9 \xE0 c\xF4t\xE9 de l'h\xF4tel. Elodie a d\xE9j\xE0 mang\xE9.";
        assert_eq!(detect_charenc(bytes), Some("windows-1252"));
    }

    #[test]
    fn cp1251_cyrillic_is_detected() {
        // "Привет, мир! Это проверка кодировки." in cp1251.
        let bytes = b"\xCF\xF0\xE8\xE2\xE5\xF2, \xEC\xE8\xF0! \xDD\xF2\xEE \
                      \xEF\xF0\xEE\xE2\xE5\xF0\xEA\xE0 \xEA\xEE\xE4\xE8\xF0\xEE\xE2\xEA\xE8.";
        assert_eq!(detect_charenc(bytes), Some("windows-1251"));
    }

    #[test]
    fn utf16_is_left_for_ffmpeg_to_autodetect() {
        // ffmpeg detects UTF-16 from the BOM and converts it itself; its
        // docs say explicitly not to pass an encoding for it.
        let le = [0xFF, 0xFE, b'h', 0x00, b'i', 0x00];
        let be = [0xFE, 0xFF, 0x00, b'h', 0x00, b'i'];
        assert_eq!(detect_charenc(&le), None);
        assert_eq!(detect_charenc(&be), None);
    }

    #[test]
    fn empty_input_needs_no_charenc() {
        assert_eq!(detect_charenc(b""), None);
    }

    #[test]
    fn utf32_is_not_guessed_at() {
        // The detector has no UTF-32 candidate, so an unguarded guess would
        // confidently return an 8-bit codepage for text that is nothing of
        // the sort — and force it on.
        let be = [0x00, 0x00, 0xFE, 0xFF, 0x00, 0x00, 0x00, b'h'];
        let le = [0xFF, 0xFE, 0x00, 0x00, b'h', 0x00, 0x00, 0x00];
        assert_eq!(detect_charenc(&be), None);
        assert_eq!(detect_charenc(&le), None);
    }

    #[test]
    fn an_oversized_file_is_not_sniffed() {
        // Guards the case where a video file reaches detection: reading it
        // whole to guess a charset would be both pointless and expensive.
        let path = std::env::temp_dir().join(format!("goop-charenc-big-{}", std::process::id()));
        std::fs::write(&path, vec![0xE9u8; (MAX_SUBTITLE_BYTES + 1) as usize]).unwrap();
        assert_eq!(detect_charenc_of_file(&path), None);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn only_filtergraph_safe_labels_reach_the_filter() {
        assert!(is_safe_filter_label("windows-1252"));
        assert!(is_safe_filter_label("Shift_JIS"));
        // A label carrying a filtergraph metacharacter must be dropped
        // rather than interpolated into a malformed filter.
        for bad in ["utf:8", "a,b", "x'y", "", "a\\b", "a[b]"] {
            assert!(!is_safe_filter_label(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn burn_in_carries_the_detected_charenc_into_the_filter() {
        // Burn-in reads the file through the filtergraph, so -sub_charenc
        // never reaches it; the option has to ride on the filter instead.
        let mut plan = burnable_plan();
        apply_to_plan(
            &mut plan,
            TargetFormat::Mp4,
            SubtitleMode::BurnIn,
            Path::new("/tmp/sub.srt"),
            false,
            Some("windows-1252"),
            &[],
        )
        .unwrap();
        let filter = plan
            .video_filters
            .iter()
            .find(|f| f.starts_with("subtitles="))
            .expect("burn-in must add a subtitles filter");
        assert!(
            filter.contains("charenc=windows-1252"),
            "filter lacks the charenc: {filter}"
        );
    }

    #[test]
    fn burn_in_omits_charenc_for_utf8() {
        let mut plan = burnable_plan();
        apply_to_plan(
            &mut plan,
            TargetFormat::Mp4,
            SubtitleMode::BurnIn,
            Path::new("/tmp/sub.srt"),
            false,
            None,
            &[],
        )
        .unwrap();
        let filter = plan
            .video_filters
            .iter()
            .find(|f| f.starts_with("subtitles="))
            .unwrap();
        assert!(!filter.contains("charenc"), "unexpected charenc: {filter}");
    }

    fn burnable_plan() -> Plan {
        crate::compat::decide(
            TargetFormat::Mp4,
            Some("hevc"),
            Some("aac"),
            Some(QualityPreset::Balanced),
            None,
            None,
        )
    }

    // --- Escaping -----------------------------------------------------
    //
    // The expectations below were verified against the bundled ffmpeg by
    // burning each path in for real; the nasty-path case is the one that
    // rules out single-round escaping.

    #[test]
    fn escapes_windows_drive_colon_and_backslashes() {
        // Pinned with an explicit flag rather than `escape_subtitles_path`
        // so the Windows behaviour is covered when CI runs on macOS.
        assert_eq!(
            escape_for_filter(r"C:\Users\thor\my subs.srt", true),
            r"C\\:/Users/thor/my subs.srt"
        );
    }

    #[test]
    fn keeps_a_literal_backslash_off_windows() {
        // A backslash is a legal filename character on macOS/Linux, so
        // rewriting it to `/` would point ffmpeg at a different file.
        // It still needs escaping for both parser layers.
        assert_eq!(
            escape_for_filter(r"/tmp/a\b.srt", false),
            r"/tmp/a\\\\b.srt"
        );
    }

    #[test]
    fn leaves_plain_posix_paths_alone() {
        assert_eq!(
            escape_subtitles_path("/Users/thor/my subs.srt"),
            "/Users/thor/my subs.srt"
        );
    }

    #[test]
    fn escapes_filtergraph_metacharacters() {
        assert_eq!(
            escape_subtitles_path("/tmp/a,b[1];c.srt"),
            r"/tmp/a\,b\[1\]\;c.srt"
        );
    }

    #[test]
    fn escapes_apostrophes_for_both_parser_layers() {
        assert_eq!(escape_subtitles_path("/tmp/it's.srt"), r"/tmp/it\\\'s.srt");
    }

    // --- Support matrix -----------------------------------------------

    #[test]
    fn soft_codec_per_container() {
        assert_eq!(soft_codec(TargetFormat::Mp4), Some("mov_text"));
        assert_eq!(soft_codec(TargetFormat::Mov), Some("mov_text"));
        assert_eq!(soft_codec(TargetFormat::Mkv), Some("srt"));
        assert_eq!(soft_codec(TargetFormat::Webm), Some("webvtt"));
        assert_eq!(soft_codec(TargetFormat::Avi), None);
        assert_eq!(soft_codec(TargetFormat::Gif), None);
        assert_eq!(soft_codec(TargetFormat::Mp3), None);
        assert_eq!(soft_codec(TargetFormat::Png), None);
    }

    #[test]
    fn avi_takes_burn_in_but_not_a_soft_track() {
        assert!(!supports(TargetFormat::Avi, SubtitleMode::Soft));
        assert!(supports(TargetFormat::Avi, SubtitleMode::BurnIn));
    }

    #[test]
    fn audio_and_image_targets_take_no_subtitles_at_all() {
        for t in [
            TargetFormat::Mp3,
            TargetFormat::Flac,
            TargetFormat::Png,
            TargetFormat::Jpeg,
            TargetFormat::Gif,
        ] {
            assert!(!supports(t, SubtitleMode::Soft), "{t:?} soft");
            assert!(!supports(t, SubtitleMode::BurnIn), "{t:?} burn");
        }
    }

    // --- Soft embed ----------------------------------------------------

    #[test]
    fn soft_embed_maps_streams_and_keeps_the_remux_fast_path() {
        let mut plan = crate::compat::decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        assert!(!plan.reencoded, "precondition: this is a remux plan");

        let extra = apply_to_plan(
            &mut plan,
            TargetFormat::Mp4,
            SubtitleMode::Soft,
            Path::new("/tmp/s.srt"),
            false,
            None,
            &[],
        )
        .unwrap();

        assert_eq!(extra, Some(PathBuf::from("/tmp/s.srt")));
        assert_eq!(
            plan.args,
            vec![
                "-c", "copy", "-map", "0:v:0?", "-map", "0:a:0?", "-map", "1:0", "-c:s",
                "mov_text",
            ]
        );
        // Muxing a text track must not cost a full re-encode.
        assert!(!plan.reencoded);
    }

    #[test]
    fn soft_embed_uses_the_target_container_codec() {
        for (target, codec) in [
            (TargetFormat::Mkv, "srt"),
            (TargetFormat::Webm, "webvtt"),
            (TargetFormat::Mov, "mov_text"),
        ] {
            let mut plan =
                crate::compat::decide(target, Some("h264"), Some("aac"), None, None, None);
            apply_to_plan(
                &mut plan,
                target,
                SubtitleMode::Soft,
                Path::new("/tmp/s.srt"),
                false,
                None,
                &[],
            )
            .unwrap();
            let idx = plan.args.iter().position(|a| a == "-c:s").unwrap();
            assert_eq!(plan.args[idx + 1], codec, "{target:?}");
        }
    }

    #[test]
    fn soft_embed_rejects_targets_without_a_subtitle_track() {
        for target in [TargetFormat::Avi, TargetFormat::Mp3, TargetFormat::Gif] {
            let mut plan =
                crate::compat::decide(target, Some("h264"), Some("aac"), None, None, None);
            let err = apply_to_plan(
                &mut plan,
                target,
                SubtitleMode::Soft,
                Path::new("/tmp/s.srt"),
                false,
                None,
                &[],
            )
            .unwrap_err();
            assert!(
                matches!(err, GoopError::InvalidRequest(_)),
                "{target:?} should be rejected, got {err:?}"
            );
        }
    }

    // --- Burn-in -------------------------------------------------------

    #[test]
    fn burn_in_appends_the_filter_and_adds_no_second_input() {
        let mut plan = burnable_plan();
        let extra = apply_to_plan(
            &mut plan,
            TargetFormat::Mp4,
            SubtitleMode::BurnIn,
            Path::new("/tmp/s.srt"),
            false,
            None,
            &[],
        )
        .unwrap();

        assert_eq!(extra, None, "burn-in reads the file through the filter");
        assert_eq!(
            plan.video_filters,
            vec!["subtitles=filename=/tmp/s.srt".to_string()]
        );
    }

    #[test]
    fn burn_in_filter_runs_after_the_resolution_cap() {
        // Order matters: scaling first and drawing second renders the text
        // at final resolution instead of blurring pre-scaled glyphs.
        let mut plan = crate::compat::decide(
            TargetFormat::Mp4,
            Some("hevc"),
            Some("aac"),
            Some(QualityPreset::Balanced),
            Some(ResolutionCap::R720p),
            None,
        );
        apply_to_plan(
            &mut plan,
            TargetFormat::Mp4,
            SubtitleMode::BurnIn,
            Path::new("/tmp/s.srt"),
            false,
            None,
            &[],
        )
        .unwrap();

        assert_eq!(
            plan.video_filters,
            vec![
                "scale=1280:-2".to_string(),
                "subtitles=filename=/tmp/s.srt".to_string(),
            ]
        );
    }

    #[test]
    fn burn_in_refuses_a_stream_copy_plan() {
        // A remux would drop the subtitles silently; fail instead.
        let mut plan = crate::compat::decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        assert!(!plan.reencoded);
        let err = apply_to_plan(
            &mut plan,
            TargetFormat::Mp4,
            SubtitleMode::BurnIn,
            Path::new("/tmp/s.srt"),
            false,
            None,
            &[],
        )
        .unwrap_err();
        assert!(matches!(err, GoopError::InvalidRequest(_)));
    }

    #[test]
    fn burn_in_rejects_targets_with_no_video() {
        for target in [TargetFormat::Mp3, TargetFormat::Png] {
            let mut plan = burnable_plan();
            let err = apply_to_plan(
                &mut plan,
                target,
                SubtitleMode::BurnIn,
                Path::new("/tmp/s.srt"),
                false,
                None,
                &[],
            )
            .unwrap_err();
            assert!(matches!(err, GoopError::InvalidRequest(_)), "{target:?}");
        }
    }

    // --- Preserving the source's own subtitle tracks --------------------

    #[test]
    fn text_subtitle_streams_are_safe_to_preserve() {
        assert!(can_preserve_existing(&["subrip".to_string()]));
        assert!(can_preserve_existing(&[
            "subrip".to_string(),
            "ass".to_string()
        ]));
    }

    #[test]
    fn bitmap_and_unknown_subtitle_streams_are_not_preserved() {
        // Transcoding a bitmap subtitle into mov_text/srt/webvtt aborts the
        // whole conversion, so these must be left behind instead.
        assert!(!can_preserve_existing(&["hdmv_pgs_subtitle".to_string()]));
        assert!(!can_preserve_existing(&["dvd_subtitle".to_string()]));
        // Mixed: one bitmap track is enough to make the whole map unsafe.
        assert!(!can_preserve_existing(&[
            "subrip".to_string(),
            "hdmv_pgs_subtitle".to_string()
        ]));
        // Unknown codecs fail closed.
        assert!(!can_preserve_existing(&["something_new".to_string()]));
        assert!(!can_preserve_existing(&[]));
    }

    #[test]
    fn soft_embed_carries_existing_text_tracks_through() {
        // Regression: the explicit maps are exhaustive, so without an
        // explicit `0:s?` the source's own subtitle tracks are dropped the
        // moment the user attaches an external one.
        let mut plan = crate::compat::decide(
            TargetFormat::Mkv,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        apply_to_plan(
            &mut plan,
            TargetFormat::Mkv,
            SubtitleMode::Soft,
            Path::new("/tmp/s.srt"),
            true,
            None,
            &[],
        )
        .unwrap();

        assert_eq!(
            plan.args,
            vec![
                "-c", "copy", "-map", "0:v:0?", "-map", "0:a?", "-map", "0:s?", "-map", "1:0",
                "-c:s", "srt",
            ]
        );
    }

    #[test]
    fn attaching_a_subtitle_keeps_every_audio_stream_it_safely_can() {
        // Regression: `0:a:0?` silently discarded the commentary and
        // second-language tracks of anything with more than one. Matroska
        // can hold them whatever they are, so it gets the wide map even on
        // the stream-copy fast path.
        let mut plan = crate::compat::decide(
            TargetFormat::Mkv,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        apply_to_plan(
            &mut plan,
            TargetFormat::Mkv,
            SubtitleMode::Soft,
            Path::new("/tmp/s.srt"),
            false,
            None,
            &[],
        )
        .unwrap();

        assert!(plan.args.iter().any(|a| a == "0:a?"));
        assert!(!plan.args.iter().any(|a| a == "0:a:0?"));
    }

    #[test]
    fn matroska_always_takes_every_audio_stream() {
        // Matroska identifies codecs by CodecID string, so a secondary
        // track needs no vetting no matter how the plan handles audio.
        let copy = crate::compat::decide(
            TargetFormat::Mkv,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        assert_eq!(audio_map(TargetFormat::Mkv, &copy, &[]), "0:a?");
    }

    #[test]
    fn a_stream_copy_into_mp4_or_webm_keeps_only_the_first_audio_stream() {
        // The plan's copy-eligibility was decided from the *first* audio
        // stream alone, so a secondary track is unvetted. WebM aborts on
        // one; MP4/MOV silently box Vorbis under the `mp4a` (AAC) FourCC
        // and still report success. Dropping it beats corrupting it.
        // Source codecs are chosen per target so each lands on its own
        // stream-copy fast path rather than an encoding plan.
        for (t, vcodec, acodec) in [
            (TargetFormat::Mp4, "h264", "aac"),
            (TargetFormat::Mov, "h264", "aac"),
            (TargetFormat::Webm, "vp9", "opus"),
        ] {
            let mut plan = crate::compat::decide(t, Some(vcodec), Some(acodec), None, None, None);
            assert!(
                !reencodes_audio(&plan),
                "precondition: {t:?} should be a copy plan"
            );
            assert_eq!(audio_map(t, &plan, &[]), "0:a:0?", "{t:?}");

            // ...but once audio is transcoded, every mapped stream lands in
            // one known-good codec, so the wide map becomes safe.
            plan.args.extend(["-c:a".to_string(), "aac".to_string()]);
            assert_eq!(audio_map(t, &plan, &[]), "0:a?", "{t:?} re-encoding");
        }
    }

    #[test]
    fn an_explicit_audio_copy_is_not_mistaken_for_a_re_encode() {
        let mut plan = crate::compat::decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        plan.args.extend(["-c:a".to_string(), "copy".to_string()]);
        assert!(!reencodes_audio(&plan));
        assert_eq!(audio_map(TargetFormat::Mp4, &plan, &[]), "0:a:0?");
    }

    #[test]
    fn preserving_into_webm_narrows_the_audio_map_on_a_copy_plan() {
        // Guards the wiring between `preserve_existing_in_plan` and
        // `audio_map`: WebM is the target where getting this wrong aborts
        // the mux outright rather than merely corrupting a track.
        let mut plan = crate::compat::decide(
            TargetFormat::Webm,
            Some("vp9"),
            Some("opus"),
            None,
            None,
            None,
        );
        assert!(!plan.reencoded, "precondition: this is a remux plan");
        assert!(preserve_existing_in_plan(
            &mut plan,
            TargetFormat::Webm,
            &["subrip".to_string()],
            &[],
        ));

        assert!(plan.args.iter().any(|a| a == "0:a:0?"));
        assert!(!plan.args.iter().any(|a| a == "0:a?"));
    }

    // --- Preserving with nothing attached -------------------------------

    #[test]
    fn preserving_maps_video_audio_and_subtitles_with_a_container_codec() {
        let mut plan = crate::compat::decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        assert!(preserve_existing_in_plan(
            &mut plan,
            TargetFormat::Mp4,
            &["subrip".to_string(), "subrip".to_string()],
            &[],
        ));

        assert_eq!(
            plan.args,
            vec![
                "-c", "copy", "-map", "0:v:0?", "-map", "0:a:0?", "-map", "0:s?", "-c:s",
                "mov_text",
            ],
            "an MP4 stream copy keeps only the vetted first audio stream"
        );
        // Carrying tracks the source already had must not force an encode.
        assert!(!plan.reencoded);
    }

    #[test]
    fn preserving_copies_matroska_native_codecs_instead_of_flattening_them() {
        // Rewriting ASS to SubRip would silently drop its styling, and
        // Matroska stores ASS as-is, so there is nothing to gain by it.
        assert_eq!(
            preserve_codec(TargetFormat::Mkv, &["ass".to_string()]),
            Some("copy")
        );
        assert_eq!(
            preserve_codec(
                TargetFormat::Mkv,
                &["subrip".to_string(), "ass".to_string()]
            ),
            Some("copy")
        );
        // mov_text is text, but Matroska has no mapping for it — a copy
        // aborts the mux, so it has to be rewritten.
        assert_eq!(
            preserve_codec(TargetFormat::Mkv, &["mov_text".to_string()]),
            Some("srt")
        );
        // Other containers always rewrite into their one text codec.
        assert_eq!(
            preserve_codec(TargetFormat::Mp4, &["ass".to_string()]),
            Some("mov_text")
        );
        assert_eq!(
            preserve_codec(TargetFormat::Webm, &["subrip".to_string()]),
            Some("webvtt")
        );
    }

    #[test]
    fn preserving_leaves_targets_that_carry_no_subtitle_alone() {
        // Audio-only, GIF and image targets must gain no stream maps at
        // all — mapping `0:v:0?` into an MP3 would be nonsense.
        for t in [
            TargetFormat::Mp3,
            TargetFormat::Wav,
            TargetFormat::Flac,
            TargetFormat::Gif,
            TargetFormat::Avi,
            TargetFormat::Png,
        ] {
            let mut plan = crate::compat::decide(t, Some("h264"), Some("aac"), None, None, None);
            let before = plan.args.clone();
            assert!(
                !preserve_existing_in_plan(&mut plan, t, &["subrip".to_string()], &[]),
                "{t:?}"
            );
            assert_eq!(plan.args, before, "{t:?}");
        }
    }

    #[test]
    fn preserving_adds_nothing_when_the_source_has_no_subtitles() {
        // A file with no subtitle streams must not gain stream maps, which
        // would needlessly override ffmpeg's automatic selection.
        let mut plan = crate::compat::decide(
            TargetFormat::Mkv,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        assert!(!preserve_existing_in_plan(
            &mut plan,
            TargetFormat::Mkv,
            &[],
            &[],
        ));
        assert_eq!(plan.args, vec!["-c", "copy"]);
    }

    #[test]
    fn soft_embed_omits_existing_tracks_when_they_cannot_be_transcoded() {
        let mut plan = crate::compat::decide(
            TargetFormat::Mkv,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        apply_to_plan(
            &mut plan,
            TargetFormat::Mkv,
            SubtitleMode::Soft,
            Path::new("/tmp/s.srt"),
            false,
            None,
            &[],
        )
        .unwrap();

        assert!(!plan.args.iter().any(|a| a == "0:s?"));
    }

    // --- Per-container audio copy vetting -------------------------------
    //
    // The entries these assert on were measured against the bundled ffmpeg
    // 7.0 by copying each codec into each container and reading back the
    // resulting `codec_tag_string`. A wrong entry fails silently — the
    // track arrives mis-tagged at exit 0 — so they are pinned here and
    // covered end to end in `tests/subtitle_ffmpeg.rs`.

    #[test]
    fn a_copy_into_mp4_widens_only_for_codecs_mp4_can_name() {
        let copy = crate::compat::decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        assert!(!reencodes_audio(&copy), "precondition: a copy plan");

        for good in [["aac", "ac3"], ["aac", "eac3"], ["aac", "alac"]] {
            let codecs: Vec<String> = good.iter().map(|c| c.to_string()).collect();
            assert_eq!(
                audio_map(TargetFormat::Mp4, &copy, &codecs),
                "0:a?",
                "{good:?} all map to a registered tag"
            );
        }
        // Vorbis and DTS both fall back to the `mp4a` catch-all in MP4,
        // which lies about the track's contents rather than refusing it.
        for bad in [["aac", "vorbis"], ["aac", "dts"], ["aac", "wmav2"]] {
            let codecs: Vec<String> = bad.iter().map(|c| c.to_string()).collect();
            assert_eq!(
                audio_map(TargetFormat::Mp4, &copy, &codecs),
                "0:a:0?",
                "{bad:?} must narrow"
            );
        }
    }

    #[test]
    fn mov_and_mp4_do_not_share_an_allowlist() {
        // The same codec is registered in one and a catch-all in the other,
        // so a single shared list would be wrong in both directions.
        let mov = copyable_audio_codecs(TargetFormat::Mov).unwrap();
        let mp4 = copyable_audio_codecs(TargetFormat::Mp4).unwrap();
        // dts -> dtsc in MOV, but -> mp4a in MP4.
        assert!(mov.contains(&"dts"));
        assert!(!mp4.contains(&"dts"));
        // flac -> fLaC in MP4, but the MOV muxer rejects it outright.
        assert!(mp4.contains(&"flac"));
        assert!(!mov.contains(&"flac"));
    }

    #[test]
    fn webm_widens_only_for_the_two_codecs_it_accepts() {
        let copy = crate::compat::decide(
            TargetFormat::Webm,
            Some("vp9"),
            Some("opus"),
            None,
            None,
            None,
        );
        let ok: Vec<String> = ["opus", "vorbis"].iter().map(|c| c.to_string()).collect();
        assert_eq!(audio_map(TargetFormat::Webm, &copy, &ok), "0:a?");
        // Anything else aborts the mux, which is louder than a lost track
        // but still a job the user expected to succeed.
        let bad: Vec<String> = ["opus", "aac"].iter().map(|c| c.to_string()).collect();
        assert_eq!(audio_map(TargetFormat::Webm, &copy, &bad), "0:a:0?");
    }

    #[test]
    fn one_unvettable_track_narrows_the_whole_map() {
        // `0:a?` is all-or-nothing, so a single bad stream spoils it.
        let copy = crate::compat::decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        let codecs: Vec<String> = ["aac", "aac", "aac", "vorbis"]
            .iter()
            .map(|c| c.to_string())
            .collect();
        assert_eq!(audio_map(TargetFormat::Mp4, &copy, &codecs), "0:a:0?");
    }

    #[test]
    fn an_unknown_audio_codec_fails_closed() {
        let copy = crate::compat::decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        assert!(!all_audio_copyable(
            TargetFormat::Mp4,
            &["something_new".to_string()]
        ));
        assert_eq!(
            audio_map(TargetFormat::Mp4, &copy, &["something_new".to_string()]),
            "0:a:0?"
        );
        // Nothing to vet is not the same as everything vetting clean.
        assert!(!all_audio_copyable(TargetFormat::Mp4, &[]));
    }

    #[test]
    fn matroska_needs_no_allowlist() {
        // It accepts anything ffmpeg can demux, so it is answered before
        // the list is ever consulted.
        assert!(copyable_audio_codecs(TargetFormat::Mkv).is_none());
        let copy = crate::compat::decide(
            TargetFormat::Mkv,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        assert_eq!(
            audio_map(TargetFormat::Mkv, &copy, &["wmav2".to_string()]),
            "0:a?"
        );
    }

    #[test]
    fn re_encoding_outranks_the_allowlist() {
        // Every mapped stream lands in the codec the plan names, so what
        // the source carried stops mattering.
        let mut plan = crate::compat::decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        plan.args.extend(["-c:a".to_string(), "aac".to_string()]);
        assert_eq!(
            audio_map(TargetFormat::Mp4, &plan, &["vorbis".to_string()]),
            "0:a?"
        );
    }

    // --- preserve_audio_in_plan ------------------------------------------

    #[test]
    fn preserving_audio_maps_video_and_every_stream() {
        let mut plan = crate::compat::decide(
            TargetFormat::Mkv,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        assert!(preserve_audio_in_plan(
            &mut plan,
            TargetFormat::Mkv,
            &["aac".to_string(), "ac3".to_string()]
        ));
        assert_eq!(
            plan.args,
            vec!["-c", "copy", "-map", "0:v:0?", "-map", "0:a?"]
        );
        // Carrying tracks the source already had must not force an encode.
        assert!(!plan.reencoded);
    }

    #[test]
    fn preserving_audio_leaves_a_single_stream_alone() {
        let mut plan = crate::compat::decide(
            TargetFormat::Mkv,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        assert!(!preserve_audio_in_plan(
            &mut plan,
            TargetFormat::Mkv,
            &["aac".to_string()]
        ));
        assert_eq!(plan.args, vec!["-c", "copy"]);
    }

    #[test]
    fn preserving_audio_skips_targets_that_hold_one_stream() {
        for t in [
            TargetFormat::Mp3,
            TargetFormat::Wav,
            TargetFormat::Flac,
            TargetFormat::Gif,
            TargetFormat::Png,
            TargetFormat::M4a,
        ] {
            let mut plan = crate::compat::decide(t, Some("h264"), Some("aac"), None, None, None);
            let before = plan.args.clone();
            assert!(
                !preserve_audio_in_plan(&mut plan, t, &["aac".to_string(), "aac".to_string()]),
                "{t:?}"
            );
            assert_eq!(plan.args, before, "{t:?}");
        }
    }

    #[test]
    fn preserving_audio_adds_nothing_when_the_map_would_narrow() {
        // No maps beats maps that keep only what ffmpeg would have kept
        // anyway — and beats maps that carry a mis-taggable track.
        let mut plan = crate::compat::decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        assert!(!preserve_audio_in_plan(
            &mut plan,
            TargetFormat::Mp4,
            &["aac".to_string(), "vorbis".to_string()]
        ));
        assert_eq!(plan.args, vec!["-c", "copy"]);
    }

    // --- Extraction ----------------------------------------------------

    #[test]
    fn extract_plans_name_the_right_encoder() {
        assert_eq!(plan_extract(TargetFormat::Srt).args[3], "srt");
        assert_eq!(plan_extract(TargetFormat::Vtt).args[3], "webvtt");
    }
}
