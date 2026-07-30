//! Real-ffmpeg checks for subtitle support.
//!
//! Every other test in this crate asserts on the `Plan` arg vector, which
//! cannot catch an arg list that is well-formed but rejected by ffmpeg.
//! These drive `FfmpegBackend::convert` end to end instead.
//!
//! `#[ignore]` so `cargo test --workspace` stays green without a bundled
//! ffmpeg. Run them explicitly:
//!
//! ```text
//! cargo test -p goop-converter --test subtitle_ffmpeg -- --ignored
//! ```

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use goop_converter::backend::ConversionBackend;
use goop_converter::FfmpegBackend;
use goop_core::{
    ConvertRequest, EventSink, JobId, ProgressEvent, QueueEvent, SidecarEvent, SubtitleMode,
    SubtitleOptions, TargetFormat,
};
use goop_sidecar::BinaryResolver;
use tokio_util::sync::CancellationToken;

struct SilentSink;

impl EventSink for SilentSink {
    fn emit_progress(&self, _: ProgressEvent) {}
    fn emit_queue(&self, _: QueueEvent) {}
    fn emit_sidecar(&self, _: SidecarEvent) {}
}

/// A resolver pointed at a directory holding plainly-named copies of this
/// checkout's sidecars.
///
/// `src-tauri/bin` stores them as `<name>-<target-triple>`, the layout
/// Tauri's bundler consumes, whereas `BinaryResolver` looks for a bare
/// `<name>` (which is what the packaged app ends up with). Symlinking into
/// a temp dir bridges the two so these tests exercise the ffmpeg that
/// actually ships rather than whatever is on `PATH`.
fn bundled_resolver(link_dir: &Path) -> BinaryResolver {
    let bin = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../src-tauri/bin")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("src-tauri/bin"));
    let triple = current_triple();
    for name in ["ffmpeg", "ffprobe"] {
        // `BinaryResolver` appends `.exe` on Windows, so the link has to
        // carry it too or the lookup misses and silently falls back to
        // whatever is on `PATH`.
        let (src_name, dst_name) = if cfg!(windows) {
            (format!("{name}-{triple}.exe"), format!("{name}.exe"))
        } else {
            (format!("{name}-{triple}"), name.to_string())
        };
        let src = bin.join(src_name);
        if src.is_file() {
            let _ = symlink(&src, &link_dir.join(dst_name));
        }
    }
    BinaryResolver::new(link_dir.to_path_buf())
}

#[cfg(unix)]
fn symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

#[cfg(windows)]
fn symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::copy(src, dst).map(|_| ())
}

fn current_triple() -> &'static str {
    // Only the two shipping targets need to resolve here; anything else
    // falls through to the `PATH` lookup inside `BinaryResolver`.
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else {
        "unknown"
    }
}

fn ffmpeg_path(r: &BinaryResolver) -> PathBuf {
    let resolved = r
        .resolve("ffmpeg")
        .expect("ffmpeg must be resolvable for this ignored test");
    // Without this the suite can pass green against a `PATH` ffmpeg that
    // has nothing to do with what ships — which is exactly how the missing
    // libass in Homebrew's build went unnoticed until it was looked for.
    assert!(
        !resolved.source_is_path,
        "expected the bundled sidecar, got {} from PATH — run scripts/fetch-sidecars.sh",
        resolved.path.display()
    );
    resolved.path
}

/// True when the resolved ffmpeg was built with libass. Burn-in needs it,
/// and Homebrew's ffmpeg — the usual `PATH` fallback in a dev checkout —
/// is built without it.
fn has_subtitles_filter(ffmpeg: &Path) -> bool {
    Command::new(ffmpeg)
        .args(["-hide_banner", "-filters"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .any(|l| l.split_whitespace().nth(1) == Some("subtitles"))
        })
        .unwrap_or(false)
}

fn write_srt(path: &Path, text: &str) {
    std::fs::write(path, format!("1\n00:00:00,200 --> 00:00:01,500\n{text}\n")).unwrap();
}

