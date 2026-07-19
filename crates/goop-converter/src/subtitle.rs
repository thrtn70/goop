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

/// Attach `sub_path` to `plan` according to `mode`.
///
/// Returns the path ffmpeg must open as a **second input** (`-i`), which is
/// `Some` for soft-embed and `None` for burn-in — burn-in reads the file
/// through the filter graph instead.
pub(crate) fn apply_to_plan(
    plan: &mut Plan,
    target: TargetFormat,
    mode: SubtitleMode,
    sub_path: &Path,
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
/// two rounds of escaping. Backslashes are normalized to forward slashes
/// first (Win32 accepts them), which leaves the drive-letter colon as the
/// only Windows-specific case: `C:\x\y.srt` becomes `C\\:/x/y.srt`.
///
/// Args are passed to ffmpeg via `Command::arg`, never a shell, so no
/// third (shell) round applies.
pub(crate) fn escape_subtitles_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let layer1 = normalized.replace('\'', r"\'").replace(':', r"\:");
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
        assert_eq!(
            escape_subtitles_path(r"C:\Users\thor\my subs.srt"),
            r"C\\:/Users/thor/my subs.srt"
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
            )
            .unwrap_err();
            assert!(matches!(err, GoopError::InvalidRequest(_)), "{target:?}");
        }
    }

    // --- Extraction ----------------------------------------------------

    #[test]
    fn extract_plans_name_the_right_encoder() {
        assert_eq!(plan_extract(TargetFormat::Srt).args[3], "srt");
        assert_eq!(plan_extract(TargetFormat::Vtt).args[3], "webvtt");
    }
}
