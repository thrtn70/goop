//! Shared harness for the `#[ignore]`d real-ffmpeg integration tests.
//!
//! The point of these tests is to run the ffmpeg that actually *ships*,
//! so the resolver plumbing below (and the `source_is_path` assertion in
//! [`ffmpeg_path`] especially) has to live in one place rather than being
//! copy-pasted per test binary — a duplicated copy that quietly drifts
//! would let the suite pass against a `PATH` ffmpeg with a completely
//! different feature set, which is the exact failure mode these tests
//! exist to catch.

// Cargo compiles this module into every test binary under `tests/`, and no
// single binary uses all of it. Without this, `clippy --all-targets` fails
// the pre-push gate on helpers that are dead only from one binary's view.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use goop_converter::backend::ConversionBackend;
use goop_converter::FfmpegBackend;
use goop_core::{
    ConvertRequest, EventSink, JobId, ProgressEvent, QueueEvent, SidecarEvent, SubtitleOptions,
    TargetFormat,
};
use goop_sidecar::BinaryResolver;
use tokio_util::sync::CancellationToken;

pub struct SilentSink;

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
pub fn bundled_resolver(link_dir: &Path) -> BinaryResolver {
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

pub fn ffmpeg_path(r: &BinaryResolver) -> PathBuf {
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

pub fn ffprobe_path(r: &BinaryResolver) -> PathBuf {
    let resolved = r
        .resolve("ffprobe")
        .expect("ffprobe must be resolvable for this ignored test");
    assert!(
        !resolved.source_is_path,
        "expected the bundled sidecar, got {} from PATH — run scripts/fetch-sidecars.sh",
        resolved.path.display()
    );
    resolved.path
}

/// A 2-second colour clip with a silent audio track.
pub fn make_source(ffmpeg: &Path, out: &Path) {
    make_source_sized(ffmpeg, out, 160, 120);
}

/// [`make_source`] at an explicit frame size.
///
/// A resolution cap only *caps* when the source is larger than it, so the
/// 160x120 default would let a capped conversion pass by upscaling — which
/// proves nothing about the filter and would bake the wrong expectation
/// into the assertion.
pub fn make_source_sized(ffmpeg: &Path, out: &Path, w: u32, h: u32) {
    let size = format!("testsrc=s={w}x{h}:d=2");
    let status = Command::new(ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            &size,
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

/// A video plus three independently addressable AAC tracks.
///
/// The first two tracks deliberately share a language tag while the third
/// omits it. Titles and default/forced dispositions remain distinct so the
/// inventory assertions cannot accidentally pass by relying on display text.
pub fn make_diagnostic_track_source(ffmpeg: &Path, out: &Path) {
    let status = Command::new(ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=16x16:r=10:d=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=660:sample_rate=48000:duration=1",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-map",
            "2:a:0",
            "-map",
            "3:a:0",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-metadata:s:a:0",
            "language=eng",
            "-metadata:s:a:0",
            "title=Main",
            "-metadata:s:a:1",
            "language=eng",
            "-metadata:s:a:1",
            "title=Commentary",
            "-metadata:s:a:2",
            "title=No language",
            "-disposition:a:0",
            "default",
            "-disposition:a:1",
            "forced",
            "-disposition:a:2",
            "0",
            "-shortest",
        ])
        .arg(out)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "failed to build the diagnostic track fixture"
    );
}

/// Two tones whose codecs differ specifically in M4A copy compatibility.
pub fn make_mixed_copy_track_source(ffmpeg: &Path, out: &Path) {
    let status = Command::new(ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=1",
            "-map",
            "0:a:0",
            "-map",
            "1:a:0",
            "-c:a:0",
            "aac",
            "-c:a:1",
            "flac",
            "-metadata:s:a:0",
            "title=AAC tone",
            "-metadata:s:a:1",
            "title=FLAC tone",
            "-disposition:a:0",
            "default",
            "-disposition:a:1",
            "0",
        ])
        .arg(out)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "failed to build the mixed-copy track fixture"
    );
}

