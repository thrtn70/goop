use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::pdf::RotationDegrees;

/// Pixel-space rectangle for `ImageOperation::Crop`. Coordinates are in
/// source image pixels with the origin at the top-left of the image.
/// `width` and `height` must be positive; the backend clamps to image
/// bounds before invoking `DynamicImage::crop_imm`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// How a `Resize` operation handles the target box.
/// * `FitWithin` preserves aspect ratio and fits within (width, height) —
///   the result may be smaller than the target in one dimension.
/// * `FitExact` resizes to exactly (width, height), potentially
///   distorting aspect ratio.
/// * `Scale` interprets `width` as a percentage (e.g. 50 = 50%) and
///   ignores `height`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum ResizeMode {
    FitWithin,
    FitExact,
    Scale,
}

/// Anchor for a `Watermark` overlay relative to the image bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum WatermarkPosition {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    Center,
}

/// Text watermark specification. v0.2.5 ships text-only watermarks; image
/// overlay variants are deferred to v0.2.6. `opacity` is 0..=100 percent;
/// the backend clamps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct WatermarkSpec {
    pub text: String,
    pub position: WatermarkPosition,
    pub opacity: u8,
}

/// Target platform set for `ImageOperation::AppIcon`. Backend produces
/// the appropriate container per selection:
/// * `Macos` → `.icns` (Apple icon container)
/// * `Windows` → `.ico` (Windows icon container)
/// * `Web` → loose PNG files at standard favicon sizes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum IconPlatform {
    Macos,
    Windows,
    Web,
}

/// What to do with an image. Parallel to `PdfOperation`. The wire shape
/// uses `#[serde(tag = "kind", rename_all = "snake_case")]` so frontend
/// builders emit `{ kind: "rotate", ... }` payloads directly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImageOperation {
    /// Rotate a single image 90/180/270 degrees clockwise. Reuses
    /// `RotationDegrees` from `pdf` so PDF and image rotate UIs share
    /// the same wire variants.
    Rotate {
        input: String,
        degrees: RotationDegrees,
        output_path: String,
    },
    /// Resize a single image. `mode` controls aspect-ratio handling.
    Resize {
        input: String,
        width: u32,
        height: u32,
        mode: ResizeMode,
        output_path: String,
    },
    /// Crop a single image to `rect` (pixel coordinates).
    Crop {
        input: String,
        rect: CropRect,
        output_path: String,
    },
    /// Overlay a text watermark on a single image.
    Watermark {
        input: String,
        spec: WatermarkSpec,
        output_path: String,
    },
    /// Recompress N images at the same quality, output to `output_dir`
    /// (one file per input, format preserved). Quality is 1..=100; the
    /// backend clamps.
    Recompress {
        inputs: Vec<String>,
        output_dir: String,
        quality: u8,
    },
    /// Generate platform icon containers (.icns / .ico) and/or PNG sets
    /// from a single source image. `output_dir` receives the artifacts.
    AppIcon {
        input: String,
        output_dir: String,
        platforms: Vec<IconPlatform>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn roundtrip(op: &ImageOperation) -> ImageOperation {
        let v = serde_json::to_value(op).expect("serialize");
        serde_json::from_value(v).expect("deserialize")
    }

    #[test]
    fn rotate_serializes_with_snake_case_kind() {
        let op = ImageOperation::Rotate {
            input: "/in.png".into(),
            degrees: RotationDegrees::Cw90,
            output_path: "/out.png".into(),
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["kind"], json!("rotate"));
        assert_eq!(v["degrees"], json!("cw90"));
        assert_eq!(op, roundtrip(&op));
    }

    #[test]
    fn resize_carries_mode_and_dimensions() {
        let op = ImageOperation::Resize {
            input: "/in.png".into(),
            width: 800,
            height: 600,
            mode: ResizeMode::FitWithin,
            output_path: "/out.png".into(),
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["kind"], json!("resize"));
        assert_eq!(v["mode"], json!("fit_within"));
        assert_eq!(v["width"], json!(800));
        assert_eq!(v["height"], json!(600));
        assert_eq!(op, roundtrip(&op));
    }

    #[test]
    fn crop_carries_rect() {
        let op = ImageOperation::Crop {
            input: "/in.png".into(),
            rect: CropRect {
                x: 10,
                y: 20,
                width: 100,
                height: 200,
            },
            output_path: "/out.png".into(),
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["kind"], json!("crop"));
        assert_eq!(v["rect"]["x"], json!(10));
        assert_eq!(v["rect"]["width"], json!(100));
        assert_eq!(op, roundtrip(&op));
    }

    #[test]
    fn watermark_carries_spec_with_position() {
        let op = ImageOperation::Watermark {
            input: "/in.png".into(),
            spec: WatermarkSpec {
                text: "© 2026".into(),
                position: WatermarkPosition::BottomRight,
                opacity: 80,
            },
            output_path: "/out.png".into(),
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["kind"], json!("watermark"));
        assert_eq!(v["spec"]["position"], json!("bottom_right"));
        assert_eq!(v["spec"]["text"], json!("© 2026"));
        assert_eq!(v["spec"]["opacity"], json!(80));
        assert_eq!(op, roundtrip(&op));
    }

    #[test]
    fn recompress_carries_ordered_inputs_and_output_dir() {
        let op = ImageOperation::Recompress {
            inputs: vec!["/a.jpg".into(), "/b.jpg".into()],
            output_dir: "/out".into(),
            quality: 75,
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["kind"], json!("recompress"));
        assert_eq!(v["inputs"], json!(["/a.jpg", "/b.jpg"]));
        assert_eq!(v["output_dir"], json!("/out"));
        assert_eq!(v["quality"], json!(75));
        assert_eq!(op, roundtrip(&op));
    }

    #[test]
    fn app_icon_carries_platform_list() {
        let op = ImageOperation::AppIcon {
            input: "/logo.png".into(),
            output_dir: "/icons".into(),
            platforms: vec![
                IconPlatform::Macos,
                IconPlatform::Windows,
                IconPlatform::Web,
            ],
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["kind"], json!("app_icon"));
        assert_eq!(v["platforms"], json!(["macos", "windows", "web"]));
        assert_eq!(op, roundtrip(&op));
    }
}
