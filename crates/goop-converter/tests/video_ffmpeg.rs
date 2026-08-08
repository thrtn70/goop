//! Real-ffmpeg checks for the video container targets.
//!
//! The unit tests in `compat.rs` assert on the `Plan` arg vector, which
//! proves the args are *shaped* right but not that the bundled ffmpeg can
//! run them. AVI is the cautionary tale: the plan named `libxvid`, every
//! unit test passed, and every real conversion died with
//! `Unknown encoder 'libxvid'` because neither shipping sidecar build
//! (osxexperts on macOS, gyan on Windows) is guaranteed to carry the
//! external XviD library.
//!
//! `#[ignore]` so `cargo test --workspace` stays green without a bundled
//! ffmpeg. Run them explicitly:
//!
//! ```text
//! cargo test -p goop-converter --test video_ffmpeg -- --ignored
//! ```

mod common;

use std::collections::HashSet;
use std::path::Path;
use std::process::Command;

use common::{
    bundled_resolver, convert, ffmpeg_path, make_source, request, stream_codecs, stream_tags,
};
use goop_converter::compat::{decide, decide_compression, Plan};
use goop_core::{CompressMode, QualityPreset, TargetFormat};

// ---------------------------------------------------------------------------
// The AVI regression
// ---------------------------------------------------------------------------

/// h.264 is what essentially every real source carries, so this is the
/// path every non-trivial AVI conversion takes.
#[tokio::test]
#[ignore]
async fn an_h264_source_converts_to_avi() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let out = tmp.path().join("out.avi");
    make_source(&ffmpeg, &src);

    convert(&r, &request(&src, &out, TargetFormat::Avi, None))
        .await
        .expect("an h264 source must convert to AVI");

    assert_eq!(stream_codecs(&r, &out, "v"), vec!["mpeg4"]);
    assert_eq!(stream_codecs(&r, &out, "a"), vec!["mp3"]);
}

/// A quality preset takes the same encode path via `plan_avi_encode`, so
/// it would have failed identically. Covered separately because it reaches
/// the branch through `force_preset` rather than codec incompatibility.
#[tokio::test]
#[ignore]
async fn an_avi_conversion_with_a_quality_preset_encodes() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let out = tmp.path().join("out.avi");
    make_source(&ffmpeg, &src);

    let mut req = request(&src, &out, TargetFormat::Avi, None);
    req.quality_preset = Some(QualityPreset::Small);

    convert(&r, &req)
        .await
        .expect("an AVI conversion with a preset must encode, not fail");

    assert_eq!(stream_codecs(&r, &out, "v"), vec!["mpeg4"]);
}

/// AVI exists in the target list for players that never learned anything
/// newer, and those players dispatch on the FourCC rather than the
/// bitstream. ffmpeg's native mpeg4 encoder tags its output `FMP4`, which
/// the older decoders don't recognise; `xvid` is what the libxvid encoder
/// this plan used to name would have written.
#[tokio::test]
#[ignore]
async fn an_avi_encode_is_tagged_for_legacy_players() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let out = tmp.path().join("out.avi");
    make_source(&ffmpeg, &src);

    convert(&r, &request(&src, &out, TargetFormat::Avi, None))
        .await
        .expect("an h264 source must convert to AVI");

    assert_eq!(stream_tags(&r, &out, "v"), vec!["xvid"]);
}

/// The encode path has to land on codecs the remux path recognises, or
/// re-running the same conversion on its own output re-encodes forever.
#[tokio::test]
#[ignore]
async fn a_converted_avi_round_trips_without_re_encoding() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let first = tmp.path().join("first.avi");
    let second = tmp.path().join("second.avi");
    make_source(&ffmpeg, &src);

    convert(&r, &request(&src, &first, TargetFormat::Avi, None))
        .await
        .expect("first pass");

    // Whatever the encode produced must satisfy `plan_avi`'s stream-copy
    // arm — the probe reports `mpeg4` + `mp3`, so this is a remux.
    let plan = decide(
        TargetFormat::Avi,
        Some(&stream_codecs(&r, &first, "v")[0]),
        Some(&stream_codecs(&r, &first, "a")[0]),
        None,
        None,
        None,
    );
    assert!(
        !plan.reencoded,
        "an AVI produced by goop should remux, not re-encode: {:?}",
        plan.args
    );

    convert(&r, &request(&first, &second, TargetFormat::Avi, None))
        .await
        .expect("second pass");
    assert_eq!(stream_codecs(&r, &second, "v"), vec!["mpeg4"]);
}

// ---------------------------------------------------------------------------
// The class of bug behind it
// ---------------------------------------------------------------------------