pub fn probe_streams_json(r: &BinaryResolver, out: &Path) -> serde_json::Value {
    let output = Command::new(ffprobe_path(r))
        .args(["-v", "error", "-show_streams", "-of", "json"])
        .arg(out)
        .output()
        .unwrap();
    assert!(output.status.success(), "bundled ffprobe failed");
    serde_json::from_slice(&output.stdout).expect("ffprobe stream JSON")
}

pub fn decoded_audio_f32(r: &BinaryResolver, path: &Path, sample_rate_hz: u32) -> Vec<f32> {
    let output = Command::new(ffmpeg_path(r))
        .args(["-v", "error", "-i"])
        .arg(path)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-ac",
            "1",
            "-ar",
            &sample_rate_hz.to_string(),
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "failed to decode selected audio");
    assert!(
        !output.stdout.is_empty(),
        "decoded selected audio was empty"
    );
    assert_eq!(output.stdout.len() % 4, 0);
    output
        .stdout
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect()
}

pub fn tone_magnitude(samples: &[f32], sample_rate_hz: f64, frequency_hz: f64) -> f64 {
    let (sine, cosine) =
        samples
            .iter()
            .enumerate()
            .fold((0.0, 0.0), |(sine, cosine), (index, sample)| {
                let phase = std::f64::consts::TAU * frequency_hz * index as f64 / sample_rate_hz;
                let sample = f64::from(*sample);
                (sine + sample * phase.sin(), cosine + sample * phase.cos())
            });
    sine.hypot(cosine) / samples.len() as f64
}

/// Codec names of `out`'s streams of type `kind` ("v", "a", "s"), in order.
pub fn stream_codecs(r: &BinaryResolver, out: &Path, kind: &str) -> Vec<String> {
    probe_entries(r, out, kind, "stream=codec_name")
}

/// FourCC / codec tags of `out`'s streams of type `kind`, in order.
pub fn stream_tags(r: &BinaryResolver, out: &Path, kind: &str) -> Vec<String> {
    probe_entries(r, out, kind, "stream=codec_tag_string")
}

/// `(width, height)` of `out`'s first video stream.
pub fn video_dimensions(r: &BinaryResolver, out: &Path) -> (u32, u32) {
    let entries = probe_entries(r, out, "v:0", "stream=width,height");
    // `csv=p=0` puts both values on one line for a single stream.
    let line = entries.first().expect("no video stream to measure");
    let (w, h) = line.split_once(',').expect("expected 'width,height'");
    (w.parse().expect("width"), h.parse().expect("height"))
}

fn probe_entries(r: &BinaryResolver, out: &Path, kind: &str, entries: &str) -> Vec<String> {
    let probe = Command::new(ffprobe_path(r))
        .args([
            "-v",
            "error",
            "-select_streams",
            kind,
            "-show_entries",
            entries,
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

pub fn request(
    input: &Path,
    output: &Path,
    target: TargetFormat,
    sub: Option<SubtitleOptions>,
) -> ConvertRequest {
    ConvertRequest {
        audio_options: None,
        track_options: None,
        video_options: None,
        input_path: input.to_string_lossy().into_owned(),
        output_path: output.to_string_lossy().into_owned(),
        target,
        quality_preset: None,
        resolution_cap: None,
        gif_options: None,
        compress_mode: None,
        batch_id: None,
        metadata_policy: None,
        image_color_policy: None,
        subtitle: sub,
        image_options: None,
    }
}

pub async fn convert(r: &BinaryResolver, req: &ConvertRequest) -> Result<(), goop_core::GoopError> {
    FfmpegBackend::new(r, Arc::new(SilentSink))
        .convert(JobId::new(), req, CancellationToken::new())
        .await
        .map(|_| ())
}
