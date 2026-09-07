use goop_core::{GoopError, ProbeResult, SourceKind};
use image::ImageDecoder;
use std::{
    fs::File,
    io::{BufReader, Cursor, Read, Seek},
    path::Path,
};

const JPEG_HEADER_BYTES: u64 = 8 * 1024 * 1024;

/// Probe supported images with the same format dispatch as conversion.
/// HEIC reads headers; JPEG inspection captures at most an 8 MiB prefix.
/// Explicit requests use their separate bounded snapshot admission.
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
        _ => return raster_probe(path),
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
        video_details: None,
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

fn raster_probe(path: &Path) -> Result<ProbeResult, GoopError> {
    let mut file =
        File::open(path).map_err(|e| probe_error(format!("failed to open image: {e}")))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(probe_error("Image input must be a regular file"));
    }
    let mut signature = Vec::with_capacity(16);
    (&mut file).take(16).read_to_end(&mut signature)?;
    let detected = image::guess_format(&signature)
        .ok()
        .or_else(|| image::ImageFormat::from_path(path).ok());
    if detected == Some(image::ImageFormat::Jpeg) {
        return probe_jpeg_reader(
            Cursor::new(signature).chain(file),
            metadata.len(),
            JPEG_HEADER_BYTES,
        );
    }
    file.rewind()?;
    let mut reader = image::ImageReader::new(BufReader::new(file));
    if let Some(format) = detected {
        reader.set_format(format);
    }
    let decoder = reader
        .into_decoder()
        .map_err(|e| probe_error(format!("failed to read image dimensions: {e}")))?;
    Ok(image_probe_result(
        decoder.dimensions(),
        detected.map(|f| format!("{f:?}")),
        None,
        metadata.len(),
    ))
}

fn probe_jpeg_reader(
    reader: impl Read,
    file_size: u64,
    header_limit: u64,
) -> Result<ProbeResult, GoopError> {
    let bytes = crate::image_read::read_prefix(reader, header_limit, || Ok(()))?;
    let mut decoder = image::codecs::jpeg::JpegDecoder::new(Cursor::new(bytes)).map_err(|_| {
        probe_error("JPEG headers are invalid, incomplete, or exceed the 8 MiB inspection limit")
    })?;
    let (mut width, mut height) = decoder.dimensions();
    let orientation = decoder
        .exif_metadata()
        .map_err(|e| probe_error(format!("failed to read JPEG metadata: {e}")))?
        .and_then(|bytes| crate::exif_geometry::orientation(&bytes).ok())
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    if orientation.to_exif() >= 5 {
        std::mem::swap(&mut width, &mut height);
    }
    Ok(image_probe_result(
        (width, height),
        Some("Jpeg".into()),
        Some(false),
        file_size,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use img_parts::jpeg::Jpeg;
    use img_parts::{Bytes, ImageEXIF};
    use std::fs;

    struct Count<R> {
        inner: R,
        consumed: u64,
    }
    impl<R: std::io::Read> std::io::Read for Count<R> {
        fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
            let count = self.inner.read(output)?;
            self.consumed += count as u64;
            Ok(count)
        }
    }
    impl<R: std::io::BufRead> std::io::BufRead for Count<R> {
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            self.inner.fill_buf()
        }
        fn consume(&mut self, amount: usize) {
            self.consumed += amount as u64;
            self.inner.consume(amount);
        }
    }
    impl<R: std::io::Seek> std::io::Seek for Count<R> {
        fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(position)
        }
    }
    fn jpeg_bytes() -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut bytes)
            .encode_image(&image::RgbImage::new(16, 8))
            .unwrap();
        bytes
    }
    #[test]
    fn current_jpeg_decoder_eagerly_reads_a_valid_trailing_stream() {
        let mut bytes = jpeg_bytes();
        bytes.extend_from_slice(&[0; 65536]);
        let length = bytes.len() as u64;
        let mut reader = Count {
            inner: std::io::Cursor::new(bytes),
            consumed: 0,
        };
        let decoder = image::codecs::jpeg::JpegDecoder::new(&mut reader).unwrap();
        assert_eq!(decoder.dimensions(), (16, 8));
        assert_eq!(reader.consumed, length);
    }
    #[test]
    fn jpeg_probe_does_not_consume_trailing_stream() {
        use std::io::{Cursor, Read};
        let bytes = jpeg_bytes();
        assert!(bytes.len() < 4096);
        let file_size = bytes.len() as u64 + 65536;
        let mut reader = Count {
            inner: Cursor::new(bytes).chain(std::io::repeat(0).take(65536)),
            consumed: 0,
        };
        let probe = probe_jpeg_reader(&mut reader, file_size, 4096).unwrap();
        assert_eq!(probe.width.zip(probe.height), Some((16, 8)));
        assert_eq!(probe.file_size, file_size);
        assert_eq!(reader.consumed, 4096);
    }
    #[test]
    fn jpeg_headers_over_budget_and_malformed_fail_without_fallback() {
        let original = jpeg_bytes();
        let mut delayed_header = vec![0xff, 0xd8, 0xff, 0xef, 0xff, 0xff];
        delayed_header.extend_from_slice(&[0; 65533]);
        delayed_header.extend_from_slice(&original[2..]);
        for bytes in [
            delayed_header,
            vec![0xff, 0xd8, 0xff, 0xe1, 0, 1],
            vec![0xff, 0xd8],
        ] {
            let file_size = bytes.len() as u64;
            let mut reader = Count {
                inner: std::io::Cursor::new(bytes),
                consumed: 0,
            };
            let error = probe_jpeg_reader(&mut reader, file_size, 4096).unwrap_err();
            assert!(error.to_string().contains("8 MiB inspection limit"));
            assert!(reader.consumed <= 4096);
        }
    }
    #[test]
    fn missing_scan_header_fails_and_large_dimensions_remain_probeable() {
        let mut bytes = jpeg_bytes();
        let scan = bytes.windows(2).position(|b| b == [0xff, 0xda]).unwrap();
        assert!(probe_jpeg_reader(&bytes[..scan], scan as u64, 4096).is_err());
        let frame = bytes.windows(2).position(|b| b == [0xff, 0xc0]).unwrap();
        bytes[frame + 7..frame + 9].copy_from_slice(&40000u16.to_be_bytes());
        let result = probe_jpeg_reader(&bytes[..], bytes.len() as u64, 4096).unwrap();
        assert_eq!(result.width, Some(40000));
    }

    #[test]
    fn malformed_orientation_keeps_untransformed_generic_dimensions() {
        let mut jpeg = Jpeg::from_bytes(jpeg_bytes().into()).unwrap();
        jpeg.set_exif(Some(Bytes::from_static(b"invalid exif")));
        let mut bytes = Vec::new();
        jpeg.encoder().write_to(&mut bytes).unwrap();
        let result = probe_jpeg_reader(&bytes[..], bytes.len() as u64, 4096).unwrap();
        assert_eq!((result.width, result.height), (Some(16), Some(8)));
    }

    #[test]
    fn progressive_jpeg_headers_need_no_pixel_decode() {
        let bytes = include_bytes!("../tests/fixtures/progressive.jpg");
        let result = probe_jpeg_reader(&bytes[..], bytes.len() as u64, 4096).unwrap();
        assert_eq!(result.width.zip(result.height), Some((32, 16)));
    }

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
        for (kind, orientation) in [3, 4]
            .into_iter()
            .flat_map(|kind| (1..=8).map(move |o| (kind, o)))
        {
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
                kind,
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
