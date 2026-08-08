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

/// A 2-second clip with **two** audio tracks and **no** subtitle streams.
///
/// The absent subtitles are the whole point. The no-attachment path used to
/// emit stream maps only when the source carried subtitles, so a file of
/// this shape got no `-map` at all — and ffmpeg's automatic selection then
/// kept exactly one audio track, silently, at exit 0.
///
/// `second` names the encoder for the second track so a caller can build
/// both the vettable case (`aac`, which every container here maps to a
/// registered codec tag) and the unvettable one (`libvorbis`, which MP4
/// can only box under the `mp4a` catch-all).
fn make_multi_audio_source(ffmpeg: &Path, out: &Path, second: &str) {
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
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-c:v",
            "libx264",
            "-c:a:0",
            "aac",
            "-c:a:1",
            second,
            "-shortest",
        ])
        .arg(out)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "failed to build the multi-audio source (second track: {second})"
    );
}

/// The `codec_tag_string` of each of `out`'s audio streams, in order.
///
/// Counting streams is not enough to catch the failure this guards against:
/// MP4 will accept a codec it has no mapping for by boxing it under the
/// `mp4a` (AAC) FourCC, producing a stream that ffmpeg itself still reads
/// back through the ESDS descriptor while every ordinary player sees an AAC
/// track full of something that is not AAC.
/// `make_multi_audio_source` with the video and first-audio codecs chosen by
/// the caller.
///
/// A stream copy only stays a stream copy if *every* mapped stream suits the
/// container: WebM will not take h264 or AAC at all, so a source built for
/// MP4 lands on an encoding plan there and stops exercising the allowlist.
fn make_multi_audio_source_as(ffmpeg: &Path, out: &Path, video: &str, first: &str, second: &str) {
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
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-c:v",
            video,
            "-c:a:0",
            first,
            "-c:a:1",
            second,
            "-shortest",
        ])
        .arg(out)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "failed to build the multi-audio source ({video} / {first} / {second})"
    );
}

fn audio_tags(r: &BinaryResolver, out: &Path) -> Vec<String> {
    let ffprobe = r.resolve("ffprobe").expect("ffprobe").path;
    let probe = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=codec_tag_string",
            "-of",
            "csv=p=0",
        ])
        .arg(out)
        .output()
        .unwrap();
    String::from_utf8_lossy(&probe.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.trim().trim_end_matches(',').to_string())
        .collect()
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
    // Both audio tracks are AAC, which MP4 names properly, so the stream
    // copy carries them both. The unvettable case — where MP4 would box a
    // track under the wrong FourCC and still report success — narrows the
    // map instead, and is covered by
    // `an_unvettable_second_audio_track_is_dropped_not_corrupted`.
    assert_eq!(stream_codecs(&r, &out, "a").len(), 2, "audio tracks");
    assert_eq!(audio_tags(&r, &out), vec!["mp4a", "mp4a"]);
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

// --- Multi-audio sources that carry no subtitles ----------------------
//
// These four cover the path that emitted no `-map` at all: a source with
// several audio tracks and no subtitle track. ffmpeg's automatic stream
// selection keeps one stream per type, so every track but the first was
// dropped on the way out — on every target, at exit 0, with no warning.

#[tokio::test]
#[ignore]
async fn a_subtitle_free_mkv_conversion_keeps_every_audio_track() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("two-audio.mkv");
    let out = tmp.path().join("out.mkv");
    make_multi_audio_source(&ffmpeg, &src, "aac");

    convert(&r, &request(&src, &out, TargetFormat::Mkv, None))
        .await
        .expect("mkv -> mkv with two audio tracks should succeed");

    assert!(
        stream_codecs(&r, &out, "s").is_empty(),
        "the source had no subtitles, so the output must gain none"
    );
    assert_eq!(stream_codecs(&r, &out, "a").len(), 2, "audio tracks");
}

