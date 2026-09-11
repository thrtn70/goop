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
    if signature != [0xff, 0xd8, 0xff] {
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

    /// Decode pixels and derive metadata from the same immutable source bytes.
    /// Pixels are made upright exactly once for every policy. Preserve then
    /// normalizes its reattached EXIF orientation, matching the legacy renderer.
    pub(crate) fn decode_with_metadata_plan(
        &self,
        policy: MetadataPolicy,
        output_color: crate::metadata::JpegOutputColor,
    ) -> Result<(DynamicImage, crate::metadata::JpegMetadataPlan), GoopError> {
        let plan = crate::metadata::prepare_jpeg_plan(self.bytes.clone(), policy, output_color)?;
        let decoder = self.decoder()?;
        let mut pixels =
            DynamicImage::from_decoder(decoder).map_err(|e| error(format!("JPEG pixels: {e}")))?;
        pixels.apply_orientation(plan.orientation());
        Ok((pixels, plan))
    }

    /// Target-size Preserve keeps the legacy stored-pixel representation and
    /// exact EXIF bytes. Privacy policies still normalize pixels before EXIF
    /// removal.
    pub(crate) fn decode_with_target_metadata_plan(
        &self,
        policy: MetadataPolicy,
        output_color: crate::metadata::JpegOutputColor,
    ) -> Result<(DynamicImage, crate::metadata::JpegMetadataPlan), GoopError> {
        if policy != MetadataPolicy::Preserve {
            return self.decode_with_metadata_plan(policy, output_color);
        }
        let plan = crate::metadata::prepare_jpeg_target_plan(self.bytes.clone())?;
        let decoder = self.decoder()?;
        let pixels =
            DynamicImage::from_decoder(decoder).map_err(|e| error(format!("JPEG pixels: {e}")))?;
        Ok((pixels, plan))
    }

    pub(crate) fn inspect_metadata(
        &self,
        output_color: crate::metadata::JpegOutputColor,
    ) -> Result<crate::metadata::JpegMetadataInspection, GoopError> {
        crate::metadata::inspect_jpeg_metadata(self.bytes.clone(), output_color)
    }

    /// Refuse publication when the live path no longer contains the exact
    /// bytes used for decode and metadata decisions. The reread is bounded by
    /// the same cap as the original snapshot.
    pub(crate) fn verify_unchanged(&self, input: &Path, limit: u64) -> Result<(), GoopError> {
        let changed = || {
            error("The source changed during image processing; inspect it again before retrying")
        };
        if self.bytes.len() as u64 > limit {
            return Err(changed());
        }
        let mut file = File::open(input)?;
        let mut offset = 0usize;
        let mut buffer = [0u8; 64 * 1024];
        while offset < self.bytes.len() {
            let remaining = self.bytes.len() - offset;
            let requested = remaining.min(buffer.len());
            let count = file.read(&mut buffer[..requested])?;
            if count == 0 || buffer[..count] != self.bytes[offset..offset.saturating_add(count)] {
                return Err(changed());
            }
            offset += count;
        }
        if file.read(&mut buffer[..1])? != 0 {
            return Err(changed());
        }
        Ok(())
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
    let mut prepared_privacy_pixels = None;
    let privacy_plan = match (source, policy) {
        (Some(source), MetadataPolicy::RemovePersonal | MetadataPolicy::StripAll) => {
            let (pixels, plan) = source.decode_with_metadata_plan(
                policy,
                crate::metadata::JpegOutputColor::Rgb,
            )?;
            prepared_privacy_pixels = Some(pixels);
            Some(plan)
        }
        (None, MetadataPolicy::RemovePersonal) => {
            return Err(error(
                "Remove personal data currently requires a JPEG source with proven RGB metadata compatibility",
            ))
        }
        _ => None,
    };
    let mut pixels = if let Some(source) = source {
        if let Some(pixels) = prepared_privacy_pixels.take() {
            pixels
        } else {
            let mut decoder = source.decoder()?;
            let orientation = JpegSource::orientation(&mut decoder)?;
            let mut image = DynamicImage::from_decoder(decoder)
                .map_err(|e| error(format!("JPEG pixels: {e}")))?;
            image.apply_orientation(orientation);
            image
        }
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
    if let Some(plan) = privacy_plan {
        let source = source.ok_or_else(|| {
            error("A prepared JPEG source is required to verify the privacy result")
        })?;
        let candidate = std::fs::read(output)?;
        let finished = plan.assemble_candidate(candidate)?;
        std::fs::write(output, &finished)?;
        plan.verify_candidate(&finished)?;
        source.verify_unchanged(input, MAX_INPUT_BYTES)
    } else {
        crate::metadata::apply_rendered_jpeg(source, output, width, height, policy)?;
        if let Some(source) = source {
            source.verify_unchanged(input, MAX_INPUT_BYTES)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use img_parts::jpeg::JpegSegment;
    use img_parts::{ImageEXIF, ImageICC};
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
        let failure = match prepare(&path, limit) {
            Err(error) => error,
            Ok(_) => panic!("oversized encoded JPEG must be refused"),
        };
        assert!(failure.to_string().contains("Encoded JPEG input"));
    }
    #[test]
    fn preserve_render_uses_snapshot_but_refuses_source_removal_before_returning() {
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
        jpeg.set_icc_profile(Some(rgb_icc().into()));
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
        let error = render_prepared(
            &path,
            &out,
            &ImageConvertOptions {
                jpeg_quality: 75,
                resize: ImageResize::Original,
            },
            MetadataPolicy::Preserve,
            Some(&snapshot),
        )
        .unwrap_err();
        assert!(error.user_message().contains("No such file"));
    }

    fn orientation_exif(value: u16) -> Vec<u8> {
        let mut bytes = b"II".to_vec();
        bytes.extend_from_slice(&42u16.to_le_bytes());
        bytes.extend_from_slice(&8u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&0x0112u16.to_le_bytes());
        bytes.extend_from_slice(&3u16.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&value.to_le_bytes());
        bytes.extend_from_slice(&[0, 0]);
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes
    }

    fn rgb_icc() -> Vec<u8> {
        let mut profile = vec![0; 128];
        profile[..4].copy_from_slice(&128u32.to_be_bytes());
        profile[16..20].copy_from_slice(b"RGB ");
        profile[36..40].copy_from_slice(b"acsp");
        profile
    }

    fn write_oriented_source(path: &Path, orientation: u16) {
        let image = image::RgbImage::from_fn(80, 60, |x, y| match (x < 40, y < 30) {
            (true, true) => image::Rgb([240, 20, 20]),
            (false, true) => image::Rgb([20, 230, 30]),
            (true, false) => image::Rgb([20, 30, 230]),
            (false, false) => image::Rgb([235, 225, 20]),
        });
        image
            .save_with_format(path, image::ImageFormat::Jpeg)
            .unwrap();
        let mut jpeg =
            img_parts::jpeg::Jpeg::from_bytes(std::fs::read(path).unwrap().into()).unwrap();
        jpeg.set_exif(Some(orientation_exif(orientation).into()));
        jpeg.encoder()
            .write_to(File::create(path).unwrap())
            .unwrap();
    }

    #[test]
    fn target_size_preserve_keeps_stored_pixels_and_exact_exif() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.jpg");
        write_oriented_source(&input, 6);
        let mut jpeg =
            img_parts::jpeg::Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
        jpeg.set_icc_profile(Some(rgb_icc().into()));
        jpeg.encoder()
            .write_to(File::create(&input).unwrap())
            .unwrap();
        let source = prepare(&input, MAX_INPUT_BYTES).unwrap().unwrap();
        let original_exif = crate::metadata::read(&input).unwrap().0.unwrap();

        let (pixels, plan) = source
            .decode_with_target_metadata_plan(
                MetadataPolicy::Preserve,
                crate::metadata::JpegOutputColor::Rgb,
            )
            .unwrap();
        assert_eq!((pixels.width(), pixels.height()), (80, 60));
        let candidate = plan
            .assemble_candidate({
                let mut bytes = Vec::new();
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 90)
                    .encode_image(&pixels)
                    .unwrap();
                bytes
            })
            .unwrap();
        let output = dir.path().join("output.jpg");
        std::fs::write(&output, candidate).unwrap();
        let (exif, icc) = crate::metadata::read(&output).unwrap();
        assert_eq!(exif.unwrap(), original_exif);
        assert_eq!(icc.unwrap(), rgb_icc());
    }

    #[test]
    fn preparing_a_non_jpeg_does_not_snapshot_the_full_file() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.png");
        image::RgbImage::new(8, 8).save(&input).unwrap();
        assert!(prepare(&input, MAX_INPUT_BYTES).unwrap().is_none());
    }

    #[test]
    fn both_privacy_policies_apply_each_orientation_exactly_once() {
        for orientation in 1..=8 {
            for policy in [MetadataPolicy::RemovePersonal, MetadataPolicy::StripAll] {
                let dir = tempfile::tempdir().unwrap();
                let input = dir.path().join("source.jpg");
                let output = dir.path().join("output.jpg");
                write_oriented_source(&input, orientation);
                let source = prepare(&input, MAX_INPUT_BYTES).unwrap().unwrap();
                let mut expected = DynamicImage::from_decoder(source.decoder().unwrap()).unwrap();
                expected.apply_orientation(
                    image::metadata::Orientation::from_exif(orientation as u8).unwrap(),
                );

                render_prepared(
                    &input,
                    &output,
                    &ImageConvertOptions {
                        jpeg_quality: 100,
                        resize: ImageResize::Original,
                    },
                    policy,
                    Some(&source),
                )
                .unwrap();

                let actual = image::open(&output).unwrap().to_rgb8();
                let expected = expected.to_rgb8();
                assert_eq!(
                    actual.dimensions(),
                    expected.dimensions(),
                    "orientation {orientation}"
                );
                for (x, y) in [
                    (actual.width() / 4, actual.height() / 4),
                    (actual.width() * 3 / 4, actual.height() / 4),
                    (actual.width() / 4, actual.height() * 3 / 4),
                    (actual.width() * 3 / 4, actual.height() * 3 / 4),
                ] {
                    let got = actual.get_pixel(x, y);
                    let want = expected.get_pixel(x, y);
                    for channel in 0..3 {
                        assert!(
                            got[channel].abs_diff(want[channel]) <= 12,
                            "orientation {orientation} policy {policy:?} at {x},{y} channel {channel}: {} != {}",
                            got[channel],
                            want[channel]
                        );
                    }
                }
                let (exif, icc) = crate::metadata::read(&output).unwrap();
                assert!(exif.is_none());
                assert!(icc.is_none());
            }
        }
    }

    #[test]
    fn privacy_render_refuses_changed_live_source_before_returning_staged_output() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.jpg");
        let output = dir.path().join("staged.jpg");
        write_oriented_source(&input, 1);
        let source = prepare(&input, MAX_INPUT_BYTES).unwrap().unwrap();
        std::fs::write(&input, b"changed after snapshot").unwrap();
        let error = render_prepared(
            &input,
            &output,
            &ImageConvertOptions {
                jpeg_quality: 90,
                resize: ImageResize::Original,
            },
            MetadataPolicy::RemovePersonal,
            Some(&source),
        )
        .unwrap_err();
        assert!(error.user_message().contains("source changed"));
    }

    #[test]
    fn privacy_render_refuses_ambiguous_exif_before_creating_output() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.jpg");
        let output = dir.path().join("output.jpg");
        write_oriented_source(&input, 1);
        let mut jpeg =
            img_parts::jpeg::Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
        let mut contents = b"Exif\0\0".to_vec();
        contents.extend_from_slice(&orientation_exif(6));
        jpeg.segments_mut()
            .insert(1, JpegSegment::new_with_contents(0xe1, contents.into()));
        jpeg.encoder()
            .write_to(File::create(&input).unwrap())
            .unwrap();
        let source = prepare(&input, MAX_INPUT_BYTES).unwrap().unwrap();
        assert!(render_prepared(
            &input,
            &output,
            &ImageConvertOptions {
                jpeg_quality: 90,
                resize: ImageResize::Original,
            },
            MetadataPolicy::StripAll,
            Some(&source),
        )
        .is_err());
        assert!(!output.exists());
    }
}
