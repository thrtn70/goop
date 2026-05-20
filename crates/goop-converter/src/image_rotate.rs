//! `ImageOperation::Rotate` — rotate a single image 90 / 180 / 270
//! degrees clockwise and write to a new file. Arbitrary-angle rotation is
//! deferred to v0.2.6 (needs sub-pixel interpolation + transparent fill).
//!
//! Decode goes through `imagemagick::decode_any` so HEIC and JPEG-XL
//! inputs are supported in addition to the `image` crate's native set.
//! Encode goes through `imagemagick::save_image` which dispatches by
//! output-path extension (JXL via `jpegxl-rs`, everything else via the
//! `image` crate).

use crate::imagemagick::{decode_any, save_image};
use goop_core::{GoopError, RotationDegrees};
use std::path::Path;

/// Rotate `input` by `degrees` (clockwise) and write to `output`.
///
/// The output codec is inferred from `output`'s extension; the input
/// pixel data is preserved (8-bit RGB / RGBA depending on source) so a
/// quality-lossy round-trip is not implied — JPEG out will still be
/// re-encoded, but PNG / TIFF stay lossless.
pub fn rotate(input: &Path, degrees: RotationDegrees, output: &Path) -> Result<(), GoopError> {
    let img = decode_any(input)?;
    let rotated = match degrees {
        RotationDegrees::Cw90 => img.rotate90(),
        RotationDegrees::Cw180 => img.rotate180(),
        RotationDegrees::Cw270 => img.rotate270(),
    };
    save_image(&rotated, output)
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
            .unwrap()
            .as_nanos();
        let c = C.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("goop-rotate-{label}-{n}-{c}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_test_png(path: &Path, w: u32, h: u32) {
        let img: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_fn(w, h, |x, y| Rgba([x as u8, y as u8, 128, 255]));
        img.save(path).unwrap();
    }

    #[test]
    fn rotate_90_swaps_dimensions() {
        let dir = tmp_dir("90");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 40, 20);
        let out_path = dir.join("out.png");

        rotate(&in_path, RotationDegrees::Cw90, &out_path).unwrap();

        let result = image::open(&out_path).unwrap();
        assert_eq!(result.width(), 20);
        assert_eq!(result.height(), 40);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rotate_180_preserves_dimensions() {
        let dir = tmp_dir("180");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 40, 20);
        let out_path = dir.join("out.png");

        rotate(&in_path, RotationDegrees::Cw180, &out_path).unwrap();

        let result = image::open(&out_path).unwrap();
        assert_eq!(result.width(), 40);
        assert_eq!(result.height(), 20);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rotate_270_swaps_dimensions() {
        let dir = tmp_dir("270");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 40, 20);
        let out_path = dir.join("out.png");

        rotate(&in_path, RotationDegrees::Cw270, &out_path).unwrap();

        let result = image::open(&out_path).unwrap();
        assert_eq!(result.width(), 20);
        assert_eq!(result.height(), 40);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rotate_to_jpeg_succeeds() {
        // Exercise the save dispatch through the image crate's JPEG codec.
        let dir = tmp_dir("to-jpeg");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 32, 16);
        let out_path = dir.join("out.jpg");

        rotate(&in_path, RotationDegrees::Cw90, &out_path).unwrap();
        assert!(std::fs::metadata(&out_path).unwrap().len() > 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rotate_missing_extension_returns_error() {
        let dir = tmp_dir("no-ext");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 8, 8);
        let out_path = dir.join("noext");

        let err = rotate(&in_path, RotationDegrees::Cw90, &out_path).unwrap_err();
        assert!(err.to_string().to_lowercase().contains("extension"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