#[tokio::test]
#[ignore]
async fn a_subtitle_free_mp4_conversion_keeps_every_vetted_audio_track() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("two-audio.mkv");
    let out = tmp.path().join("out.mp4");
    make_multi_audio_source(&ffmpeg, &src, "aac");

    convert(&r, &request(&src, &out, TargetFormat::Mp4, None))
        .await
        .expect("mkv -> mp4 with two AAC tracks should succeed");

    assert_eq!(stream_codecs(&r, &out, "a").len(), 2, "audio tracks");
    // Both must land on the real AAC mapping rather than merely being
    // present — see `audio_tags`.
    assert_eq!(audio_tags(&r, &out), vec!["mp4a", "mp4a"]);
}

#[tokio::test]
#[ignore]
async fn a_subtitle_free_re_encode_keeps_every_audio_track() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("two-audio.mkv");
    let out = tmp.path().join("out.mp4");
    // Vorbis is deliberately unvettable for a *copy* into MP4; re-encoding
    // rewrites every mapped stream into one known-good codec, which is what
    // makes the wide map safe regardless of what the source carried.
    make_multi_audio_source(&ffmpeg, &src, "libvorbis");

    let mut req = request(&src, &out, TargetFormat::Mp4, None);
    req.quality_preset = Some(goop_core::QualityPreset::Fast);
    convert(&r, &req).await.expect("mkv -> mp4 re-encode");

    assert_eq!(stream_codecs(&r, &out, "a").len(), 2, "audio tracks");
    assert_eq!(audio_tags(&r, &out), vec!["mp4a", "mp4a"]);
}

#[tokio::test]
#[ignore]
async fn an_unvettable_second_audio_track_is_dropped_not_corrupted() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);
    let src = tmp.path().join("two-audio.mkv");
    let out = tmp.path().join("out.mp4");
    make_multi_audio_source(&ffmpeg, &src, "libvorbis");

    // h264 + aac stream-copies into MP4, so nothing re-encodes the Vorbis
    // track into something MP4 can describe. Mapping it anyway boxes it
    // under the `mp4a` FourCC: the job still exits 0 and the file still
    // plays, right up until a player reaches a track it cannot decode.
    convert(&r, &request(&src, &out, TargetFormat::Mp4, None))
        .await
        .expect("the conversion must still succeed, just without the track");

    assert_eq!(
        stream_codecs(&r, &out, "a").len(),
        1,
        "an unvettable track must be left behind, not mis-tagged into the output"
    );
    assert_eq!(
        audio_tags(&r, &out),
        vec!["mp4a"],
        "the surviving track is the vetted AAC one"
    );
    assert_eq!(stream_codecs(&r, &out, "a"), vec!["aac"]);
}

// --- The rest of the per-container allowlists ---------------------------
//
// `an_unvettable_second_audio_track_is_dropped_not_corrupted` above guards
// MP4 end to end. The MOV, WebM and AVI lists were only ever checked against
// hardcoded strings in unit tests, which cannot notice that a *listed* codec
// is in fact mis-tagged by the muxer — the failure this whole allowlist
// exists to prevent. These drive real ffmpeg for the remaining three.
//
// Each container gets both directions: a listed codec must survive carrying
// a tag of its own, and an unlisted one must be left behind rather than
// written under a catch-all.

#[tokio::test]
#[ignore]
async fn mov_carries_a_listed_codec_and_leaves_an_unlisted_one_behind() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);

    // pcm_s16le is on MOV's list and not on MP4's, so it also pins the two
    // lists apart where it actually matters — in the muxed output.
    let listed = tmp.path().join("listed.mov");
    let src = tmp.path().join("mov-listed.mkv");
    make_multi_audio_source_as(&ffmpeg, &src, "libx264", "aac", "pcm_s16le");
    convert(&r, &request(&src, &listed, TargetFormat::Mov, None))
        .await
        .expect("mkv -> mov");
    assert_eq!(
        stream_codecs(&r, &listed, "a"),
        vec!["aac", "pcm_s16le"],
        "a listed codec must survive a copy into MOV"
    );
    let tags = audio_tags(&r, &listed);
    assert!(
        !tags.iter().any(|t| t == "mp4a") || tags[1] != "mp4a",
        "the PCM track must not land under the mp4a catch-all: {tags:?}"
    );

    let unlisted = tmp.path().join("unlisted.mov");
    let src2 = tmp.path().join("mov-unlisted.mkv");
    make_multi_audio_source_as(&ffmpeg, &src2, "libx264", "aac", "libvorbis");
    convert(&r, &request(&src2, &unlisted, TargetFormat::Mov, None))
        .await
        .expect("the conversion must still succeed, just without the track");
    assert_eq!(
        stream_codecs(&r, &unlisted, "a"),
        vec!["aac"],
        "an unlisted codec must be left behind rather than mis-tagged"
    );
}

