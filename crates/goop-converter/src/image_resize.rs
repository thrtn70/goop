//! `ImageOperation::Resize` — change the pixel dimensions of a single
//! image using `image::imageops::FilterType::Lanczos3` (best quality
//! built-in filter; matches the `AppIcon` resampler chosen for Phase 7).
//!
//! Three modes:
//! * `FitWithin` — preserve aspect ratio, fit inside `(width, height)`.
//!   May come out smaller in one dimension.
//! * `FitExact` — force exactly `(width, height)` even if the aspect
//!   ratio changes (squashes / stretches).
//! * `Scale` — treat `width` as a percentage (e.g. 50 = 50%); `height`
//!   is ignored. Useful for "make this image 75% of its current size".

use crate::imagemagick::{decode_any, save_image};
use goop_core::{GoopError, ResizeMode};
use image::imageops::FilterType;
use std::path::Path;

const FILTER: FilterType = FilterType::Lanczos3;

/// Resize `input` to a target dimension per `mode` and write to `output`.
/// The output codec is inferred from `output`'s extension via
/// `save_image`.
///
/// Field interpretation by mode:
/// * `FitWithin` / `FitExact` — both `width` and `height` are pixel
///   dimensions and must be > 0.
/// * `Scale` — `width` is the percentage (1..=2000). `height` is
///   **ignored**; callers should pass 0 as a marker so a future code
///   reader doesn't assume it's load-bearing. (The wire enum can't
///   express "Scale takes one field, others take two" without two
///   variants; the field choice keeps the IPC payload small.)
pub fn resize(
    input: &Path,
    width: u32,
    height: u32,
    mode: ResizeMode,
    output: &Path,
) -> Result<(), GoopError> {
    let img = decode_any(input)?;

    let resized = match mode {
        ResizeMode::FitWithin => {
            let (w, h) = sanitize_target(width, height)?;
            img.resize(w, h, FILTER)
        }
        ResizeMode::FitExact => {
            let (w, h) = sanitize_target(width, height)?;
            img.resize_exact(w, h, FILTER)
        }
        ResizeMode::Scale => {
            let pct = width;
            if !(1..=2000).contains(&pct) {
                return Err(GoopError::SubprocessFailed {
                    binary: "image".into(),
                    stderr: format!("resize scale percentage out of range (1..=2000): {pct}"),
                });
            }
            let new_w = ((u64::from(img.width()) * u64::from(pct)) / 100).max(1) as u32;
            let new_h = ((u64::from(img.height()) * u64::from(pct)) / 100).max(1) as u32;
            // Mirror the 32_768 cap on the other two modes so a huge
            // input + large percentage can't OOM the resampler with a
            // dimensions value the user couldn't enter directly.
            if new_w > 32_768 || new_h > 32_768 {
                return Err(GoopError::SubprocessFailed {
                    binary: "image".into(),
                    stderr: format!(
                        "resize scale result too large (max 32768; got {new_w}×{new_h} at {pct}%)"
                    ),
                });
            }
            img.resize_exact(new_w, new_h, FILTER)
        }
    };

    save_image(&resized, output)
}

/// Guard against zero / overflow inputs that would either panic the
/// `image` resampler or produce a 1×1 placeholder the user didn't ask
/// for. 32_768 is an arbitrary "this is way too big" upper bound — the
/// goal is to fail loudly rather than thrash memory on a runaway value.
fn sanitize_target(width: u32, height: u32) -> Result<(u32, u32), GoopError> {
    if width == 0 || height == 0 {
        return Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!(
                "resize target dimensions must be > 0 (got width={width} height={height})"
            ),
        });
    }
    if width > 32_768 || height > 32_768 {
        return Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!(
                "resize target dimensions too large (max 32768; got width={width} height={height})"
            ),
        });
    }
    Ok((width, height))
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
        let p = std::env::temp_dir().join(format!("goop-resize-{label}-{n}-{c}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_test_png(path: &Path, w: u32, h: u32) {
        let img: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_fn(w, h, |x, y| Rgba([x as u8, y as u8, 128, 255]));
        img.save(path).unwrap();
    }

    #[test]
    fn fit_within_preserves_aspect_ratio() {
        // 200×100 (2:1) into 100×100 should produce 100×50.
        let dir = tmp_dir("fit-within");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 200, 100);
        let out_path = dir.join("out.png");

        resize(&in_path, 100, 100, ResizeMode::FitWithin, &out_path).unwrap();

        let result = image::open(&out_path).unwrap();
        assert_eq!(result.width(), 100);
        assert_eq!(result.height(), 50);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fit_exact_ignores_aspect_ratio() {
        let dir = tmp_dir("fit-exact");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 200, 100);
        let out_path = dir.join("out.png");

        resize(&in_path, 50, 50, ResizeMode::FitExact, &out_path).unwrap();

        let result = image::open(&out_path).unwrap();
        assert_eq!(result.width(), 50);
        assert_eq!(result.height(), 50);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scale_50_percent_halves_dimensions() {
        let dir = tmp_dir("scale-50");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 200, 100);
        let out_path = dir.join("out.png");

        resize(&in_path, 50, 0, ResizeMode::Scale, &out_path).unwrap();

        let result = image::open(&out_path).unwrap();
        assert_eq!(result.width(), 100);
        assert_eq!(result.height(), 50);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scale_200_percent_doubles_dimensions() {
        let dir = tmp_dir("scale-200");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 50, 25);
        let out_path = dir.join("out.png");

        resize(&in_path, 200, 0, ResizeMode::Scale, &out_path).unwrap();

        let result = image::open(&out_path).unwrap();
        assert_eq!(result.width(), 100);
        assert_eq!(result.height(), 50);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn zero_width_rejected() {
        let dir = tmp_dir("zero-w");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 10, 10);
        let out_path = dir.join("out.png");

        let err = resize(&in_path, 0, 10, ResizeMode::FitExact, &out_path).unwrap_err();
        assert!(err.to_string().contains("> 0"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scale_zero_pct_rejected() {
        let dir = tmp_dir("scale-zero");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 10, 10);
        let out_path = dir.join("out.png");

        let err = resize(&in_path, 0, 0, ResizeMode::Scale, &out_path).unwrap_err();
        assert!(err.to_string().contains("range"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn excessive_dimension_rejected() {
        let dir = tmp_dir("too-big");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 10, 10);
        let out_path = dir.join("out.png");

        let err = resize(&in_path, 50_000, 50_000, ResizeMode::FitExact, &out_path).unwrap_err();
        assert!(err.to_string().contains("too large"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
