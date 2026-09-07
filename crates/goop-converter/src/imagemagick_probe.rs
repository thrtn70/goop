use goop_core::{GoopError, ProbeResult, SourceKind};
use image::ImageDecoder;
use std::path::Path;

/// Probe supported images with the same format dispatch as conversion.
/// HEIC reads headers; the JPEG library buffers encoded input while reading
/// headers. Explicit requests use their separate bounded snapshot admission.
/// JXL currently decodes pixels.
pub fn probe_image(path: &Path) -> Result<ProbeResult, GoopError> {
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(crate::raw::is_raw_extension)
    {
        return crate::raw::probe_raw(path);
    }
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let (width, height, image_format, image_has_alpha) = match ext.as_str() {
        "heic" | "heif" => {
            let path_str = path
                .to_str()
                .ok_or_else(|| probe_error("HEIC path is not valid UTF-8"))?;
            let context = libheif_rs::HeifContext::read_from_file(path_str)
                .map_err(|e| probe_error(format!("failed to read HEIC header: {e}")))?;
            let handle = context
                .primary_image_handle()
                .map_err(|e| probe_error(format!("failed to get primary HEIC dimensions: {e}")))?;
            (
                handle.width(),
                handle.height(),
                Some(crate::heif_header::primary_item_format(path, handle.item_id())?.into()),
                Some(handle.has_alpha_channel()),
            )
        }
        "jxl" => {
            // jpegxl-rs currently has no header-only API. Reuse the existing
            // decoder for consistent orientation and supported channel behavior.
            let image = crate::imagemagick::decode_any(path)?;
            (image.width(), image.height(), Some("JXL".into()), None)
        }
        _ => raster_dimensions(path)?,
    };
    let file_size = std::fs::metadata(path)?.len();

    Ok(image_probe_result(
        (width, height),
        image_format,
        image_has_alpha,
        file_size,
    ))
}

pub(crate) fn image_probe_result(
    (width, height): (u32, u32),
    image_format: Option<String>,
    image_has_alpha: Option<bool>,
    file_size: u64,
) -> ProbeResult {
    ProbeResult {
        duration_ms: 0,
        width: Some(width),
        height: Some(height),
        video_codec: None,
        audio_codec: None,
        file_size,
        container: None,
        has_video: false,
        has_audio: false,
        source_kind: SourceKind::Image,
        color_space: Some("sRGB".to_string()),
        image_format,
        has_subtitles: false,
        subtitle_codecs: vec![],
        audio_codecs: vec![],
        image_has_alpha,
    }
}

fn probe_error(message: impl Into<String>) -> GoopError {
    GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: message.into(),
    }
}

fn raster_dimensions(path: &Path) -> Result<(u32, u32, Option<String>, Option<bool>), GoopError> {
    let reader = image::ImageReader::open(path)
        .map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to open image: {e}"),
        })?
        .with_guessed_format()
        .map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to detect image format: {e}"),
        })?;

    let detected_format = reader.format();
    let format = detected_format.map(|value| format!("{value:?}"));
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to read image dimensions: {e}"),
        })?;
    let (mut width, mut height) = decoder.dimensions();
    let image_has_alpha = if detected_format == Some(image::ImageFormat::Jpeg) {
        let orientation = decoder
            .exif_metadata()
            .map_err(|e| probe_error(format!("failed to read JPEG metadata: {e}")))?
            .and_then(|bytes| crate::exif_geometry::orientation(&bytes).ok())
            .unwrap_or(image::metadata::Orientation::NoTransforms);
        if matches!(
            orientation,
            image::metadata::Orientation::Rotate90
                | image::metadata::Orientation::Rotate270
                | image::metadata::Orientation::Rotate90FlipH
                | image::metadata::Orientation::Rotate270FlipH
        ) {
            std::mem::swap(&mut width, &mut height);
        }
        Some(false)
    } else {
        None
    };

    Ok((width, height, format, image_has_alpha))
}

#[cfg(test)]
mod tests {
    use super::*;
    use img_parts::jpeg::Jpeg;
    use img_parts::{Bytes, ImageEXIF};
    use std::fs;

    fn write_test_png(path: &Path) {
        use image::{ImageBuffer, Rgba};
        let img = ImageBuffer::from_fn(8, 8, |x, y| {
            if (x + y) % 2 == 0 {
                Rgba([255u8, 0, 0, 255])
            } else {
                Rgba([0, 0, 255, 255])
            }
        });
        img.save(path).unwrap();
    }

    fn write_test_jpeg(path: &Path) {
        use image::{ImageBuffer, Rgb};
        let img: ImageBuffer<Rgb<u8>, _> =
            ImageBuffer::from_fn(16, 16, |_, _| Rgb([128, 128, 128]));
        img.save(path).unwrap();
    }