#[tokio::test]
#[ignore]
async fn webm_carries_a_listed_codec_and_leaves_an_unlisted_one_behind() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);

    // VP9 + Opus so the plan is a genuine stream copy; h264 or AAC would
    // force an encode and the allowlist would never be consulted.
    //
    // The sources are `.mkv` rather than `.webm` because the WebM *muxer*
    // refuses the very tracks these cases need to carry — an AAC second
    // track cannot be written into a `.webm` at all, so the fixture could
    // not be authored. Matroska holds every combination, which is the
    // point of using it as the source container.
    let listed = tmp.path().join("listed.webm");
    let src = tmp.path().join("webm-listed.mkv");
    make_multi_audio_source_as(&ffmpeg, &src, "libvpx-vp9", "libopus", "libvorbis");
    convert(&r, &request(&src, &listed, TargetFormat::Webm, None))
        .await
        .expect("webm -> webm");
    assert_eq!(
        stream_codecs(&r, &listed, "a"),
        vec!["opus", "vorbis"],
        "both of WebM's two listed codecs must survive"
    );

    // WebM aborts the mux outright on an unknown codec rather than
    // mis-tagging it, so the job would fail entirely without the narrowing.
    let unlisted = tmp.path().join("unlisted.webm");
    let src2 = tmp.path().join("webm-unlisted.mkv");
    make_multi_audio_source_as(&ffmpeg, &src2, "libvpx-vp9", "libopus", "aac");
    convert(&r, &request(&src2, &unlisted, TargetFormat::Webm, None))
        .await
        .expect("an unlisted track must not take the whole job down with it");
    assert_eq!(
        stream_codecs(&r, &unlisted, "a"),
        vec!["opus"],
        "an unlisted codec must be left behind, not aborted on"
    );
}

#[tokio::test]
#[ignore]
async fn avi_carries_a_listed_codec_and_leaves_an_unlisted_one_behind() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = bundled_resolver(links.path());
    let ffmpeg = ffmpeg_path(&r);

    // mpeg4 video with mp3 as the *first* audio stream, which is the only
    // combination `plan_avi` stream-copies — and a copy is the only plan
    // where the allowlist applies at all, since a re-encode rewrites every
    // stream into one known-good codec.
    //
    // Anything else takes `plan_avi_encode`, which names `libxvid`. The
    // bundled ffmpeg is not built with it, so those conversions fail
    // outright: a separate, pre-existing bug that makes AVI an offered
    // target which cannot convert an ordinary h264 video.
    let listed = tmp.path().join("listed.avi");
    let src = tmp.path().join("avi-listed.avi");
    make_multi_audio_source_as(&ffmpeg, &src, "mpeg4", "libmp3lame", "aac");
    convert(&r, &request(&src, &listed, TargetFormat::Avi, None))
        .await
        .expect("avi -> avi");
    assert_eq!(
        stream_codecs(&r, &listed, "a"),
        vec!["mp3", "aac"],
        "a listed codec must survive a copy into AVI"
    );

    let unlisted = tmp.path().join("unlisted.avi");
    let src2 = tmp.path().join("avi-unlisted.avi");
    make_multi_audio_source_as(&ffmpeg, &src2, "mpeg4", "libmp3lame", "libvorbis");
    convert(&r, &request(&src2, &unlisted, TargetFormat::Avi, None))
        .await
        .expect("the conversion must still succeed, just without the track");
    assert_eq!(
        stream_codecs(&r, &unlisted, "a"),
        vec!["mp3"],
        "an unlisted codec must be left behind rather than mis-tagged"
    );
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
