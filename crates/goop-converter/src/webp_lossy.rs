use goop_core::GoopError;
use image::{DynamicImage, ImageDecoder, ImageFormat};
use img_parts::Bytes;
use std::{
    fs::File,
    io::{Cursor, Read},
    path::Path,
};
use tokio_util::sync::CancellationToken;

pub(crate) const MAX_DIMENSION: u32 = 16_383;
const MAX_INPUT_BYTES: u64 = 512 * 1024 * 1024;

fn invalid(message: impl Into<String>) -> GoopError {
    GoopError::InvalidRequest(message.into())
}

fn checkpoint(cancel: &CancellationToken) -> Result<(), GoopError> {
    if cancel.is_cancelled() {
        Err(GoopError::Cancelled)
    } else {
        Ok(())
    }
}

fn validate_raster(width: u32, height: u32, bytes_per_pixel: u64) -> Result<usize, GoopError> {
    if width == 0 || height == 0 {
        return Err(invalid("WebP dimensions must be non-zero"));
    }
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(invalid(format!(
            "WebP dimensions exceed libwebp's {MAX_DIMENSION}-pixel axis limit"
        )));
    }
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| invalid("WebP pixel count overflow"))?;
    if pixels > u64::from(crate::image_options::MAX_OUTPUT_PIXELS) {
        return Err(invalid(
            "WebP dimensions exceed the 100-million-pixel limit",
        ));
    }
    let bytes = pixels
        .checked_mul(bytes_per_pixel)
        .ok_or_else(|| invalid("WebP raster allocation overflow"))?;
    if bytes > crate::jpeg_controls::MAX_ALLOC {
        return Err(invalid("WebP exceeds the 512 MiB raster allocation limit"));
    }
    usize::try_from(bytes).map_err(|_| invalid("WebP raster does not fit in memory"))
}

/// Immutable encoded image bytes used for decode and the final source check.
/// This keeps a path replacement from publishing pixels from stale content.
pub(crate) struct WebpSource {
    bytes: Bytes,
}

impl WebpSource {
    pub(crate) fn capture(input: &Path, cancel: &CancellationToken) -> Result<Self, GoopError> {
        checkpoint(cancel)?;
        let file = File::open(input)?;
        if !file.metadata()?.is_file() {
            return Err(invalid("Image source must be a regular file"));
        }
        let bytes = crate::image_read::read_snapshot(
            file,
            MAX_INPUT_BYTES,
            "Encoded image input exceeds the 512 MiB limit",
            || checkpoint(cancel),
        )?;
        Ok(Self { bytes })
    }

    pub(crate) fn decode(&self, cancel: &CancellationToken) -> Result<DynamicImage, GoopError> {
        checkpoint(cancel)?;
        let mut reader = image::ImageReader::new(Cursor::new(self.bytes.clone()))
            .with_guessed_format()
            .map_err(|error| invalid(format!("Cannot identify image source: {error}")))?;
        if !matches!(
            reader.format(),
            Some(ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP)
        ) {
            return Err(invalid(
                "Lossy WebP Quality requires a JPEG, PNG or WebP source",
            ));
        }
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(crate::jpeg_controls::MAX_ALLOC);
        reader.limits(limits);
        let decoder = reader
            .into_decoder()
            .map_err(|error| GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("failed to decode image source for WebP: {error}"),
            })?;
        let (width, height) = decoder.dimensions();
        let bytes_per_pixel = match decoder.color_type() {
            image::ColorType::Rgb8 => 3,
            image::ColorType::Rgba8 => 4,
            _ => {
                return Err(invalid(
                    "Lossy WebP supports 8-bit RGB and RGBA sources only",
                ))
            }
        };
        validate_raster(width, height, bytes_per_pixel)?;
        checkpoint(cancel)?;
        DynamicImage::from_decoder(decoder).map_err(|error| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to decode image pixels for WebP: {error}"),
        })
    }

    pub(crate) fn verify_unchanged(
        &self,
        input: &Path,
        cancel: &CancellationToken,
    ) -> Result<(), GoopError> {
        let changed = || {
            invalid(
                "The image source changed during WebP processing; inspect it again before retrying",
            )
        };
        if self.bytes.len() as u64 > MAX_INPUT_BYTES {
            return Err(changed());
        }
        let mut file = File::open(input).map_err(|_| changed())?;
        let mut offset = 0usize;
        let mut buffer = [0u8; 64 * 1024];
        while offset < self.bytes.len() {
            checkpoint(cancel)?;
            let requested = (self.bytes.len() - offset).min(buffer.len());
            let count = file.read(&mut buffer[..requested]).map_err(|_| changed())?;
            if count == 0 || buffer[..count] != self.bytes[offset..offset + count] {
                return Err(changed());
            }
            offset += count;
        }
        checkpoint(cancel)?;
        if file.read(&mut buffer[..1]).map_err(|_| changed())? != 0 {
            return Err(changed());
        }
        Ok(())
    }
}