/// A cp1252 subtitle: one accented cue, one pure-ASCII cue.
///
/// This shape is the whole point. ffmpeg drops only the cues it cannot
/// decode and exits 0, so a file that is *mostly* ASCII loses a line or two
/// and still reports success — the silent case. A file where every cue is
/// undecodable fails loudly instead, and would not catch the regression.
fn write_cp1252_srt(path: &Path) {
    let mut bytes = b"1\n00:00:00,200 --> 00:00:01,000\n".to_vec();
    // "Cafe a cote de l'hotel" with cp1252 accents (0xE9 = e-acute,
    // 0xE0 = a-grave, 0xF4 = o-circumflex).
    bytes.extend_from_slice(b"Caf\xE9 \xE0 c\xF4t\xE9 de l'h\xF4tel\n\n");
    bytes.extend_from_slice(b"2\n00:00:01,100 --> 00:00:01,800\nplain ascii cue\n");
    std::fs::write(path, bytes).unwrap();
}

/// Number of cues in a subtitle file ffmpeg can read back.
fn cue_count(r: &BinaryResolver, path: &Path) -> usize {
    let ffmpeg = r.resolve("ffmpeg").expect("ffmpeg").path;
    let out = Command::new(ffmpeg)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args(["-c:s", "webvtt", "-f", "webvtt", "-"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains("-->"))
        .count()
}

/// A 2-second colour clip with a silent audio track.
fn make_source(ffmpeg: &Path, out: &Path) {
    let status = Command::new(ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=s=160x120:d=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:d=2",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(out)
        .status()
        .unwrap();
    assert!(status.success(), "failed to build the test source clip");
}

/// Codec names of `out`'s subtitle streams, in order.
fn subtitle_codecs(r: &BinaryResolver, out: &Path) -> Vec<String> {
    stream_codecs(r, out, "s")
}

/// Codec names of `out`'s streams of type `kind` ("v", "a", "s"), in order.
fn stream_codecs(r: &BinaryResolver, out: &Path, kind: &str) -> Vec<String> {
    let ffprobe = r.resolve("ffprobe").expect("ffprobe").path;
    let probe = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            kind,
            "-show_entries",
            "stream=codec_name",
            "-of",
            "csv=p=0",
        ])
        .arg(out)
        .output()
        .unwrap();
    String::from_utf8_lossy(&probe.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
        .collect()
}

/// A 2-second clip carrying **two** audio tracks and **two** SubRip tracks.
///
/// Both multiplicities matter: ffmpeg's automatic stream selection keeps
/// exactly one stream per type, so a single-track fixture cannot tell a
/// working `-map` from a missing one.
fn make_multi_track_source(ffmpeg: &Path, out: &Path, tmp: &Path) {
    let eng = tmp.join("eng.srt");
    let spa = tmp.join("spa.srt");
    write_srt(&eng, "ENGLISH");
    write_srt(&spa, "SPANISH");
    let status = Command::new(ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=s=160x120:d=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:d=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:d=2",
        ])
        .arg("-i")
        .arg(&eng)
        .arg("-i")
        .arg(&spa)
        .args([
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-map",
            "3",
            "-map",
            "4",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-c:s",
            "srt",
            "-shortest",
        ])
        .arg(out)
        .status()
        .unwrap();
    assert!(status.success(), "failed to build the multi-track source");
}

fn request(
    input: &Path,
    output: &Path,
    target: TargetFormat,
    sub: Option<SubtitleOptions>,
) -> ConvertRequest {
    ConvertRequest {
        input_path: input.to_string_lossy().into_owned(),
        output_path: output.to_string_lossy().into_owned(),
        target,
        quality_preset: None,
        resolution_cap: None,
        gif_options: None,
        compress_mode: None,
        batch_id: None,
        metadata_policy: None,
        subtitle: sub,
    }
}

async fn convert(r: &BinaryResolver, req: &ConvertRequest) -> Result<(), goop_core::GoopError> {
    FfmpegBackend::new(r, Arc::new(SilentSink))
        .convert(JobId::new(), req, CancellationToken::new())
        .await
        .map(|_| ())
}

