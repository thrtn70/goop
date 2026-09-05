use goop_core::{GoopError, ProbeResult, SourceKind};
use std::path::Path;

/// Probe supported images with the same format dispatch as conversion.
/// Common rasters and HEIC only read headers; JXL currently decodes pixels.
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
    let (width, height, image_format) = match ext.as_str() {
        "heic" | "heif" => {
            let path_str = path
                .to_str()
                .ok_or_else(|| probe_error("HEIC path is not valid UTF-8"))?;
            let context = libheif_rs::HeifContext::read_from_file(path_str)
                .map_err(|e| probe_error(format!("failed to read HEIC header: {e}")))?;
            let handle = context
                .primary_image_handle()
                .map_err(|e| probe_error(format!("failed to get primary HEIC dimensions: {e}")))?;
            (handle.width(), handle.height(), Some("HEIC".into()))
        }
        "jxl" => {
            // jpegxl-rs currently has no header-only API. Reuse the existing
            // decoder for consistent orientation and supported channel behavior.
            let image = crate::imagemagick::decode_any(path)?;
            (image.width(), image.height(), Some("JXL".into()))
        }
        _ => raster_dimensions(path)?,
    };
    let file_size = std::fs::metadata(path)?.len();

    Ok(ProbeResult {
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
    })
}

fn probe_error(message: impl Into<String>) -> GoopError {
    GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: message.into(),
    }
}

fn raster_dimensions(path: &Path) -> Result<(u32, u32, Option<String>), GoopError> {
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

    let format = reader.format().map(|f| format!("{f:?}"));
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to read image dimensions: {e}"),
        })?;

    Ok((width, height, format))
}

#[cfg(test)]
mod tests {
    use super::*;
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

        fs::remove_dir_all(&dir).ok();
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