fn verify_container(bytes: &[u8]) -> Result<(), GoopError> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err(GoopError::SubprocessFailed {
            binary: "libwebp".into(),
            stderr: "lossy WebP encoder returned an invalid container".into(),
        });
    }
    let declared = u32::from_le_bytes(bytes[4..8].try_into().expect("fixed RIFF size field"));
    if u64::from(declared) + 8 != bytes.len() as u64 {
        return Err(GoopError::SubprocessFailed {
            binary: "libwebp".into(),
            stderr: "lossy WebP encoder returned a truncated container".into(),
        });
    }
    Ok(())
}

pub(crate) fn encode(
    image: &DynamicImage,
    quality: u8,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, GoopError> {
    if !(1..=100).contains(&quality) {
        return Err(invalid("WebP quality must be between 1 and 100"));
    }
    checkpoint(cancel)?;
    let encoded = match image {
        DynamicImage::ImageRgb8(pixels) => {
            let expected = validate_raster(pixels.width(), pixels.height(), 3)?;
            if pixels.as_raw().len() != expected {
                return Err(invalid(
                    "WebP RGB raster length does not match its dimensions",
                ));
            }
            webp::Encoder::from_rgb(pixels.as_raw(), pixels.width(), pixels.height())
                .encode_simple(false, f32::from(quality))
        }
        DynamicImage::ImageRgba8(pixels) => {
            let expected = validate_raster(pixels.width(), pixels.height(), 4)?;
            if pixels.as_raw().len() != expected {
                return Err(invalid(
                    "WebP RGBA raster length does not match its dimensions",
                ));
            }
            webp::Encoder::from_rgba(pixels.as_raw(), pixels.width(), pixels.height())
                .encode_simple(false, f32::from(quality))
        }
        _ => {
            return Err(invalid(
                "Lossy WebP supports 8-bit RGB and RGBA pixels only; convert this image to a supported 8-bit layout first",
            ))
        }
    }
    .map_err(|error| GoopError::SubprocessFailed {
        binary: "libwebp".into(),
        stderr: format!("lossy WebP encode failed: {error:?}"),
    })?;
    checkpoint(cancel)?;
    let encoded = encoded.to_vec();
    verify_container(&encoded)?;
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb, Rgba};

    fn mse(expected: &[u8], encoded: &[u8]) -> f64 {
        let decoded = image::load_from_memory_with_format(encoded, image::ImageFormat::WebP)
            .unwrap()
            .into_rgb8();
        expected
            .iter()
            .zip(decoded.as_raw())
            .map(|(left, right)| {
                let delta = i32::from(*left) - i32::from(*right);
                (delta * delta) as f64
            })
            .sum::<f64>()
            / expected.len() as f64
    }

    #[test]
    fn rgb_quality_steps_are_distinct_and_higher_quality_is_more_faithful() {
        let rgb = ImageBuffer::from_fn(64, 64, |x, y| {
            Rgb([x as u8 * 4, y as u8 * 4, (x ^ y) as u8 * 4])
        });
        let source = DynamicImage::ImageRgb8(rgb.clone());
        let low = encode(&source, 1, &CancellationToken::new()).unwrap();
        let medium = encode(&source, 50, &CancellationToken::new()).unwrap();
        let high = encode(&source, 100, &CancellationToken::new()).unwrap();
        let low_error = mse(rgb.as_raw(), &low);
        let medium_error = mse(rgb.as_raw(), &medium);
        let high_error = mse(rgb.as_raw(), &high);
        assert_eq!(
            [low.len(), medium.len(), high.len()]
                .into_iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3
        );
        assert!(high_error < medium_error && medium_error < low_error);
        eprintln!(
            "lossy WebP RGB quality table: q1={} bytes mse={low_error:.4}, q50={} bytes mse={medium_error:.4}, q100={} bytes mse={high_error:.4}",
            low.len(),
            medium.len(),
            high.len()
        );
    }

    #[test]
    fn rgba_quality_preserves_alpha_exactly() {
        let rgba = ImageBuffer::from_fn(64, 64, |x, y| {
            Rgba([
                x as u8 * 4,
                y as u8 * 4,
                (x ^ y) as u8 * 4,
                (x + y) as u8 * 2,
            ])
        });
        let source = DynamicImage::ImageRgba8(rgba.clone());
        let mut sizes = Vec::new();
        for quality in [1, 50, 100] {
            let encoded = encode(&source, quality, &CancellationToken::new()).unwrap();
            sizes.push(encoded.len());
            let decoded = image::load_from_memory_with_format(&encoded, image::ImageFormat::WebP)
                .unwrap()
                .into_rgba8();
            assert!(rgba.as_raw().iter().skip(3).step_by(4).eq(decoded
                .as_raw()
                .iter()
                .skip(3)
                .step_by(4)));
        }
        assert_eq!(
            sizes
                .iter()
                .copied()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3
        );
        eprintln!(
            "lossy WebP RGBA quality sizes with exact alpha: q1={} q50={} q100={}",
            sizes[0], sizes[1], sizes[2]
        );
    }

    #[test]
    fn invalid_quality_oversized_dimensions_and_pre_cancel_are_rejected() {
        let image = DynamicImage::new_rgb8(1, 1);
        for quality in [0, 101] {
            assert!(matches!(
                encode(&image, quality, &CancellationToken::new()),
                Err(GoopError::InvalidRequest(_))
            ));
        }
        let oversized = DynamicImage::new_rgb8(MAX_DIMENSION + 1, 1);
        assert!(matches!(
            encode(&oversized, 50, &CancellationToken::new()),
            Err(GoopError::InvalidRequest(_))
        ));
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            encode(&image, 50, &cancel),
            Err(GoopError::Cancelled)
        ));
    }

    #[test]
    fn grayscale_high_bit_depth_and_float_layouts_are_rejected() {
        for image in [
            DynamicImage::new_luma8(1, 1),
            DynamicImage::new_luma_a8(1, 1),
            DynamicImage::new_rgb16(1, 1),
            DynamicImage::new_rgba16(1, 1),
            DynamicImage::new_rgb32f(1, 1),
            DynamicImage::new_rgba32f(1, 1),
        ] {
            assert!(matches!(
                encode(&image, 50, &CancellationToken::new()),
                Err(GoopError::InvalidRequest(_))
            ));
        }
    }

    #[test]
    fn captured_source_detects_exact_byte_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.webp");
        DynamicImage::new_rgb8(8, 8).save(&input).unwrap();
        let cancel = CancellationToken::new();
        let source = WebpSource::capture(&input, &cancel).unwrap();
        let decoded = source.decode(&cancel).unwrap();
        assert!(matches!(
            decoded,
            DynamicImage::ImageRgb8(_) | DynamicImage::ImageRgba8(_)
        ));
        DynamicImage::new_rgba8(8, 8).save(&input).unwrap();
        assert!(source.verify_unchanged(&input, &cancel).is_err());
    }

    #[test]
    fn unsupported_png_layouts_reject_before_pixel_allocation() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let luma = dir.path().join("luma.png");
        DynamicImage::new_luma8(2, 2).save(&luma).unwrap();
        assert!(matches!(
            WebpSource::capture(&luma, &cancel).and_then(|source| source.decode(&cancel)),
            Err(GoopError::InvalidRequest(_))
        ));

        let rgb16 = dir.path().join("rgb16.png");
        DynamicImage::new_rgb16(2, 2).save(&rgb16).unwrap();
        assert!(matches!(
            WebpSource::capture(&rgb16, &cancel).and_then(|source| source.decode(&cancel)),
            Err(GoopError::InvalidRequest(_))
        ));
    }

    #[test]
    fn pixel_ceiling_is_checked_without_allocating_the_raster() {
        assert!(validate_raster(10_001, 10_000, 4).is_err());
    }

    #[test]
    fn invalid_or_truncated_encoder_output_is_rejected() {
        for bytes in [
            &b""[..],
            &b"RIFF\x04\x00\x00\x00NOPE"[..],
            &b"RIFF\x10\x00\x00\x00WEBP"[..],
        ] {
            assert!(verify_container(bytes).is_err());
        }
    }
}
