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
    let ffprobe = r.resolve("ffprobe").expect("ffprobe").path;
    let probe = Command::new(ffprobe)
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

pub async fn convert(r: &BinaryResolver, req: &ConvertRequest) -> Result<(), goop_core::GoopError> {
    FfmpegBackend::new(r, Arc::new(SilentSink))
        .convert(JobId::new(), req, CancellationToken::new())
        .await
        .map(|_| ())
}
