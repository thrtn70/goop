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
    bundled_resolver, convert, ffmpeg_path, make_source, make_source_sized, request, stream_codecs,
    stream_tags, video_dimensions,
};
use goop_converter::compat::{decide, decide_compression, Plan};
use goop_core::{CompressMode, QualityPreset, ResolutionCap, TargetFormat};

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

/// Every plan `target` can produce, across the source-codec, preset and
/// resolution-cap combinations that select different branches.
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

    // A cap inserts a `scale` filter, and a filtergraph cannot feed a
    // copied stream — so on a plan that would have remuxed, the cap is
    // what *selects an encoder*, reaching a codec name no preset sweep
    // above ever produces. Only paired with `None` here: against an
    // explicit preset the cap changes the filters and nothing else, so
    // those combinations name no further encoders.
    const CAPS: &[Option<ResolutionCap>] = &[
        Some(ResolutionCap::Original),
        Some(ResolutionCap::R1080p),
        Some(ResolutionCap::R720p),
        Some(ResolutionCap::R480p),
    ];

    let mut plans = vec![];
    for &(v, a) in SOURCES {
        for &q in PRESETS {
            plans.push(decide(target, v, a, q, None, None));
        }
        for &cap in CAPS {
            plans.push(decide(target, v, a, None, cap, None));
        }
        for &mode in MODES {
            plans.push(decide_compression(target, v, a, mode, 10_000));
        }
    }
    plans
}

// ---------------------------------------------------------------------------
// The resolution-cap regression
// ---------------------------------------------------------------------------
//
// A cap inserts a `scale` filter, and ffmpeg refuses a filtergraph paired
// with `-c copy`. The unit tests in `compat.rs` assert the plan no longer
// pairs them, which is the shape of the fix; only running the command
// proves ffmpeg accepts it. That gap is the entire bug — the old args
// looked perfectly reasonable in a `Plan`.

/// The common case: a source the target would otherwise have remuxed.
#[tokio::test]
#[ignore]
async fn a_capped_mp4_conversion_scales_instead_of_failing() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let out = tmp.path().join("out.mp4");
    // Larger than the cap, or the "cap" would pass by upscaling.
    make_source_sized(&ffmpeg, &src, 1920, 1080);

    let mut req = request(&src, &out, TargetFormat::Mp4, None);
    req.resolution_cap = Some(ResolutionCap::R720p);

    convert(&r, &req)
        .await
        .expect("a capped conversion must not pair -vf with a stream copy");

    assert_eq!(video_dimensions(&r, &out), (1280, 720));
    // Encoded, not copied — the cap is what forced it.
    assert_eq!(stream_codecs(&r, &out, "v"), vec!["h264"]);
    // ...but the audio it was going to copy stayed copied.
    assert_eq!(stream_codecs(&r, &out, "a"), vec!["aac"]);
}

/// AVI reaches its encoder only through the cap here, and that encoder is
/// the one the sidecars disagreed about. Both halves have to hold at once.
#[tokio::test]
#[ignore]
async fn a_capped_avi_conversion_uses_an_encoder_the_sidecar_has() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let h264 = tmp.path().join("h264.mp4");
    let src = tmp.path().join("src.avi");
    let out = tmp.path().join("out.avi");
    // The remux case specifically: AVI stream-copies an mpeg4+mp3 source,
    // so the cap is the only thing that can force it to an encoder. An
    // h264 source would already be encoding and would pass either way.
    make_source_sized(&ffmpeg, &h264, 1920, 1080);
    let status = Command::new(&ffmpeg)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(&h264)
        .args(["-c:v", "mpeg4", "-vtag", "xvid", "-c:a", "libmp3lame"])
        .arg(&src)
        .status()
        .unwrap();
    assert!(status.success(), "failed to build the mpeg4+mp3 AVI source");
    assert_eq!(stream_codecs(&r, &src, "v"), vec!["mpeg4"]);
    assert_eq!(stream_codecs(&r, &src, "a"), vec!["mp3"]);

    let mut req = request(&src, &out, TargetFormat::Avi, None);
    req.resolution_cap = Some(ResolutionCap::R480p);

    convert(&r, &req)
        .await
        .expect("a capped AVI conversion must encode with a present encoder");

    assert_eq!(video_dimensions(&r, &out), (854, 480));
    assert_eq!(stream_codecs(&r, &out, "v"), vec!["mpeg4"]);
    // The other half: the cap replaced the video codec only, so the mp3
    // track AVI was going to copy is still copied.
    assert_eq!(stream_codecs(&r, &out, "a"), vec!["mp3"]);
    // The FourCC the forced-encode path sets has to survive the rewrite,
    // since the cap takes the target's encode args rather than inventing
    // its own.
    assert_eq!(stream_tags(&r, &out, "v"), vec!["xvid"]);
}