#[tokio::test]
#[ignore]
async fn soft_embed_produces_a_playable_subtitle_track() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let subs = tmp.path().join("subs.srt");
    let out = tmp.path().join("out.mp4");
    make_source(&ffmpeg, &src);
    write_srt(&subs, "Hello from goop");

    convert(
        &r,
        &request(
            &src,
            &out,
            TargetFormat::Mp4,
            Some(SubtitleOptions {
                source_path: subs.to_string_lossy().into_owned(),
                mode: SubtitleMode::Soft,
            }),
        ),
    )
    .await
    .expect("soft embed should succeed");

    // `-c copy` followed by `-c:s mov_text` must transcode only the
    // subtitle and leave the a/v streams copied.
    assert_eq!(subtitle_codecs(&r, &out), vec!["mov_text"]);
}

#[tokio::test]
#[ignore]
async fn soft_embed_keeps_every_cue_of_a_legacy_codepage_subtitle() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let subs = tmp.path().join("subs.srt");
    let out = tmp.path().join("out.mp4");
    make_source(&ffmpeg, &src);
    write_cp1252_srt(&subs);

    // Guard the guard: without -sub_charenc ffmpeg keeps only the ASCII
    // cue, so a 2-cue result below really is the fix working rather than
    // the fixture being decodable all along.
    assert_eq!(
        cue_count(&r, &subs),
        1,
        "fixture must lose a cue when read as UTF-8, or this test proves nothing"
    );

    convert(
        &r,
        &request(
            &src,
            &out,
            TargetFormat::Mp4,
            Some(SubtitleOptions {
                source_path: subs.to_string_lossy().into_owned(),
                mode: SubtitleMode::Soft,
            }),
        ),
    )
    .await
    .expect("soft embed of a cp1252 subtitle should succeed");

    assert_eq!(
        cue_count(&r, &out),
        2,
        "the accented cue was dropped: the encoding was not detected"
    );
}

#[tokio::test]
#[ignore]
async fn extracting_from_a_container_leaves_utf8_text_untouched() {
    // Extraction shares its request shape with standalone srt↔vtt
    // conversion — no attached subtitle, subtitle target — so charset
    // detection has to tell them apart by source kind. Sniffing the
    // container guesses a codepage from binary media and forces it onto an
    // embedded track that was already valid UTF-8, turning a byte-perfect
    // extraction into mojibake while still exiting 0.
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let subs = tmp.path().join("subs.srt");
    let container = tmp.path().join("with_subs.mkv");
    let out = tmp.path().join("out.srt");

    const TEXT: &str = "Café à côté de l'hôtel, très élégant";
    make_source(&ffmpeg, &src);
    write_srt(&subs, TEXT);
    let status = Command::new(&ffmpeg)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(&src)
        .arg("-i")
        .arg(&subs)
        .args(["-map", "0", "-map", "1", "-c", "copy", "-c:s", "srt"])
        .arg(&container)
        .status()
        .unwrap();
    assert!(status.success(), "failed to mux the subtitle into the mkv");

    convert(&r, &request(&container, &out, TargetFormat::Srt, None))
        .await
        .expect("extraction should succeed");

    let text = std::fs::read_to_string(&out).unwrap();
    assert!(
        text.contains(TEXT),
        "embedded UTF-8 text was mangled on the way out: {text}"
    );
    assert!(
        !text.contains("CafÃ"),
        "text was re-decoded through a guessed codepage: {text}"
    );
}

#[tokio::test]
#[ignore]
async fn srt_to_vtt_keeps_every_cue_of_a_legacy_codepage_subtitle() {
    // The standalone conversion path reads the subtitle as its *main*
    // input, so it needs the encoding detected somewhere else entirely.
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let subs = tmp.path().join("subs.srt");
    let out = tmp.path().join("out.vtt");
    write_cp1252_srt(&subs);
    assert_eq!(cue_count(&r, &subs), 1, "fixture must be lossy as UTF-8");

    convert(&r, &request(&subs, &out, TargetFormat::Vtt, None))
        .await
        .expect("srt to vtt of a cp1252 subtitle should succeed");

    let text = std::fs::read_to_string(&out).unwrap();
    assert_eq!(
        text.lines().filter(|l| l.contains("-->")).count(),
        2,
        "cue dropped in conversion: {text}"
    );
    assert!(
        text.contains("Café à côté de l'hôtel"),
        "text was not decoded to UTF-8: {text}"
    );
}

