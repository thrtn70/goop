use goop_core::{GoopError, ProbeResult, SourceKind};
use std::path::Path;

/// Probe an image file using the `image` crate. Returns dimensions, format,
/// and file size without needing an external binary.
pub fn probe_image(path: &Path) -> Result<ProbeResult, GoopError> {
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

    let format = reader.format();
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to read image dimensions: {e}"),
        })?;

    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let image_format = format.map(|f| format!("{f:?}"));

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
    })
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
    fn fails_on_nonexistent_file() {
        let result = probe_image(Path::new("/nonexistent/file.png"));
        assert!(result.is_err());
    }
}