/// A cap is a ceiling, not a target: a source already under it must come
/// out untouched. `scale={w}:-2` has no source dimensions in play, so it
/// enlarges anything smaller — turning a "cap" into an upscale that costs
/// bitrate and invents detail that was never there.
#[tokio::test]
#[ignore]
async fn a_cap_larger_than_the_source_leaves_it_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let out = tmp.path().join("out.mp4");
    // Comfortably under every cap the enum offers.
    make_source_sized(&ffmpeg, &src, 640, 480);

    let mut req = request(&src, &out, TargetFormat::Mp4, None);
    req.resolution_cap = Some(ResolutionCap::R1080p);

    convert(&r, &req)
        .await
        .expect("a capped conversion must run");

    assert_eq!(
        video_dimensions(&r, &out),
        (640, 480),
        "a 1080p cap must not enlarge a 640x480 source"
    );
}

/// The same, through the smallest cap, so the assertion is not an artefact
/// of one width — and paired with the downscale case above it pins both
/// directions of the ceiling.
#[tokio::test]
#[ignore]
async fn the_smallest_cap_still_leaves_a_smaller_source_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let out = tmp.path().join("out.mp4");
    make_source_sized(&ffmpeg, &src, 320, 240);

    let mut req = request(&src, &out, TargetFormat::Mp4, None);
    req.resolution_cap = Some(ResolutionCap::R480p);

    convert(&r, &req)
        .await
        .expect("a capped conversion must run");

    assert_eq!(video_dimensions(&r, &out), (320, 240));
}

/// An odd-sized source under the cap comes out at even dimensions.
///
/// The clamp hands the source's own width through, so an odd one survives
/// to the output. Nothing here pins a pixel format, so ffmpeg carries
/// 4:4:4 and encodes it without complaint — which is exactly why this
/// needs pinning rather than trusting the encoder to object. 4:2:0 cannot
/// represent an odd width at all (forcing it, libx264 refuses outright
/// with "width not divisible by 2"), and it is what nearly everything
/// downstream expects.
///
/// The source has to be 4:4:4 for the same reason: an odd-width 4:2:0
/// file cannot exist, so there would be nothing to test with.
#[tokio::test]
#[ignore]
async fn an_odd_sized_source_under_the_cap_still_produces_valid_output() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let out = tmp.path().join("out.mp4");

    let status = Command::new(&ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=s=641x481:d=1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv444p",
        ])
        .arg(&src)
        .status()
        .unwrap();
    assert!(status.success(), "failed to build the odd-sized source");
    assert_eq!(video_dimensions(&r, &src), (641, 481));

    let mut req = request(&src, &out, TargetFormat::Mp4, None);
    req.resolution_cap = Some(ResolutionCap::R1080p);

    convert(&r, &req)
        .await
        .expect("a capped conversion must run");

    // Rounded down, never up: 641 -> 640 keeps it under the cap, where
    // rounding up would be a one-pixel upscale of exactly the kind this
    // clamp exists to prevent.
    assert_eq!(video_dimensions(&r, &out), (640, 480));
    assert!(std::fs::metadata(&out).unwrap().len() > 0);
}

/// The mirror: without a cap the same conversion must still remux, or the
/// fix has cost every uncapped conversion its stream copy.
#[tokio::test]
#[ignore]
async fn an_uncapped_conversion_still_remuxes() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let out = tmp.path().join("out.mkv");
    make_source_sized(&ffmpeg, &src, 1920, 1080);

    convert(&r, &request(&src, &out, TargetFormat::Mkv, None))
        .await
        .expect("an uncapped conversion must still succeed");

    // Untouched dimensions and the source's own codecs: a remux.
    assert_eq!(video_dimensions(&r, &out), (1920, 1080));
    assert_eq!(stream_codecs(&r, &out, "v"), vec!["h264"]);
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
