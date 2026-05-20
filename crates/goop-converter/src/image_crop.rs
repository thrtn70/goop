//! `ImageOperation::Crop` — extract a rectangular region from a single
//! image and write to a new file. Coordinates are in source-image
//! pixels with the origin at the top-left. Out-of-bounds rectangles
//! are clamped to the image extent so a UI that drags slightly past
//! the edge still produces a usable output instead of an error.
//!
//! Decode goes through `imagemagick::decode_any` (HEIC + JPEG-XL +
//! `image` crate native set). Encode goes through
//! `imagemagick::save_image` which dispatches by output-path
//! extension.

use crate::imagemagick::{decode_any, save_image};
use goop_core::{CropRect, GoopError};
use std::path::Path;

/// Crop `input` to `rect` (pixel coordinates) and write to `output`.
///
/// If `rect` extends past the source bounds, it is clamped so the
/// resulting image is the intersection of `rect` with the source
/// rectangle. A rect that lands fully outside the source (e.g.
/// `x >= width`) returns `EmptyCrop` — the alternative would be a
/// zero-byte file, which the user can't open.
pub fn crop(input: &Path, rect: CropRect, output: &Path) -> Result<(), GoopError> {
    let img = decode_any(input)?;
    let src_w = img.width();
    let src_h = img.height();

    if rect.x >= src_w || rect.y >= src_h {
        return Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!(
                "crop rectangle starts outside the source image: \
                 rect.x={} rect.y={} but source is {src_w}×{src_h}",
                rect.x, rect.y
            ),
        });
    }
    if rect.width == 0 || rect.height == 0 {
        return Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!(
                "crop rectangle has zero area: width={} height={}",
                rect.width, rect.height
            ),
        });
    }

    let clamped_w = rect.width.min(src_w - rect.x);
    let clamped_h = rect.height.min(src_h - rect.y);

    let cropped = img.crop_imm(rect.x, rect.y, clamped_w, clamped_h);
    save_image(&cropped, output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use std::path::PathBuf;

    fn tmp_dir(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static C: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let c = C.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("goop-crop-{label}-{n}-{c}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_test_png(path: &Path, w: u32, h: u32) {
        let img: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_fn(w, h, |x, y| Rgba([x as u8, y as u8, 128, 255]));
        img.save(path).unwrap();
    }

    #[test]
    fn crop_exact_subregion() {
        let dir = tmp_dir("exact");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 100, 50);
        let out_path = dir.join("out.png");

        crop(
            &in_path,
            CropRect {
                x: 10,
                y: 5,
                width: 40,
                height: 20,
            },
            &out_path,
        )
        .unwrap();

        let result = image::open(&out_path).unwrap();
        assert_eq!(result.width(), 40);
        assert_eq!(result.height(), 20);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn crop_clamps_overflow_to_source() {
        let dir = tmp_dir("clamp");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 100, 50);
        let out_path = dir.join("out.png");

        // Rect starts at (80, 30) and is 50 wide × 50 tall — should
        // clamp to (20, 20) so the result fits inside the source.
        crop(
            &in_path,
            CropRect {
                x: 80,
                y: 30,
                width: 50,
                height: 50,
            },
            &out_path,
        )
        .unwrap();

        let result = image::open(&out_path).unwrap();
        assert_eq!(result.width(), 20);
        assert_eq!(result.height(), 20);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn crop_origin_outside_source_rejected() {
        let dir = tmp_dir("outside");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 100, 50);
        let out_path = dir.join("out.png");

        let err = crop(
            &in_path,
            CropRect {
                x: 200,
                y: 0,
                width: 10,
                height: 10,
            },
            &out_path,
        )
        .unwrap_err();
        assert!(err.to_string().contains("outside the source"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn crop_zero_width_rejected() {
        let dir = tmp_dir("zero-w");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 10, 10);
        let out_path = dir.join("out.png");

        let err = crop(
            &in_path,
            CropRect {
                x: 0,
                y: 0,
                width: 0,
                height: 5,
            },
            &out_path,
        )
        .unwrap_err();
        assert!(err.to_string().contains("zero area"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn crop_to_jpeg_succeeds() {
        let dir = tmp_dir("to-jpeg");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 64, 64);
        let out_path = dir.join("out.jpg");

        crop(
            &in_path,
            CropRect {
                x: 0,
                y: 0,
                width: 32,
                height: 32,
            },
            &out_path,
        )
        .unwrap();
        assert!(std::fs::metadata(&out_path).unwrap().len() > 0);
        std::fs::remove_dir_all(&dir).ok();
    }
}
