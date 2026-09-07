//! Explicit JPEG rendering in a caller-owned staging file.
use goop_core::{GoopError, ImageConvertOptions, ImageResize, MetadataPolicy};
use image::{DynamicImage, ImageDecoder, ImageFormat};
use std::{fs::File, io::BufWriter, path::Path};

pub(crate) const MAX_ALLOC: u64 = 512 * 1024 * 1024;
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

pub(crate) fn render(
    input: &Path,
    output: &Path,
    options: &ImageConvertOptions,
    policy: MetadataPolicy,
) -> Result<(), GoopError> {
    crate::image_options::validate_options(options)?;
    let ext = input.extension().and_then(|e| e.to_str()).unwrap_or("");
    let mut pixels = if crate::raw::is_raw_extension(ext) {
        // The native bridge validates actual RAW identity and bounds before rendering.
        crate::raw::decode_raw(input)?
    } else if ext.eq_ignore_ascii_case("heic") || ext.eq_ignore_ascii_case("heif") {
        crate::imagemagick::decode_heic_explicit(input)?
    } else {
        let mut reader = image::ImageReader::open(input)?.with_guessed_format()?;
        if reader.format() != Some(ImageFormat::Jpeg) {
            return Err(error(
                "Explicit JPEG settings require a JPEG, HEIC or RAW source",
            ));
        }
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(MAX_ALLOC);
        limits.max_image_width = Some(crate::image_options::MAX_DIMENSION);
        limits.max_image_height = Some(crate::image_options::MAX_DIMENSION);
        reader.limits(limits);
        let mut decoder = reader
            .into_decoder()
            .map_err(|e| error(format!("JPEG header: {e}")))?;
        let (width, height) = decoder.dimensions();
        check_raster(
            width,
            height,
            u64::from(decoder.color_type().bytes_per_pixel()),
        )?;
        let orientation = decoder
            .orientation()
            .map_err(|e| error(format!("JPEG orientation: {e}")))?;
        let mut image =
            DynamicImage::from_decoder(decoder).map_err(|e| error(format!("JPEG pixels: {e}")))?;
        image.apply_orientation(orientation);
        image
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
    let rgb = pixels.into_rgb8();
    let mut output_file = BufWriter::new(File::create(output)?);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output_file, options.jpeg_quality)
        .encode_image(&rgb)
        .map_err(|e| error(format!("JPEG encode: {e}")))?;
    std::io::Write::flush(&mut output_file)?;
    drop(output_file);
    crate::metadata::apply_rendered_jpeg(input, output, width, height, policy)
}
