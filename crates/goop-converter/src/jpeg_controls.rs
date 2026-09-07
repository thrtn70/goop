//! Explicit JPEG rendering in a caller-owned staging file.
use goop_core::{GoopError, ImageConvertOptions, ImageResize, MetadataPolicy};
use image::{DynamicImage, ImageDecoder};
use img_parts::Bytes;
use std::{
    fs::File,
    io::{BufWriter, Cursor, Read},
    path::Path,
};

pub(crate) const MAX_ALLOC: u64 = 512 * 1024 * 1024;
pub(crate) const MAX_INPUT_BYTES: u64 = 512 * 1024 * 1024;

/// Immutable encoded bytes captured before any JPEG decoder is constructed.
/// The decoder makes its own bounded copy; metadata shares this snapshot.
pub(crate) struct JpegSource {
    pub(crate) bytes: Bytes,
}

fn read_snapshot(reader: impl Read, limit: u64) -> Result<Bytes, GoopError> {
    crate::image_read::read_snapshot(
        reader,
        limit,
        "Encoded JPEG input exceeds the 512 MiB limit",
        || Ok(()),
    )
    .map_err(|failure| match failure {
        GoopError::InvalidRequest(message) if message == "Image input size overflow" => {
            error("JPEG input size overflow")
        }
        GoopError::InvalidRequest(message)
            if message == "Insufficient memory for bounded image input" =>
        {
            error("Insufficient memory for bounded JPEG input")
        }
        other => other,
    })
}

pub(crate) fn prepare(input: &Path, limit: u64) -> Result<Option<JpegSource>, GoopError> {
    let mut file = File::open(input)?;
    let mut signature = Vec::with_capacity(3);
    (&mut file).take(3).read_to_end(&mut signature)?;
    let ext = input.extension().and_then(|e| e.to_str()).unwrap_or("");
    let native = crate::raw::is_raw_extension(ext)
        || ext.eq_ignore_ascii_case("heic")
        || ext.eq_ignore_ascii_case("heif");
    if native && signature != [0xff, 0xd8, 0xff] {
        return Ok(None);
    }
    // Keep the same open stream after sniffing, including JPEGs with a non-JPEG suffix.
    let bytes = read_snapshot(Cursor::new(signature).chain(file), limit)?;
    Ok(Some(JpegSource { bytes }))
}

impl JpegSource {
    fn decoder(&self) -> Result<image::codecs::jpeg::JpegDecoder<Cursor<Bytes>>, GoopError> {
        if !self.bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            return Err(error(
                "Explicit JPEG settings require a JPEG, HEIC or RAW source",
            ));
        }
        // image's JPEG constructor buffers input before set_limits and does not
        // enforce max_alloc here. Encoded and raster bounds are enforced by us.
        let decoder = image::codecs::jpeg::JpegDecoder::new(Cursor::new(self.bytes.clone()))
            .map_err(|e| error(format!("JPEG header: {e}")))?;
        let (width, height) = decoder.dimensions();
        check_raster(
            width,
            height,
            u64::from(decoder.color_type().bytes_per_pixel()),
        )?;
        Ok(decoder)
    }

    fn orientation(
        decoder: &mut impl ImageDecoder,
    ) -> Result<image::metadata::Orientation, GoopError> {
        decoder
            .exif_metadata()
            .map_err(|e| error(format!("JPEG metadata: {e}")))?
            .as_deref()
            .map(crate::exif_geometry::orientation)
            .transpose()
            .map(|value| value.unwrap_or(image::metadata::Orientation::NoTransforms))
    }

    fn probe(&self) -> Result<goop_core::ProbeResult, GoopError> {
        let mut decoder = self.decoder()?;
        let (mut width, mut height) = decoder.dimensions();
        // Malformed metadata does not disable the StripAll pixel-decode path.
        let orientation =
            Self::orientation(&mut decoder).unwrap_or(image::metadata::Orientation::NoTransforms);
        if orientation.to_exif() >= 5 {
            std::mem::swap(&mut width, &mut height);
        }
        Ok(crate::imagemagick_probe::image_probe_result(
            (width, height),
            Some("Jpeg".into()),
            Some(false),
            self.bytes.len() as u64,
        ))
    }
}

pub(crate) fn probe_prepared(
    input: &Path,
    source: Option<&JpegSource>,
) -> Result<goop_core::ProbeResult, GoopError> {
    match source {
        Some(jpeg) => jpeg.probe(),
        None => crate::imagemagick_probe::probe_image(input),
    }
}

pub(crate) fn probe_explicit(
    input: &Path,
    limit: u64,
) -> Result<goop_core::ProbeResult, GoopError> {
    let source = prepare(input, limit)?;
    probe_prepared(input, source.as_ref())
}

