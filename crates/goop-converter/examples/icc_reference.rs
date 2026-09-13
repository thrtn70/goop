use image::{DynamicImage, ImageBuffer, ImageFormat, ImageReader, Limits, Rgb, RgbaImage};
use lcms2::{Intent, PixelFormat, Profile, Transform};
use std::error::Error;
use std::io::Read;
use std::path::Path;

const MAX_PROFILE_BYTES: usize = 15 * 1024 * 1024;
const MAX_PIXELS: u64 = 4_000_000;
const MAX_DECODE_BYTES_PER_PIXEL: u64 = 16;

fn read_bounded_profile(path: &Path) -> Result<Vec<u8>, Box<dyn Error>> {
    let file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_PROFILE_BYTES as u64 {
        return Err(
            format!("ICC profile must be a file of at most {MAX_PROFILE_BYTES} bytes").into(),
        );
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PROFILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_PROFILE_BYTES {
        return Err(format!("ICC profile exceeds {MAX_PROFILE_BYTES} bytes").into());
    }
    Ok(bytes)
}

fn decode_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_PIXELS as u32);
    limits.max_image_height = Some(MAX_PIXELS as u32);
    limits.max_alloc = Some(MAX_PIXELS * MAX_DECODE_BYTES_PER_PIXEL);
    limits
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), Box<dyn Error>> {
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if pixels > MAX_PIXELS {
        return Err(format!("image exceeds {MAX_PIXELS} pixels").into());
    }
    Ok(())
}

fn read_bounded_image(path: &Path) -> Result<(DynamicImage, ImageFormat), Box<dyn Error>> {
    let mut dimensions_reader = ImageReader::open(path)?.with_guessed_format()?;
    let format = dimensions_reader
        .format()
        .ok_or("input image format is unknown")?;
    dimensions_reader.limits(decode_limits());
    let (width, height) = dimensions_reader.into_dimensions()?;
    validate_dimensions(width, height)?;

    let mut reader = ImageReader::open(path)?.with_guessed_format()?;
    if reader.format() != Some(format) {
        return Err("input image format changed while it was being read".into());
    }
    reader.limits(decode_limits());
    let image = reader.decode()?;
    validate_dimensions(image.width(), image.height())?;
    Ok((image, format))
}

