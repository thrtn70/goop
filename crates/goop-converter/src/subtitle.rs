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

/// Attach `sub_path` to `plan` according to `mode`.
///
/// `preserve_existing` maps the source's own subtitle streams through
/// alongside the new one; see [`can_preserve_existing`] for when that is
/// safe. It is ignored for burn-in, which adds no stream maps at all.
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
            // Explicit maps: taking the first video and audio stream from
            // input 0 and the subtitle from input 1. The `?` suffixes keep a
            // video-only or silent source working. Without explicit maps
            // ffmpeg's default stream selection ignores the second input.
            plan.args.extend([
                "-map".to_string(),
                "0:v:0?".to_string(),
                "-map".to_string(),
                "0:a:0?".to_string(),
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
            plan.video_filters.push(format!(
                "subtitles=filename={}",
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
        )
        .unwrap();

        assert_eq!(
            plan.args,
            vec![
                "-c", "copy", "-map", "0:v:0?", "-map", "0:a:0?", "-map", "0:s?", "-map", "1:0",
                "-c:s", "srt",
            ]
        );
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
        )
        .unwrap();

        assert!(!plan.args.iter().any(|a| a == "0:s?"));
    }

    // --- Extraction ----------------------------------------------------

    #[test]
    fn extract_plans_name_the_right_encoder() {
        assert_eq!(plan_extract(TargetFormat::Srt).args[3], "srt");
        assert_eq!(plan_extract(TargetFormat::Vtt).args[3], "webvtt");
    }
}