fn error(message: impl Into<String>) -> GoopError {
    GoopError::InvalidRequest(message.into())
}
pub(crate) fn check_raster(width: u32, height: u32, bytes_per_pixel: u64) -> Result<(), GoopError> {
    crate::image_options::output_dimensions((width, height), &ImageResize::Original)?;
    let bytes = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|v| v.checked_mul(bytes_per_pixel))
        .ok_or_else(|| error("Image allocation overflow"))?;
    if bytes > MAX_ALLOC {
        return Err(error("Image exceeds the 512 MiB raster allocation limit"));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn render(
    input: &Path,
    output: &Path,
    options: &ImageConvertOptions,
    policy: MetadataPolicy,
) -> Result<(), GoopError> {
    let source = prepare(input, MAX_INPUT_BYTES)?;
    render_prepared(input, output, options, policy, source.as_ref())
}

pub(crate) fn render_prepared(
    input: &Path,
    output: &Path,
    options: &ImageConvertOptions,
    policy: MetadataPolicy,
    source: Option<&JpegSource>,
) -> Result<(), GoopError> {
    crate::image_options::validate_options(options)?;
    let mut pixels = if let Some(source) = source {
        let mut decoder = source.decoder()?;
        let orientation = match JpegSource::orientation(&mut decoder) {
            Ok(value) => value,
            Err(_) if policy == MetadataPolicy::StripAll => {
                image::metadata::Orientation::NoTransforms
            }
            Err(error) => return Err(error),
        };
        let mut image =
            DynamicImage::from_decoder(decoder).map_err(|e| error(format!("JPEG pixels: {e}")))?;
        image.apply_orientation(orientation);
        image
    } else {
        let ext = input.extension().and_then(|e| e.to_str()).unwrap_or("");
        if crate::raw::is_raw_extension(ext) {
            crate::raw::decode_raw(input)?
        } else if ext.eq_ignore_ascii_case("heic") || ext.eq_ignore_ascii_case("heif") {
            crate::imagemagick::decode_heic_explicit(input)?
        } else {
            return Err(error(
                "Explicit JPEG settings require a JPEG, HEIC or RAW source",
            ));
        }
    };
    if pixels.color().has_alpha() {
        return Err(error("JPEG settings require opaque pixels"));
    }
    check_raster(
        pixels.width(),
        pixels.height(),
        u64::from(pixels.color().bytes_per_pixel()),
    )?;
    let (width, height) = crate::image_options::output_dimensions(
        (pixels.width(), pixels.height()),
        &options.resize,
    )?;
    check_raster(width, height, 3)?;
    if (width, height) != (pixels.width(), pixels.height()) {
        pixels = pixels.resize_exact(width, height, image::imageops::FilterType::Lanczos3);
    }
    let mut output_file = BufWriter::new(File::create(output)?);
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output_file, options.jpeg_quality);
    // Keep grayscale pixels compatible with a retained GRAY ICC profile.
    if let Some(gray) = pixels.as_luma8() {
        encoder.encode_image(gray)
    } else {
        encoder.encode_image(&pixels.into_rgb8())
    }
    .map_err(|e| error(format!("JPEG encode: {e}")))?;
    std::io::Write::flush(&mut output_file)?;
    drop(output_file);
    crate::metadata::apply_rendered_jpeg(source, output, width, height, policy)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_stream_stops_at_cap_plus_one() {
        struct Count<R> {
            inner: R,
            count: usize,
        }
        impl<R: Read> Read for Count<R> {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                let n = self.inner.read(output)?;
                self.count += n;
                Ok(n)
            }
        }
        for limit in [0, 1, 1024, 131072] {
            let mut stream = Count {
                inner: std::io::repeat(0).take(200_000),
                count: 0,
            };
            assert!(read_snapshot(&mut stream, limit).is_err());
            assert_eq!(stream.count as u64, limit + 1);
        }
    }
    #[test]
    fn explicit_initial_probe_rejects_tiny_jpeg_with_oversized_trailing_stream() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("actual.png");
        image::RgbImage::new(16, 8)
            .save_with_format(&path, image::ImageFormat::Jpeg)
            .unwrap();
        let limit = std::fs::metadata(&path).unwrap().len() + 10;
        std::io::Write::write_all(
            &mut std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap(),
            &[0; 8192],
        )
        .unwrap();
        let failure = probe_explicit(&path, limit).unwrap_err();
        assert!(failure.to_string().contains("Encoded JPEG input"));
    }
    #[test]
    fn snapshot_keeps_probe_pixels_and_preserved_metadata_after_source_removal() {
        use img_parts::{jpeg::Jpeg, ImageEXIF, ImageICC};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("actual.png");
        image::RgbImage::from_fn(16, 8, |_, _| image::Rgb([240, 10, 20]))
            .save_with_format(&path, image::ImageFormat::Jpeg)
            .unwrap();
        let mut jpeg = Jpeg::from_bytes(std::fs::read(&path).unwrap().into()).unwrap();
        jpeg.set_exif(Some(
            vec![
                b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 4, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0,
                0, 0,
            ]
            .into(),
        ));
        jpeg.set_icc_profile(Some(vec![37; 128].into()));
        jpeg.encoder()
            .write_to(File::create(&path).unwrap())
            .unwrap();
        let exact_limit = std::fs::metadata(&path).unwrap().len();
        let snapshot = prepare(&path, exact_limit).unwrap().unwrap();
        // Removal proves neither probe, decoder nor Preserve reopens the source.
        std::fs::remove_file(&path).unwrap();
        let probe = probe_prepared(&path, Some(&snapshot)).unwrap();
        assert_eq!(probe.width.zip(probe.height), Some((8, 16)));
        let out = dir.path().join("out.jpg");
        render_prepared(
            &path,
            &out,
            &ImageConvertOptions {
                jpeg_quality: 75,
                resize: ImageResize::Original,
            },
            MetadataPolicy::Preserve,
            Some(&snapshot),
        )
        .unwrap();
        assert_eq!(image::image_dimensions(&out).unwrap(), (8, 16));
        assert!(image::open(&out).unwrap().to_rgb8().get_pixel(3, 3)[0] > 220);
        let (exif, icc) = crate::metadata::read(&out).unwrap();
        assert_eq!(icc.unwrap(), vec![37; 128]);
        assert_eq!(exif.unwrap()[18], 1);
    }
}
