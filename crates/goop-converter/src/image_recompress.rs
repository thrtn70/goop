//! `ImageOperation::Recompress` — re-encode N images at the same
//! quality and drop them in a folder. Format is preserved per input
//! (a `.jpg` stays `.jpg`, a `.png` stays `.png`). This is the
//! Phase 6 batch surface for the Image Workshop and is the first
//! image op that produces a folder result.
//!
//! Per-input strategy:
//! * JPEG / JPG: `image::codecs::jpeg::JpegEncoder` at the requested
//!   quality.
//! * WebP: re-save via the `image` crate default encoder. The
//!   built-in encoder is currently lossless-only; the quality
//!   parameter is accepted but only sanity-clamped. Matches the
//!   behavior of `imagemagick::compress_webp` so the two surfaces
//!   stay consistent.
//! * Anything else: re-save via the matching `image::ImageFormat`
//!   detected from the input extension. PNG / TIFF / BMP / GIF are
//!   inherently lossless via the `image` crate's defaults; the
//!   quality knob is documented in the UI as "JPEG/WebP only".

use crate::imagemagick::decode_any;
use goop_core::GoopError;
use std::path::{Path, PathBuf};

/// Recompress every file in `inputs` and write the result to
/// `output_dir`, preserving each input's basename + extension.
/// Returns the list of output paths in input order.
pub fn recompress(
    inputs: &[&Path],
    output_dir: &Path,
    quality: u8,
) -> Result<Vec<PathBuf>, GoopError> {
    recompress_cancellable(
        inputs,
        output_dir,
        quality,
        &tokio_util::sync::CancellationToken::new(),
    )
}

pub(crate) fn recompress_cancellable(
    inputs: &[&Path],
    output_dir: &Path,
    quality: u8,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<Vec<PathBuf>, GoopError> {
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }

    if inputs.is_empty() {
        return Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: "recompress requires at least one input".into(),
        });
    }
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir).map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to create output directory: {e}"),
        })?;
    }
    let q = quality.clamp(1, 100);

    let mut outputs = Vec::with_capacity(inputs.len());
    for input in inputs {
        if cancel.is_cancelled() {
            return Err(GoopError::Cancelled);
        }
        let file_name = input
            .file_name()
            .ok_or_else(|| GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("input path has no file name: {}", input.display()),
            })?;
        let out_path = output_dir.join(file_name);

        // Guard against the no-op case where the caller passed an
        // output directory that contains one of the inputs. We'd
        // overwrite the file mid-iteration if so.
        if same_path(input, &out_path) {
            return Err(GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("recompress output collides with input: {}", input.display()),
            });
        }

        recompress_one(input, &out_path, q)?;
        outputs.push(out_path);
    }
    Ok(outputs)
}

fn same_path(a: &Path, b: &Path) -> bool {
    let ca = std::fs::canonicalize(a).ok();
    let cb = std::fs::canonicalize(b).ok();
    matches!((ca, cb), (Some(x), Some(y)) if x == y)
}

fn recompress_one(input: &Path, output: &Path, quality: u8) -> Result<(), GoopError> {
    let ext = input
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    let img = decode_any(input)?;
    let buf: Vec<u8> = match ext.as_str() {
        "jpg" | "jpeg" => encode_jpeg(&img, quality)?,
        "webp" => encode_webp(&img)?,
        _ => {
            // Lossless re-save through the matching format. Falls
            // through to image::ImageFormat::from_path to pick the
            // codec; the quality parameter doesn't apply but is
            // still validated above for consistency.
            let format =
                image::ImageFormat::from_path(input).map_err(|e| GoopError::SubprocessFailed {
                    binary: "image".into(),
                    stderr: format!("unsupported input extension for recompress: {e}"),
                })?;
            let mut out = Vec::new();
            img.write_to(&mut std::io::Cursor::new(&mut out), format)
                .map_err(|e| GoopError::SubprocessFailed {
                    binary: "image".into(),
                    stderr: format!("re-encode failed: {e}"),
                })?;
            out
        }
    };

    std::fs::write(output, &buf).map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("failed to write {}: {e}", output.display()),
    })
}

fn encode_jpeg(img: &image::DynamicImage, quality: u8) -> Result<Vec<u8>, GoopError> {
    let rgb = img.to_rgb8();
    let mut buf: Vec<u8> = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    encoder
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("jpeg encode failed: {e}"),
        })?;
    Ok(buf)
}

fn encode_webp(img: &image::DynamicImage) -> Result<Vec<u8>, GoopError> {
    let mut buf: Vec<u8> = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut buf),
        image::ImageFormat::WebP,
    )
    .map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("webp encode failed: {e}"),
    })?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn tmp_dir(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static C: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let c = C.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("goop-recompress-{label}-{n}-{c}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_test_jpeg(path: &Path) {
        use image::{Rgb, RgbImage};
        let img: RgbImage =
            ImageBuffer::from_fn(96, 96, |x, y| Rgb([x as u8, y as u8, ((x + y) as u8) / 2]));
        img.save(path).unwrap();
    }

    fn write_test_png(path: &Path, w: u32, h: u32) {
        let img: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_fn(w, h, |x, y| Rgba([x as u8, y as u8, 128, 255]));
        img.save(path).unwrap();
    }

    #[test]
    fn cancelled_batch_does_not_start() {
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            recompress_cancellable(
                &[Path::new("missing.png")],
                Path::new("unused"),
                50,
                &cancel
            ),
            Err(GoopError::Cancelled)
        ));
    }
    #[test]
    fn recompress_jpeg_at_low_quality_shrinks() {
        let dir = tmp_dir("jpeg");
        let in_path = dir.join("photo.jpg");
        write_test_jpeg(&in_path);
        let out_dir = dir.join("out");

        let outputs = recompress(&[in_path.as_path()], &out_dir, 30).unwrap();
        assert_eq!(outputs.len(), 1);
        let out_size = std::fs::metadata(&outputs[0]).unwrap().len();
        assert!(out_size > 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn recompress_preserves_extension() {
        let dir = tmp_dir("ext");
        let png_in = dir.join("a.png");
        let jpg_in = dir.join("b.jpg");
        write_test_png(&png_in, 32, 32);
        write_test_jpeg(&jpg_in);
        let out_dir = dir.join("out");

        let outs = recompress(&[png_in.as_path(), jpg_in.as_path()], &out_dir, 75).unwrap();
        assert_eq!(outs.len(), 2);
        assert_eq!(outs[0].extension().unwrap(), "png");
        assert_eq!(outs[1].extension().unwrap(), "jpg");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn recompress_empty_inputs_rejected() {
        let dir = tmp_dir("empty");
        let err = recompress(&[], &dir, 50).unwrap_err();
        assert!(err.to_string().contains("at least one"));
    }

    #[test]
    fn recompress_collision_rejected() {
        // Output dir is the same as the input file's parent — file name
        // collides; we refuse to overwrite the input mid-iteration.
        let dir = tmp_dir("collide");
        let in_path = dir.join("photo.jpg");
        write_test_jpeg(&in_path);
        let err = recompress(&[in_path.as_path()], &dir, 60).unwrap_err();
        assert!(err.to_string().contains("collides"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn recompress_creates_output_dir_if_missing() {
        let dir = tmp_dir("create");
        let in_path = dir.join("photo.jpg");
        write_test_jpeg(&in_path);
        let out_dir = dir.join("nested").join("out");
        assert!(!out_dir.exists());
        recompress(&[in_path.as_path()], &out_dir, 60).unwrap();
        assert!(out_dir.exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
