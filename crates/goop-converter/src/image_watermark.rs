//! `ImageOperation::Watermark` — overlay a text watermark on a single
//! image. v0.2.5 ships text-only watermarks; image-overlay variants
//! defer to v0.2.6. Composition is straight RGBA blending in the
//! input's color space — no ICC handling.
//!
//! Font is `Roboto Regular` (Apache-2.0) bundled via `include_bytes!`
//! so the binary works without any system font dependency. The
//! `imageproc` crate handles glyph rasterization on top of `ab_glyph`.

use crate::imagemagick::{decode_any, save_image};
use ab_glyph::{FontRef, PxScale};
use goop_core::{GoopError, WatermarkPosition, WatermarkSpec};
use image::{Rgba, RgbaImage};
use imageproc::drawing::draw_text_mut;
use std::path::Path;

const FONT_BYTES: &[u8] = include_bytes!("../assets/Roboto-Regular.ttf");
const PADDING_RATIO: f32 = 0.025;

/// Overlay a text watermark on `input` and write to `output`. `spec`
/// carries the text, anchor, and opacity (0..=100). The watermark
/// scales with the image so it stays readable across input sizes —
/// the font size is roughly 3.5% of the image's smaller dimension.
pub fn watermark(input: &Path, spec: &WatermarkSpec, output: &Path) -> Result<(), GoopError> {
    if spec.text.is_empty() {
        return Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: "watermark text must be non-empty".into(),
        });
    }

    let img = decode_any(input)?;
    let mut canvas: RgbaImage = img.to_rgba8();
    let (w, h) = canvas.dimensions();

    let font = FontRef::try_from_slice(FONT_BYTES).map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("failed to load watermark font: {e}"),
    })?;

    let opacity = spec.opacity.clamp(0, 100);
    let alpha = ((u32::from(opacity) * 255) / 100) as u8;
    // White text reads on both dark and light backgrounds; black would
    // disappear on dark photos. A future enhancement could pick the
    // colour from the local image patch behind the watermark.
    let color = Rgba([255u8, 255u8, 255u8, alpha]);

    // Scale font to ~3.5% of the smaller dimension; min 16px so tiny
    // images still show a legible watermark.
    let scale_px = ((w.min(h) as f32) * 0.035).max(16.0);
    let scale = PxScale::from(scale_px);

    let (text_w, text_h) = measure_text(&font, scale, &spec.text);
    let padding = ((w.min(h) as f32) * PADDING_RATIO).max(8.0) as i32;
    let (x, y) = anchor_for(spec.position, w as i32, h as i32, text_w, text_h, padding);

    draw_text_mut(&mut canvas, color, x, y, scale, &font, &spec.text);

    save_image(&image::DynamicImage::ImageRgba8(canvas), output)
}

fn measure_text(font: &FontRef<'_>, scale: PxScale, text: &str) -> (i32, i32) {
    use ab_glyph::{Font, ScaleFont};
    let scaled = font.as_scaled(scale);
    let height = scaled.height().ceil() as i32;
    let mut total: f32 = 0.0;
    for c in text.chars() {
        let id = font.glyph_id(c);
        total += scaled.h_advance(id);
    }
    (total.ceil() as i32, height)
}

fn anchor_for(
    position: WatermarkPosition,
    canvas_w: i32,
    canvas_h: i32,
    text_w: i32,
    text_h: i32,
    padding: i32,
) -> (i32, i32) {
    match position {
        WatermarkPosition::TopLeft => (padding, padding),
        WatermarkPosition::TopRight => (canvas_w - text_w - padding, padding),
        WatermarkPosition::BottomLeft => (padding, canvas_h - text_h - padding),
        WatermarkPosition::BottomRight => {
            (canvas_w - text_w - padding, canvas_h - text_h - padding)
        }
        WatermarkPosition::Center => ((canvas_w - text_w) / 2, (canvas_h - text_h) / 2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageBuffer;
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
        let p = std::env::temp_dir().join(format!("goop-watermark-{label}-{n}-{c}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_test_png(path: &Path, w: u32, h: u32) {
        // Mid-grey so a translucent white watermark is clearly visible
        // when manually inspecting the output.
        let img: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_fn(w, h, |_x, _y| Rgba([128, 128, 128, 255]));
        img.save(path).unwrap();
    }

    #[test]
    fn watermark_bottom_right_produces_visible_output() {
        let dir = tmp_dir("br");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 400, 200);
        let out_path = dir.join("out.png");

        let spec = WatermarkSpec {
            text: "© goop".into(),
            position: WatermarkPosition::BottomRight,
            opacity: 80,
        };
        watermark(&in_path, &spec, &out_path).unwrap();

        // Output exists and contains pixels brighter than the mid-grey
        // source, which means the white watermark was composited in.
        let result = image::open(&out_path).unwrap();
        let rgba = result.to_rgba8();
        assert!(
            rgba.pixels().any(|p| p.0[0] > 200),
            "expected at least one bright watermark pixel in output"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn watermark_empty_text_rejected() {
        let dir = tmp_dir("empty");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 100, 100);
        let out_path = dir.join("out.png");

        let spec = WatermarkSpec {
            text: String::new(),
            position: WatermarkPosition::Center,
            opacity: 50,
        };
        let err = watermark(&in_path, &spec, &out_path).unwrap_err();
        assert!(err.to_string().contains("non-empty"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn watermark_opacity_clamps_to_100() {
        let dir = tmp_dir("clamp");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 200, 100);
        let out_path = dir.join("out.png");

        let spec = WatermarkSpec {
            text: "x".into(),
            position: WatermarkPosition::Center,
            // Out-of-range value; the impl clamps to 100.
            opacity: 250,
        };
        watermark(&in_path, &spec, &out_path).unwrap();
        assert!(std::fs::metadata(&out_path).unwrap().len() > 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn anchor_for_top_left_uses_padding() {
        let (x, y) = anchor_for(WatermarkPosition::TopLeft, 1000, 500, 100, 30, 10);
        assert_eq!((x, y), (10, 10));
    }

    #[test]
    fn anchor_for_bottom_right_offsets_text() {
        let (x, y) = anchor_for(WatermarkPosition::BottomRight, 1000, 500, 100, 30, 10);
        // x = canvas_w - text_w - padding = 1000 - 100 - 10 = 890
        // y = canvas_h - text_h - padding = 500 - 30 - 10 = 460
        assert_eq!((x, y), (890, 460));
    }

    #[test]
    fn anchor_for_center_centers_text() {
        let (x, y) = anchor_for(WatermarkPosition::Center, 1000, 500, 100, 30, 10);
        // (canvas_w - text_w) / 2 = 450
        // (canvas_h - text_h) / 2 = 235
        assert_eq!((x, y), (450, 235));
    }
}