    #[test]
    fn probes_png_dimensions() {
        let dir = std::env::temp_dir().join(format!("goop-img-probe-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.png");
        write_test_png(&path);

        let result = probe_image(&path).unwrap();
        assert_eq!(result.width, Some(8));
        assert_eq!(result.height, Some(8));
        assert_eq!(result.source_kind, SourceKind::Image);
        assert!(!result.has_video);
        assert!(!result.has_audio);
        assert_eq!(result.duration_ms, 0);
        assert!(result.file_size > 0);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn probes_jpeg_dimensions() {
        let dir = std::env::temp_dir().join(format!("goop-img-probe-jpg-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jpg");
        write_test_jpeg(&path);

        let result = probe_image(&path).unwrap();
        assert_eq!(result.width, Some(16));
        assert_eq!(result.height, Some(16));
        assert_eq!(result.image_has_alpha, Some(false));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn jpeg_probe_uses_header_format_and_upright_orientation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("portrait.png");
        for orientation in 1..=8 {
            let img = image::RgbImage::new(16, 8);
            img.save_with_format(&path, image::ImageFormat::Jpeg)
                .unwrap();
            let mut jpeg = Jpeg::from_bytes(fs::read(&path).unwrap().into()).unwrap();
            let exif = vec![
                b'I',
                b'I',
                42,
                0,
                8,
                0,
                0,
                0,
                1,
                0,
                0x12,
                0x01,
                3,
                0,
                1,
                0,
                0,
                0,
                orientation,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
            ];
            jpeg.set_exif(Some(Bytes::from(exif)));
            let mut bytes = Vec::new();
            jpeg.encoder().write_to(&mut bytes).unwrap();
            fs::write(&path, bytes).unwrap();

            let result = probe_image(&path).unwrap();
            assert_eq!(result.image_format.as_deref(), Some("Jpeg"));
            let expected = if (5..=8).contains(&orientation) {
                (Some(8), Some(16))
            } else {
                (Some(16), Some(8))
            };
            assert_eq!(
                (result.width, result.height),
                expected,
                "orientation {orientation}"
            );
            assert_eq!(result.image_has_alpha, Some(false));
        }
    }

    #[test]
    fn heic_probe_reports_primary_image_opacity() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sample.heic");
        let result = probe_image(&path).unwrap();
        assert_eq!(result.image_format.as_deref(), Some("HEIC"));
        assert_eq!(result.image_has_alpha, Some(false));
    }

    #[test]
    fn renamed_avif_never_advertises_or_admits_heic_controls() {
        let dir = tempfile::tempdir().unwrap();
        let avif = dir.path().join("source.avif");
        image::RgbImage::new(16, 8)
            .save_with_format(&avif, image::ImageFormat::Avif)
            .unwrap();
        for extension in ["heic", "heif"] {
            let renamed = dir.path().join(format!("source.{extension}"));
            fs::copy(&avif, &renamed).unwrap();
            let probe = probe_image(&renamed).unwrap();
            assert_eq!(probe.image_format.as_deref(), Some("Avif"));
            let settings = crate::capabilities::capabilities_for(&probe)
                .targets
                .into_iter()
                .find(|capability| capability.target == goop_core::TargetFormat::Jpeg)
                .unwrap()
                .image_settings
                .unwrap();
            assert!(!settings.available);

            let request: goop_core::ConvertRequest = serde_json::from_value(serde_json::json!({
                "input_path": renamed,
                "output_path": dir.path().join("out.jpg"),
                "target": "jpeg",
                "image_options": {
                    "jpeg_quality": 75,
                    "resize": {"kind": "original"}
                }
            }))
            .unwrap();
            assert!(crate::capabilities::validate_request(&request, &probe).is_err());
            let mut legacy = request;
            legacy.image_options = None;
            assert!(crate::capabilities::validate_request(&legacy, &probe).is_ok());
        }
    }

    #[test]
    fn heic_brand_never_overrides_av1_primary_codec() {
        let dir = tempfile::tempdir().unwrap();
        let avif = dir.path().join("source.avif");
        image::RgbImage::new(16, 8)
            .save_with_format(&avif, image::ImageFormat::Avif)
            .unwrap();
        let mut bytes = fs::read(&avif).unwrap();
        assert_eq!(&bytes[4..12], b"ftypavif");
        bytes[8..12].copy_from_slice(b"heic");
        let disguised = dir.path().join("av1-primary.heic");
        fs::write(&disguised, bytes).unwrap();

        // The mutated container remains valid to libheif, but its primary item
        // is still AV1 and cannot authorize HEIC-only controls.
        let probe = probe_image(&disguised).unwrap();
        assert_eq!(probe.image_format.as_deref(), Some("Avif"));
        let settings = crate::capabilities::capabilities_for(&probe)
            .targets
            .into_iter()
            .find(|capability| capability.target == goop_core::TargetFormat::Jpeg)
            .unwrap()
            .image_settings
            .unwrap();
        assert!(!settings.available);

        let request: goop_core::ConvertRequest = serde_json::from_value(serde_json::json!({
            "input_path": disguised,
            "output_path": dir.path().join("out.jpg"),
            "target": "jpeg",
            "image_options": {
                "jpeg_quality": 75,
                "resize": {"kind": "original"}
            }
        }))
        .unwrap();
        assert!(crate::capabilities::validate_request(&request, &probe).is_err());
        let mut legacy = request;
        legacy.image_options = None;
        assert!(crate::capabilities::validate_request(&legacy, &probe).is_ok());
    }

    #[test]
    fn rejects_raster_disguised_as_raw() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("test.png");
        let raw = dir.path().join("test.dng");
        write_test_png(&png);
        fs::rename(png, &raw).unwrap();
        assert!(probe_image(&raw).is_err());
    }

    #[test]
    fn fails_on_nonexistent_file() {
        let result = probe_image(Path::new("/nonexistent/file.png"));
        assert!(result.is_err());
    }
}
