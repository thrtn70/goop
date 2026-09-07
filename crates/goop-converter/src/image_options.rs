use goop_core::{GoopError, ImageConvertOptions, ImageResize};

pub const MAX_DIMENSION: u32 = 32_768;
pub const MAX_OUTPUT_PIXELS: u32 = 100_000_000;

fn invalid(message: impl Into<String>) -> GoopError {
    GoopError::InvalidRequest(message.into())
}

/// Rejects explicit values outside the engine's JPEG and raster limits.
pub fn validate_options(options: &ImageConvertOptions) -> Result<(), GoopError> {
    if !(1..=100).contains(&options.jpeg_quality) {
        return Err(invalid("JPEG quality must be 1–100"));
    }
    if let ImageResize::FitWithin { width, height } = options.resize {
        if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
            return Err(invalid("Fit dimensions must be 1–32768 pixels"));
        }
    }
    Ok(())
}

/// Calculates upright output dimensions without enlarging the source.
///
/// FitWithin uses checked integer cross-products and nearest-integer rounding.
/// Both source and result must satisfy the axis and 100-million-pixel limits.
pub fn output_dimensions(
    source: (u32, u32),
    resize: &ImageResize,
) -> Result<(u32, u32), GoopError> {
    validate_dimensions(source, "Source image")?;
    let result = match *resize {
        ImageResize::Original => source,
        ImageResize::FitWithin { width, height } => {
            if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
                return Err(invalid("Fit dimensions must be 1–32768 pixels"));
            }
            if source.0 <= width && source.1 <= height {
                source
            } else if u64::from(width) * u64::from(source.1)
                <= u64::from(height) * u64::from(source.0)
            {
                let scaled_height = (u64::from(source.1) * u64::from(width)
                    + u64::from(source.0) / 2)
                    / u64::from(source.0);
                (width, scaled_height.max(1).min(u64::from(height)) as u32)
            } else {
                let scaled_width = (u64::from(source.0) * u64::from(height)
                    + u64::from(source.1) / 2)
                    / u64::from(source.1);
                (scaled_width.max(1).min(u64::from(width)) as u32, height)
            }
        }
    };
    validate_dimensions(result, "Output image")?;
    Ok(result)
}

fn validate_dimensions(dimensions: (u32, u32), label: &str) -> Result<(), GoopError> {
    let (width, height) = dimensions;
    if width == 0 || height == 0 {
        return Err(invalid(format!("{label} dimensions must be non-zero")));
    }
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(invalid(format!(
            "{label} dimensions exceed the 32768-pixel axis limit"
        )));
    }
    if u64::from(width) * u64::from(height) > u64::from(MAX_OUTPUT_PIXELS) {
        return Err(invalid(format!(
            "{label} dimensions exceed the 100-million-pixel limit"
        )));
    }
    Ok(())
}