fn exact_cmyk_samples(
    image: DynamicImage,
    format: ImageFormat,
) -> Result<RgbaImage, Box<dyn Error>> {
    if format != ImageFormat::Png {
        return Err("CMYK sample carrier must be a PNG".into());
    }
    match image {
        DynamicImage::ImageRgba8(samples) => Ok(samples),
        _ => Err("CMYK sample carrier must contain exact 8-bit RGBA samples".into()),
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args_os().skip(1);
    let layout = args.next().ok_or("missing layout: rgb, gray, or cmyk")?;
    let profile_path = args.next().ok_or("missing source profile path")?;
    let input_path = args.next().ok_or("missing input image path")?;
    let output_path = args.next().ok_or("missing output image path")?;
    if args.next().is_some() {
        return Err("unexpected extra argument".into());
    }

    let profile_bytes = read_bounded_profile(Path::new(&profile_path))?;
    let source_profile = Profile::new_icc(&profile_bytes)?;
    let destination_profile = Profile::new_srgb();
    let (image, input_format) = read_bounded_image(Path::new(&input_path))?;

    let output = match layout.to_str() {
        Some("rgb") => {
            let source = image.to_rgb8();
            let transform = Transform::new(
                &source_profile,
                PixelFormat::RGB_8,
                &destination_profile,
                PixelFormat::RGB_8,
                Intent::Perceptual,
            )?;
            let source: Vec<[u8; 3]> = source.pixels().map(|pixel| pixel.0).collect();
            let mut destination = vec![[0_u8; 3]; source.len()];
            transform.transform_pixels(&source, &mut destination);
            ImageBuffer::<Rgb<u8>, _>::from_raw(
                image.width(),
                image.height(),
                destination.into_iter().flatten().collect::<Vec<_>>(),
            )
            .ok_or("failed to construct RGB output")?
        }
        Some("gray") => {
            let source = image.to_luma8();
            let transform = Transform::new(
                &source_profile,
                PixelFormat::GRAY_8,
                &destination_profile,
                PixelFormat::RGB_8,
                Intent::Perceptual,
            )?;
            let source: Vec<u8> = source.pixels().map(|pixel| pixel.0[0]).collect();
            let mut destination = vec![[0_u8; 3]; source.len()];
            transform.transform_pixels(&source, &mut destination);
            ImageBuffer::<Rgb<u8>, _>::from_raw(
                image.width(),
                image.height(),
                destination.into_iter().flatten().collect::<Vec<_>>(),
            )
            .ok_or("failed to construct RGB output")?
        }
        // The reference-only CMYK input is an RGBA PNG whose four byte
        // channels carry exact C, M, Y and K samples. This avoids letting an
        // image decoder perform an implicit CMYK conversion before Little CMS.
        Some("cmyk") => {
            let source = exact_cmyk_samples(image, input_format)?;
            let (width, height) = source.dimensions();
            let transform = Transform::new(
                &source_profile,
                PixelFormat::CMYK_8,
                &destination_profile,
                PixelFormat::RGB_8,
                Intent::Perceptual,
            )?;
            let source: Vec<[u8; 4]> = source.pixels().map(|pixel| pixel.0).collect();
            let mut destination = vec![[0_u8; 3]; source.len()];
            transform.transform_pixels(&source, &mut destination);
            ImageBuffer::<Rgb<u8>, _>::from_raw(
                width,
                height,
                destination.into_iter().flatten().collect::<Vec<_>>(),
            )
            .ok_or("failed to construct RGB output")?
        }
        _ => return Err("layout must be rgb, gray, or cmyk".into()),
    };

    output.save(Path::new(&output_path))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_dimensions_above_the_raster_limit() {
        assert!(validate_dimensions(2_000, 2_000).is_ok());
        assert!(validate_dimensions(2_001, 2_000).is_err());
        assert!(validate_dimensions(u32::MAX, u32::MAX).is_err());
    }

    #[test]
    fn rejects_profiles_above_the_byte_limit_before_reading_them() {
        let directory = tempfile::tempdir().expect("create temporary directory");
        let path = directory.path().join("oversized.icc");
        let file = std::fs::File::create(&path).expect("create sparse profile");
        file.set_len(MAX_PROFILE_BYTES as u64 + 1)
            .expect("size sparse profile");

        let error = read_bounded_profile(&path).expect_err("oversized profile must fail");
        assert!(error.to_string().contains("at most"));
    }

    #[test]
    fn rejects_a_highly_compressible_oversized_raster_before_decode() {
        let directory = tempfile::tempdir().expect("create temporary directory");
        let path = directory.path().join("oversized.png");
        ImageBuffer::<image::Luma<u8>, Vec<u8>>::from_pixel(2_001, 2_000, image::Luma([0]))
            .save(&path)
            .expect("write compressed raster fixture");

        let error = read_bounded_image(&path).expect_err("oversized raster must fail");
        assert!(error.to_string().contains("exceeds"));
    }

    #[test]
    fn cmyk_carrier_requires_exact_rgba8_png_samples() {
        let rgb8 = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(1, 1, Rgb([1, 2, 3])));
        assert!(exact_cmyk_samples(rgb8, ImageFormat::Png).is_err());

        let rgba16 =
            DynamicImage::ImageRgba16(ImageBuffer::from_pixel(1, 1, image::Rgba([1, 2, 3, 4])));
        assert!(exact_cmyk_samples(rgba16, ImageFormat::Png).is_err());

        let rgba8 =
            DynamicImage::ImageRgba8(ImageBuffer::from_pixel(1, 1, image::Rgba([1, 2, 3, 4])));
        assert!(exact_cmyk_samples(rgba8.clone(), ImageFormat::Jpeg).is_err());
        assert_eq!(
            exact_cmyk_samples(rgba8, ImageFormat::Png)
                .expect("exact carrier")
                .get_pixel(0, 0)
                .0,
            [1, 2, 3, 4]
        );
    }
}