/// Every encoder any plan can name must exist in the bundled ffmpeg.
///
/// `libxvid` was absent from the macOS sidecar and present in the Windows
/// one, so no amount of local testing on one platform would have caught
/// it. This runs on both runners in CI and covers every target at once, so
/// the next sidecar source swap that drops a library fails here instead of
/// in a user's queue.
#[test]
#[ignore]
fn every_encoder_the_plans_name_exists_in_the_bundled_ffmpeg() {
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let available = available_encoders(&ffmpeg);

    let mut missing: Vec<String> = vec![];
    for &target in FFMPEG_TARGETS {
        assert!(
            routed_through_ffmpeg(target),
            "{target:?} is in FFMPEG_TARGETS but is not an ffmpeg target"
        );
        for plan in plans_for(target) {
            for enc in encoders_named_by(&plan) {
                if !available.contains(&enc) {
                    missing.push(format!("{target:?} -> {enc}"));
                }
            }
        }
    }
    missing.sort();
    missing.dedup();
    assert!(
        missing.is_empty(),
        "the bundled ffmpeg ({}) has no such encoder(s): {missing:?}",
        ffmpeg.display()
    );
}

/// Targets whose conversion runs through ffmpeg. Image targets go to
/// ImageMagick and name no ffmpeg encoder.
const FFMPEG_TARGETS: &[TargetFormat] = &[
    TargetFormat::Mp4,
    TargetFormat::Mkv,
    TargetFormat::Webm,
    TargetFormat::Gif,
    TargetFormat::Avi,
    TargetFormat::Mov,
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
];

/// Exhaustive on purpose: adding a `TargetFormat` variant stops this file
/// compiling, which is the prompt to decide whether the new target belongs
/// in [`FFMPEG_TARGETS`] above.
fn routed_through_ffmpeg(t: TargetFormat) -> bool {
    match t {
        TargetFormat::Mp4
        | TargetFormat::Mkv
        | TargetFormat::Webm
        | TargetFormat::Gif
        | TargetFormat::Avi
        | TargetFormat::Mov
        | TargetFormat::Mp3
        | TargetFormat::M4a
        | TargetFormat::Opus
        | TargetFormat::Wav
        | TargetFormat::Flac
        | TargetFormat::Ogg
        | TargetFormat::Aac
        | TargetFormat::ExtractAudioKeepCodec
        | TargetFormat::Srt
        | TargetFormat::Vtt => true,
        TargetFormat::Png
        | TargetFormat::Jpeg
        | TargetFormat::Webp
        | TargetFormat::Bmp
        | TargetFormat::Tiff
        | TargetFormat::Avif
        | TargetFormat::JpegXl => false,
    }
}

/// Every plan `target` can produce, across the source-codec and preset
/// combinations that select different branches.
fn plans_for(target: TargetFormat) -> Vec<Plan> {
    // Source codecs chosen to hit both the stream-copy arms and the
    // re-encode fallbacks of each `plan_*` matcher.
    const SOURCES: &[(Option<&str>, Option<&str>)] = &[
        (Some("h264"), Some("aac")),
        (Some("h264"), Some("mp3")),
        (Some("mpeg4"), Some("mp3")),
        (Some("vp9"), Some("opus")),
        (Some("hevc"), Some("flac")),
        (None, None),
    ];
    const PRESETS: &[Option<QualityPreset>] = &[
        None,
        Some(QualityPreset::Original),
        Some(QualityPreset::Fast),
        Some(QualityPreset::Balanced),
        Some(QualityPreset::Small),
    ];
    const MODES: &[CompressMode] = &[
        CompressMode::Quality(50),
        CompressMode::LosslessReoptimize,
        CompressMode::TargetSizeBytes(1_000_000),
    ];

    let mut plans = vec![];
    for &(v, a) in SOURCES {
        for &q in PRESETS {
            plans.push(decide(target, v, a, q, None, None));
        }
        for &mode in MODES {
            plans.push(decide_compression(target, v, a, mode, 10_000));
        }
    }
    plans
}

/// Encoder names a plan hands to ffmpeg — the token after each codec
/// selector, minus the `copy` pseudo-encoder.
fn encoders_named_by(plan: &Plan) -> Vec<String> {
    let mut named = vec![];
    let mut args = plan.args.iter();
    while let Some(arg) = args.next() {
        let selects_codec = arg == "-c"
            || arg.starts_with("-c:")
            || matches!(arg.as_str(), "-vcodec" | "-acodec" | "-scodec");
        if selects_codec {
            match args.next() {
                Some(name) if name != "copy" => named.push(name.clone()),
                _ => {}
            }
        }
    }
    named
}

/// Encoder names the binary reports, from the second column of
/// `ffmpeg -encoders`.
fn available_encoders(ffmpeg: &Path) -> HashSet<String> {
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output()
        .expect("ffmpeg -encoders");
    assert!(out.status.success(), "ffmpeg -encoders failed");
    let text = String::from_utf8_lossy(&out.stdout);
    let names: HashSet<String> = text
        .lines()
        // ffmpeg prints a flag legend, then a ` ------` rule, then the
        // rows. Skipping past the rule keeps the legend's own ` V..... =
        // Video` lines out of the set.
        .skip_while(|l| l.trim() != "------")
        .skip(1)
        // Rows are ` V....D name  Description`.
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            let flags = f.next()?;
            let name = f.next()?;
            (flags.len() == 6).then(|| name.to_string())
        })
        .collect();
    // A parse that silently yields nothing would make every caller's
    // lookup fail rather than pass, but say so plainly instead of
    // reporting every encoder as missing.
    assert!(
        names.contains("mpeg4"),
        "could not parse `ffmpeg -encoders` output — got {} name(s)",
        names.len()
    );
    names
}