#[tokio::test]
#[ignore]
async fn soft_embed_keeps_the_sources_own_subtitle_track() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let original = tmp.path().join("original.srt");
    let with_subs = tmp.path().join("with_subs.mkv");
    let extra = tmp.path().join("extra.srt");
    let out = tmp.path().join("out.mkv");
    make_source(&ffmpeg, &src);
    write_srt(&original, "ORIGINAL");
    write_srt(&extra, "EXTRA");

    // Build a source that already carries a subtitle track.
    let status = Command::new(&ffmpeg)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(&src)
        .arg("-i")
        .arg(&original)
        .args(["-c", "copy", "-c:s", "srt"])
        .arg(&with_subs)
        .status()
        .unwrap();
    assert!(status.success());

    convert(
        &r,
        &request(
            &with_subs,
            &out,
            TargetFormat::Mkv,
            Some(SubtitleOptions {
                source_path: extra.to_string_lossy().into_owned(),
                mode: SubtitleMode::Soft,
            }),
        ),
    )
    .await
    .expect("soft embed onto a subtitled source should succeed");

    // Attaching a subtitle must not silently discard the one already there.
    assert_eq!(subtitle_codecs(&r, &out), vec!["subrip", "subrip"]);
}

#[tokio::test]
#[ignore]
async fn an_mkv_remux_keeps_every_existing_subtitle_track() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("multi.mkv");
    let out = tmp.path().join("out.mkv");
    make_multi_track_source(&ffmpeg, &src, tmp.path());

    convert(&r, &request(&src, &out, TargetFormat::Mkv, None))
        .await
        .expect("mkv -> mkv with no attached subtitle should succeed");

    // Without explicit maps ffmpeg's automatic selection keeps exactly one
    // stream per type, so both counts have to be asserted.
    assert_eq!(stream_codecs(&r, &out, "s").len(), 2, "subtitle tracks");
    assert_eq!(stream_codecs(&r, &out, "a").len(), 2, "audio tracks");
}

#[tokio::test]
#[ignore]
async fn an_mp4_conversion_keeps_every_existing_subtitle_track() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("multi.mkv");
    let out = tmp.path().join("out.mp4");
    make_multi_track_source(&ffmpeg, &src, tmp.path());

    convert(&r, &request(&src, &out, TargetFormat::Mp4, None))
        .await
        .expect("mkv -> mp4 with no attached subtitle should succeed");

    // MP4's muxer has no default subtitle codec, so automatic selection
    // drops subtitles entirely — the `-c:s` is what makes these survive.
    assert_eq!(
        stream_codecs(&r, &out, "s"),
        vec!["mov_text", "mov_text"],
        "SubRip has to be rewritten as mov_text to enter an MP4"
    );
    // Audio deliberately stays at one: this is a stream-copy plan, whose
    // copy-eligibility was decided from the first audio stream alone, and
    // MP4 will happily box an unvetted second track under the wrong FourCC
    // while still reporting success. See `audio_map`.
    assert_eq!(stream_codecs(&r, &out, "a").len(), 1, "audio tracks");
}

#[tokio::test]
#[ignore]
async fn a_re_encoding_mp4_conversion_keeps_every_audio_track() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("multi.mkv");
    let out = tmp.path().join("out.mp4");
    make_multi_track_source(&ffmpeg, &src, tmp.path());

    // Re-encoding rewrites every mapped audio stream into one known-good
    // codec, which is what makes the wide `0:a?` map safe here.
    let mut req = request(&src, &out, TargetFormat::Mp4, None);
    req.quality_preset = Some(goop_core::QualityPreset::Fast);
    convert(&r, &req).await.expect("mkv -> mp4 re-encode");

    assert_eq!(stream_codecs(&r, &out, "a").len(), 2, "audio tracks");
    assert_eq!(stream_codecs(&r, &out, "s").len(), 2, "subtitle tracks");
}

#[tokio::test]
#[ignore]
async fn attaching_a_subtitle_keeps_every_audio_track() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("multi.mkv");
    let extra = tmp.path().join("extra.srt");
    let out = tmp.path().join("out.mkv");
    make_multi_track_source(&ffmpeg, &src, tmp.path());
    write_srt(&extra, "EXTRA");

    convert(
        &r,
        &request(
            &src,
            &out,
            TargetFormat::Mkv,
            Some(SubtitleOptions {
                source_path: extra.to_string_lossy().into_owned(),
                mode: SubtitleMode::Soft,
            }),
        ),
    )
    .await
    .expect("soft embed onto a multi-track source should succeed");

    // The attach path's explicit maps are exhaustive: mapping only the
    // first audio stream would drop the film's other language tracks.
    assert_eq!(stream_codecs(&r, &out, "a").len(), 2, "audio tracks");
    assert_eq!(stream_codecs(&r, &out, "s").len(), 3, "2 existing + 1 new");
}

#[tokio::test]
#[ignore]
async fn a_source_without_subtitles_gains_none() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    let out = tmp.path().join("out.mkv");
    make_source(&ffmpeg, &src);

    convert(&r, &request(&src, &out, TargetFormat::Mkv, None))
        .await
        .expect("a plain remux should succeed");

    assert!(stream_codecs(&r, &out, "s").is_empty());
    assert_eq!(stream_codecs(&r, &out, "v").len(), 1);
    assert_eq!(stream_codecs(&r, &out, "a").len(), 1);
}

#[tokio::test]
#[ignore]
async fn burn_in_renders_through_the_libass_filter() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("src.mp4");
    // Exercise the escaping alongside the filter: spaces and a comma are
    // both filtergraph-hostile.
    let subs = tmp.path().join("my subs, take 2.srt");
    let out = tmp.path().join("out.mp4");
    if !has_subtitles_filter(&ffmpeg) {
        eprintln!(
            "skipping: {} was built without libass (no `subtitles` filter). \
             The bundled sidecar has it; a PATH ffmpeg often does not.",
            ffmpeg.display()
        );
        return;
    }
    make_source(&ffmpeg, &src);
    write_srt(&subs, "Burned in");

    convert(
        &r,
        &request(
            &src,
            &out,
            TargetFormat::Mp4,
            Some(SubtitleOptions {
                source_path: subs.to_string_lossy().into_owned(),
                mode: SubtitleMode::BurnIn,
            }),
        ),
    )
    .await
    .expect("burn-in should succeed (needs an ffmpeg built with libass)");

    // Burned-in subtitles live in the pixels, not in a stream.
    assert!(subtitle_codecs(&r, &out).is_empty());
    assert!(std::fs::metadata(&out).unwrap().len() > 0);
}

#[tokio::test]
#[ignore]
async fn srt_converts_to_vtt_and_back() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let srt = tmp.path().join("in.srt");
    let vtt = tmp.path().join("out.vtt");
    let back = tmp.path().join("back.srt");
    write_srt(&srt, "Round trip");

    convert(&r, &request(&srt, &vtt, TargetFormat::Vtt, None))
        .await
        .expect("srt -> vtt");
    let vtt_text = std::fs::read_to_string(&vtt).unwrap();
    assert!(vtt_text.starts_with("WEBVTT"), "got: {vtt_text}");
    assert!(vtt_text.contains("Round trip"));

    convert(&r, &request(&vtt, &back, TargetFormat::Srt, None))
        .await
        .expect("vtt -> srt");
    let srt_text = std::fs::read_to_string(&back).unwrap();
    assert!(srt_text.contains("Round trip"));
    assert!(
        srt_text.contains("00:00:00,200 --> 00:00:01,500"),
        "got: {srt_text}"
    );
}
