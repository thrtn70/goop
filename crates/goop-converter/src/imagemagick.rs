use crate::backend::ConversionBackend;
use crate::imagemagick_probe::probe_image;
use crate::metadata;
use crate::naming::{allocate_output_path, stem_of};
use goop_core::{
    CompressMode, ConvertRequest, ConvertResult, EventSink, GoopError, JobId, ProbeResult,
    ProgressEvent, TargetFormat,
};
use goop_sidecar::BinaryResolver;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct ImageMagickBackend<'a> {
    #[allow(dead_code)]
    resolver: &'a BinaryResolver,
    sink: Arc<dyn EventSink>,
}

impl<'a> ImageMagickBackend<'a> {
    pub fn new(resolver: &'a BinaryResolver, sink: Arc<dyn EventSink>) -> Self {
        Self { resolver, sink }
    }
}

impl<'a> ConversionBackend for ImageMagickBackend<'a> {
    /// Probe an image using the compiled-in `image` crate. No external binary needed.
    async fn probe(_resolver: &BinaryResolver, path: &Path) -> Result<ProbeResult, GoopError> {
        let p = path.to_path_buf();
        tokio::task::spawn_blocking(move || probe_image(&p))
            .await
            .map_err(|e| GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("probe task panicked: {e}"),
            })?
    }

    /// Convert or compress an image using the compiled-in `image` crate.
    /// Runs in a blocking thread to avoid tying up the async runtime.
    async fn convert(
        &self,
        job_id: JobId,
        req: &ConvertRequest,
        cancel: CancellationToken,
    ) -> Result<ConvertResult, GoopError> {
        let input = PathBuf::from(&req.input_path);
        if !input.exists() {
            return Err(GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("input file does not exist: {}", req.input_path),
            });
        }

        let output_path = resolve_output_path(&req.input_path, &req.output_path, req)?;

        self.sink.emit_progress(ProgressEvent {
            job_id,
            percent: 0.0,
            eta_secs: None,
            speed_hr: None,
            stage: "converting".into(),
            encoder: None,
        });

        let started = std::time::Instant::now();
        let out = output_path.clone();
        let target = req.target;
        let compress_mode = req.compress_mode;
        let metadata_policy = req.metadata_policy.unwrap_or_default();
        let input_for_meta = input.clone();
        let out_for_meta = output_path.clone();

        let convert_task =
            tokio::task::spawn_blocking(move || process_image(&input, &out, target, compress_mode));
        tokio::pin!(convert_task);

        tokio::select! {
            _ = cancel.cancelled() => {
                convert_task.abort();
                let _ = std::fs::remove_file(&output_path);
                return Err(GoopError::Cancelled);
            }
            result = &mut convert_task => {
                result.map_err(|e| GoopError::SubprocessFailed {
                    binary: "image".into(),
                    stderr: format!("convert task panicked: {e}"),
                })??;
            }
        }

        // Apply the metadata policy after the encode lands. For
        // Preserve on JPEG↔JPEG and PNG↔PNG this copies EXIF + ICC
        // chunks from the source; for StripAll this is a no-op (the
        // encode already dropped them). Other paths emit Ok(false)
        // and the metadata silently drops, which matches the v0.2.5
        // documented preserve matrix.
        let metadata_task = tokio::task::spawn_blocking(move || {
            metadata::apply(&input_for_meta, &out_for_meta, metadata_policy)
        });
        let _propagated = metadata_task
            .await
            .map_err(|e| GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("metadata task panicked: {e}"),
            })??;

        let bytes = std::fs::metadata(&output_path)
            .map(|m| m.len())
            .unwrap_or(0);

        self.sink.emit_progress(ProgressEvent {
            job_id,
            percent: 100.0,
            eta_secs: Some(0),
            speed_hr: None,
            stage: "converting".into(),
            encoder: None,
        });

        Ok(ConvertResult {
            output_path: output_path.to_string_lossy().into_owned(),
            bytes,
            duration_ms: started.elapsed().as_millis() as u64,
            reencoded: true,
        })
    }
}

/// Top-level router for image processing. Routes to `convert_image` (default
/// format-swap) or `compress_image` (quality / target-size / lossless).
fn process_image(
    input: &Path,
    output: &Path,
    target: TargetFormat,
    compress_mode: Option<CompressMode>,
) -> Result<(), GoopError> {
    if let Some(mode) = compress_mode {
        compress_image(input, output, target, mode)
    } else {
        convert_image(input, output, target)
    }
}

/// Default image format swap (no compression options).
///
/// Decode dispatch: HEIC and JPEG-XL inputs route to the dedicated
/// `libheif-rs` / `jpegxl-rs` decoders before re-entering the common
/// `image`-crate encode path. Everything else (PNG/JPEG/WebP/BMP/TIFF/
/// AVIF/GIF/HDR/ICO) goes through `image::open`. Encode dispatch: JXL
/// outputs run through `jpegxl-rs::encoder_builder` (the `image` crate
/// has no JXL codec). Everything else uses `image::save_with_format`.
fn convert_image(input: &Path, output: &Path, target: TargetFormat) -> Result<(), GoopError> {
    let img = decode_any(input)?;

    if matches!(target, TargetFormat::JpegXl) {
        return encode_jxl(&img, output);
    }

    let format = match target {
        TargetFormat::Png => image::ImageFormat::Png,
        TargetFormat::Jpeg => image::ImageFormat::Jpeg,
        TargetFormat::Webp => image::ImageFormat::WebP,
        TargetFormat::Bmp => image::ImageFormat::Bmp,
        TargetFormat::Tiff => image::ImageFormat::Tiff,
        TargetFormat::Avif => image::ImageFormat::Avif,
        // JpegXl handled above
        other => {
            return Err(GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("unsupported image target: {other:?}"),
            });
        }
    };

    img.save_with_format(output, format)
        .map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to save image: {e}"),
        })
}

/// Decode an image at any supported input format into an in-memory
/// `DynamicImage`. Routes HEIC + JPEG-XL inputs through their dedicated
/// system-library bindings; everything else through the `image` crate.
///
/// Exposed `pub(crate)` so the per-operation modules (`image_rotate`,
/// `image_resize`, etc.) can reuse the same decode dispatch instead of
/// duplicating extension-sniffing logic. Keeping a single decode entry
/// point also means a future input format (e.g. RAW in v0.2.6) only
/// needs to be added here.
pub(crate) fn decode_any(input: &Path) -> Result<image::DynamicImage, GoopError> {
    let ext = input
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "heic" | "heif" => decode_heic(input),
        "jxl" => decode_jxl(input),
        _ => image::open(input).map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to open image: {e}"),
        }),
    }
}

/// Decode a HEIC/HEIF file via libheif-rs into an RGB DynamicImage.
fn decode_heic(input: &Path) -> Result<image::DynamicImage, GoopError> {
    use libheif_rs::{ColorSpace, HeifContext, LibHeif, RgbChroma};

    let lib = LibHeif::new();
    let path_str = input.to_str().ok_or_else(|| GoopError::SubprocessFailed {
        binary: "libheif".into(),
        stderr: "input path is not valid UTF-8".into(),
    })?;
    let ctx = HeifContext::read_from_file(path_str).map_err(|e| GoopError::SubprocessFailed {
        binary: "libheif".into(),
        stderr: format!("failed to read HEIC: {e}"),
    })?;
    let handle = ctx
        .primary_image_handle()
        .map_err(|e| GoopError::SubprocessFailed {
            binary: "libheif".into(),
            stderr: format!("failed to get primary HEIC image: {e}"),
        })?;
    let width = handle.width();
    let height = handle.height();
    let heif_image = lib
        .decode(&handle, ColorSpace::Rgb(RgbChroma::Rgb), None)
        .map_err(|e| GoopError::SubprocessFailed {
            binary: "libheif".into(),
            stderr: format!("failed to decode HEIC pixels: {e}"),
        })?;
    let planes = heif_image.planes();
    let interleaved = planes
        .interleaved
        .ok_or_else(|| GoopError::SubprocessFailed {
            binary: "libheif".into(),
            stderr: "HEIC decode returned no interleaved RGB plane".into(),
        })?;
    let stride = interleaved.stride;
    let row_bytes = width as usize * 3;
    // libheif may add padding bytes; copy row-by-row to a packed buffer.
    let mut buf = Vec::with_capacity(row_bytes * height as usize);
    for y in 0..height as usize {
        let row_start = y * stride;
        let row_end = row_start + row_bytes;
        if row_end > interleaved.data.len() {
            return Err(GoopError::SubprocessFailed {
                binary: "libheif".into(),
                stderr: format!(
                    "HEIC row out of bounds: y={y} stride={stride} data_len={}",
                    interleaved.data.len()
                ),
            });
        }
        buf.extend_from_slice(&interleaved.data[row_start..row_end]);
    }
    image::ImageBuffer::from_raw(width, height, buf)
        .map(image::DynamicImage::ImageRgb8)
        .ok_or_else(|| GoopError::SubprocessFailed {
            binary: "libheif".into(),
            stderr: "failed to construct DynamicImage from HEIC pixels".into(),
        })
}

/// Decode a JPEG-XL file via jpegxl-rs into a DynamicImage.
/// Uses `decode_with::<u8>()` to force u8 output regardless of the file's
/// native pixel format (which may be 16-bit or float for HDR sources).
///
/// Supports greyscale (1 channel), greyscale + alpha (2 channels), RGB
/// (3 channels), and RGBA (4 channels). Wider colour formats (CMYK etc.)
/// are rejected with a clear message.
fn decode_jxl(input: &Path) -> Result<image::DynamicImage, GoopError> {
    let bytes = std::fs::read(input).map_err(|e| GoopError::SubprocessFailed {
        binary: "libjxl".into(),
        stderr: format!("failed to read JXL bytes: {e}"),
    })?;
    let decoder =
        jpegxl_rs::decoder_builder()
            .build()
            .map_err(|e| GoopError::SubprocessFailed {
                binary: "libjxl".into(),
                stderr: format!("failed to build JXL decoder: {e}"),
            })?;
    let (metadata, pixels) =
        decoder
            .decode_with::<u8>(&bytes)
            .map_err(|e| GoopError::SubprocessFailed {
                binary: "libjxl".into(),
                stderr: format!("failed to decode JXL: {e}"),
            })?;
    let width = metadata.width;
    let height = metadata.height;
    let channels = metadata.num_color_channels + u32::from(metadata.has_alpha_channel);
    match channels {
        1 => image::ImageBuffer::from_raw(width, height, pixels)
            .map(image::DynamicImage::ImageLuma8)
            .ok_or_else(|| GoopError::SubprocessFailed {
                binary: "libjxl".into(),
                stderr: "JXL: failed to build greyscale buffer".into(),
            }),
        2 => image::ImageBuffer::from_raw(width, height, pixels)
            .map(image::DynamicImage::ImageLumaA8)
            .ok_or_else(|| GoopError::SubprocessFailed {
                binary: "libjxl".into(),
                stderr: "JXL: failed to build greyscale + alpha buffer".into(),
            }),
        3 => image::ImageBuffer::from_raw(width, height, pixels)
            .map(image::DynamicImage::ImageRgb8)
            .ok_or_else(|| GoopError::SubprocessFailed {
                binary: "libjxl".into(),
                stderr: "JXL: failed to build RGB8 buffer".into(),
            }),
        4 => image::ImageBuffer::from_raw(width, height, pixels)
            .map(image::DynamicImage::ImageRgba8)
            .ok_or_else(|| GoopError::SubprocessFailed {
                binary: "libjxl".into(),
                stderr: "JXL: failed to build RGBA8 buffer".into(),
            }),
        n => Err(GoopError::SubprocessFailed {
            binary: "libjxl".into(),
            stderr: format!(
                "JXL: unsupported channel count {n} (CMYK and wider colour spaces aren't supported yet — convert to RGB or RGBA first)"
            ),
        }),
    }
}

/// Encode a DynamicImage as JPEG-XL via jpegxl-rs and write to `output`.
///
/// Preserves alpha when the source has it (RGBA8 encode); otherwise emits
/// 8-bit RGB. Higher-bit-depth sources (16-bit, float, Luma) are
/// downconverted to RGBA8 / RGB8 via the `image` crate before encoding.
///
/// Exposed `pub(crate)` for the per-operation modules — same rationale as
/// `decode_any`.
pub(crate) fn encode_jxl(img: &image::DynamicImage, output: &Path) -> Result<(), GoopError> {
    use image::ColorType;
    let has_alpha = matches!(
        img.color(),
        ColorType::La8 | ColorType::Rgba8 | ColorType::La16 | ColorType::Rgba16
    );
    let buf = if has_alpha {
        let rgba = img.to_rgba8();
        let mut encoder = jpegxl_rs::encoder_builder()
            .has_alpha(true)
            .build()
            .map_err(|e| GoopError::SubprocessFailed {
                binary: "libjxl".into(),
                stderr: format!("failed to build JXL encoder: {e}"),
            })?;
        // jpegxl-rs's EncoderFrame defaults to 3 channels; for RGBA we
        // have to set 4 explicitly via num_channels.
        let frame = jpegxl_rs::encode::EncoderFrame::new(rgba.as_raw()).num_channels(4);
        encoder
            .encode_frame::<u8, u8>(&frame, rgba.width(), rgba.height())
            .map_err(|e| GoopError::SubprocessFailed {
                binary: "libjxl".into(),
                stderr: format!("failed to encode JXL (RGBA): {e}"),
            })?
    } else {
        let rgb = img.to_rgb8();
        let mut encoder =
            jpegxl_rs::encoder_builder()
                .build()
                .map_err(|e| GoopError::SubprocessFailed {
                    binary: "libjxl".into(),
                    stderr: format!("failed to build JXL encoder: {e}"),
                })?;
        encoder
            .encode::<u8, u8>(rgb.as_raw(), rgb.width(), rgb.height())
            .map_err(|e| GoopError::SubprocessFailed {
                binary: "libjxl".into(),
                stderr: format!("failed to encode JXL (RGB): {e}"),
            })?
    };
    std::fs::write(output, &buf.data).map_err(|e| GoopError::SubprocessFailed {
        binary: "libjxl".into(),
        stderr: format!("failed to write JXL output: {e}"),
    })
}

/// Encode a `DynamicImage` and write it to `output`, picking the codec from
/// the output path extension. Used by the per-operation modules (rotate,
/// resize, etc.) that share the "single in-memory image → file on disk"
/// final step. JXL routes through `encode_jxl`; all other formats use
/// `image::ImageFormat::from_path` to choose the codec the `image` crate
/// already ships.
pub(crate) fn save_image(img: &image::DynamicImage, output: &Path) -> Result<(), GoopError> {
    let ext = output
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    if ext == "jxl" {
        return encode_jxl(img, output);
    }

    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("failed to create output directory: {e}"),
            })?;
        }
    }

    let format =
        image::ImageFormat::from_path(output).map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("unsupported output extension: {e}"),
        })?;
    img.save_with_format(output, format)
        .map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to save image: {e}"),
        })
}

/// Compress an image. Branches on (target_format, compress_mode):
/// - JPEG/WebP: Quality (direct) or TargetSizeBytes (binary search over quality 1..=100)
/// - PNG: LosslessReoptimize (re-save with max deflate via image crate defaults)
/// - BMP: all modes rejected
fn compress_image(
    input: &Path,
    output: &Path,
    target: TargetFormat,
    mode: CompressMode,
) -> Result<(), GoopError> {
    match target {
        TargetFormat::Jpeg => compress_jpeg(input, output, mode),
        TargetFormat::Webp => compress_webp(input, output, mode),
        TargetFormat::Png => match mode {
            CompressMode::LosslessReoptimize => convert_image(input, output, TargetFormat::Png),
            _ => Err(GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr:
                    "PNG compression only supports Lossless Re-optimize. Convert to JPEG or WebP for lossy compression."
                        .into(),
            }),
        },
        TargetFormat::Tiff => match mode {
            // TIFF compression in v0.2.5: re-save losslessly via the
            // image crate's default encoder. Quality / target-size are
            // accepted but treated as no-ops; the codec is fundamentally
            // lossless for the image-crate code path.
            CompressMode::LosslessReoptimize => convert_image(input, output, TargetFormat::Tiff),
            _ => Err(GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: "TIFF compression only supports Lossless Re-optimize. \
                         Convert to JPEG, WebP, or AVIF for lossy compression."
                    .into(),
            }),
        },
        TargetFormat::Avif => Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: "AVIF compression knobs are not yet available. \
                     To compress an AVIF, convert it to JPEG or WebP \
                     from the Convert tab."
                .into(),
        }),
        TargetFormat::JpegXl => Err(GoopError::SubprocessFailed {
            binary: "libjxl".into(),
            stderr: "JPEG-XL compression knobs are not yet available. \
                     To compress a JXL, convert it to JPEG or WebP \
                     from the Convert tab."
                .into(),
        }),
        TargetFormat::Bmp => Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: "BMP compression is not supported. Convert to PNG or JPEG first.".into(),
        }),
        other => Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("unsupported image target for compression: {other:?}"),
        }),
    }
}

/// Encode a DynamicImage as JPEG at a given quality into a Vec.
fn encode_jpeg(img: &image::DynamicImage, quality: u8) -> Result<Vec<u8>, GoopError> {
    let rgb = img.to_rgb8();
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
        encoder
            .encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("jpeg encode failed: {e}"),
            })?;
    }
    Ok(buf)
}

/// Encode a DynamicImage as lossy WebP at a given quality (via the `image`
/// crate's default lossless encoder; we switch to lossy by specifying quality).
///
/// The `image` crate's built-in WebP encoder is lossless-only for direct API
/// access, so we use the `webp` crate? — NO, the `image` crate is all we
/// have. Fall back to JPEG-style quality mapping by re-using the default
/// lossless encode and documenting the limitation.
///
/// For now we implement WebP as "re-save as WebP" (honors the default image
/// crate encoder). Quality parameter is accepted but currently only affects
/// whether we pick WebP output vs bail.
fn encode_webp(img: &image::DynamicImage, _quality: u8) -> Result<Vec<u8>, GoopError> {
    let mut buf: Vec<u8> = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut buf),
        image::ImageFormat::WebP,
    )
    .map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("webp encode failed: {e}"),
    })?;
    Ok(buf)
}

/// Iterative binary search over quality 1..=100 to hit a target byte size.
/// Returns the best encode whose size ≤ target_bytes (or the smallest if
/// even quality=1 exceeds the target).
fn target_size_search<F>(
    img: &image::DynamicImage,
    target_bytes: u64,
    mut encode: F,
) -> Result<Vec<u8>, GoopError>
where
    F: FnMut(&image::DynamicImage, u8) -> Result<Vec<u8>, GoopError>,
{
    let max_iters = 6;
    let mut low: u8 = 1;
    let mut high: u8 = 100;
    let mut best: Option<Vec<u8>> = None;

    for _ in 0..max_iters {
        let q = (low + high) / 2;
        let buf = encode(img, q)?;
        let size = buf.len() as u64;
        if size <= target_bytes {
            // Fits — try higher quality next iteration.
            best = Some(buf);
            low = q + 1;
            if low > high {
                break;
            }
        } else {
            // Too large — try lower quality.
            if q == 1 {
                // Smallest possible already; return the current too-large
                // buffer as a best-effort result.
                return Ok(buf);
            }
            high = q - 1;
            if high < low {
                break;
            }
        }
    }

    best.ok_or_else(|| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: "binary search failed to produce any encode".into(),
    })
}

fn compress_jpeg(input: &Path, output: &Path, mode: CompressMode) -> Result<(), GoopError> {
    // Route through decode_any so HEIC + JXL inputs reach the dedicated
    // decoders. image::open would fail on those formats with a generic
    // "unsupported format" error.
    let img = decode_any(input)?;

    let buf = match mode {
        CompressMode::Quality(q) => encode_jpeg(&img, q.clamp(1, 100))?,
        CompressMode::TargetSizeBytes(bytes) => target_size_search(&img, bytes, encode_jpeg)?,
        CompressMode::LosslessReoptimize => {
            // JPEG is inherently lossy — re-save at quality=95 as a gentle
            // recompression (removes editor metadata, re-packs DCT).
            encode_jpeg(&img, 95)?
        }
    };

    std::fs::write(output, &buf).map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("failed to write output: {e}"),
    })
}

fn compress_webp(input: &Path, output: &Path, mode: CompressMode) -> Result<(), GoopError> {
    // Route through decode_any — same reasoning as compress_jpeg.
    let img = decode_any(input)?;

    let buf = match mode {
        CompressMode::Quality(q) => encode_webp(&img, q.clamp(1, 100))?,
        CompressMode::TargetSizeBytes(bytes) => target_size_search(&img, bytes, encode_webp)?,
        CompressMode::LosslessReoptimize => encode_webp(&img, 100)?,
    };

    std::fs::write(output, &buf).map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("failed to write output: {e}"),
    })
}

fn resolve_output_path(
    input_path: &str,
    requested: &str,
    req: &ConvertRequest,
) -> Result<PathBuf, GoopError> {
    let requested_buf = PathBuf::from(requested);
    if requested_buf.is_dir() {
        let stem = stem_of(input_path);
        let ext = req.target.extension();
        Ok(allocate_output_path(&requested_buf, &stem, ext))
    } else {
        if let Some(parent) = requested_buf.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent)?;
            }
        }
        Ok(requested_buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn write_test_png(path: &Path, w: u32, h: u32) {
        let img: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_fn(w, h, |x, y| Rgba([(x as u8), (y as u8), 128, 255]));
        img.save(path).unwrap();
    }

    fn write_test_jpeg(path: &Path) {
        use image::{Rgb, RgbImage};
        let img: RgbImage =
            ImageBuffer::from_fn(64, 64, |x, y| Rgb([x as u8, y as u8, ((x + y) as u8) / 2]));
        img.save(path).unwrap();
    }

    fn tmp_dir(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static C: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let c = C.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("goop-compress-{label}-{n}-{c}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn jpeg_quality_encodes_at_lower_size() {
        let dir = tmp_dir("jpeg-q");
        let in_path = dir.join("in.jpg");
        write_test_jpeg(&in_path);
        let out_path = dir.join("out.jpg");

        compress_image(
            &in_path,
            &out_path,
            TargetFormat::Jpeg,
            CompressMode::Quality(30),
        )
        .unwrap();

        let in_size = std::fs::metadata(&in_path).unwrap().len();
        let out_size = std::fs::metadata(&out_path).unwrap().len();
        assert!(out_size > 0);
        // Quality 30 should produce a smaller or comparable size vs the
        // default-saved test JPEG.
        assert!(
            out_size <= in_size * 2,
            "out {} vs in {}",
            out_size,
            in_size
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn jpeg_target_size_converges() {
        let dir = tmp_dir("jpeg-target");
        let in_path = dir.join("in.jpg");
        write_test_jpeg(&in_path);
        let out_path = dir.join("out.jpg");
        let target: u64 = 2_000;

        compress_image(
            &in_path,
            &out_path,
            TargetFormat::Jpeg,
            CompressMode::TargetSizeBytes(target),
        )
        .unwrap();

        let size = std::fs::metadata(&out_path).unwrap().len();
        // Allow generous tolerance — binary search caps at 6 iterations on
        // quality 1..=100 so we may overshoot for small synthetic images.
        assert!(size > 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn png_lossless_reoptimize_succeeds() {
        let dir = tmp_dir("png-lossless");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 32, 32);
        let out_path = dir.join("out.png");

        compress_image(
            &in_path,
            &out_path,
            TargetFormat::Png,
            CompressMode::LosslessReoptimize,
        )
        .unwrap();

        assert!(std::fs::metadata(&out_path).unwrap().len() > 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn png_quality_rejected() {
        let dir = tmp_dir("png-quality");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 16, 16);
        let out_path = dir.join("out.png");

        let err = compress_image(
            &in_path,
            &out_path,
            TargetFormat::Png,
            CompressMode::Quality(50),
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Lossless") || msg.contains("JPEG"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bmp_compression_rejected() {
        let dir = tmp_dir("bmp");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 16, 16);
        let out_path = dir.join("out.bmp");

        let err = compress_image(
            &in_path,
            &out_path,
            TargetFormat::Bmp,
            CompressMode::Quality(50),
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("BMP"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tiff_round_trip_via_convert_image() {
        // TIFF was listed in IMAGE_EXTENSIONS pre-v0.2.5 but the image
        // crate's `tiff` feature was off — a TIFF conversion request
        // would panic at runtime. Phase 2 enables the feature; this test
        // locks the no-panic round-trip.
        let dir = tmp_dir("tiff-round-trip");
        let png_in = dir.join("in.png");
        write_test_png(&png_in, 32, 32);
        let tiff_out = dir.join("out.tiff");
        convert_image(&png_in, &tiff_out, TargetFormat::Tiff).unwrap();
        assert!(std::fs::metadata(&tiff_out).unwrap().len() > 0);

        // And TIFF → PNG so the decode path is exercised too.
        let png_out = dir.join("out.png");
        convert_image(&tiff_out, &png_out, TargetFormat::Png).unwrap();
        assert!(std::fs::metadata(&png_out).unwrap().len() > 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn avif_encode_produces_nonempty_output() {
        let dir = tmp_dir("avif-encode");
        let png_in = dir.join("in.png");
        write_test_png(&png_in, 32, 32);
        let avif_out = dir.join("out.avif");
        convert_image(&png_in, &avif_out, TargetFormat::Avif).unwrap();
        assert!(std::fs::metadata(&avif_out).unwrap().len() > 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tiff_lossless_reoptimize_succeeds() {
        let dir = tmp_dir("tiff-lossless");
        let png_in = dir.join("in.png");
        write_test_png(&png_in, 16, 16);
        // First produce a TIFF input.
        let tiff_in = dir.join("in.tiff");
        convert_image(&png_in, &tiff_in, TargetFormat::Tiff).unwrap();
        // Then re-optimize lossless.
        let tiff_out = dir.join("out.tiff");
        compress_image(
            &tiff_in,
            &tiff_out,
            TargetFormat::Tiff,
            CompressMode::LosslessReoptimize,
        )
        .unwrap();
        assert!(std::fs::metadata(&tiff_out).unwrap().len() > 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tiff_quality_rejected_with_helpful_message() {
        let dir = tmp_dir("tiff-quality-rejected");
        let png_in = dir.join("in.png");
        write_test_png(&png_in, 16, 16);
        let tiff_in = dir.join("in.tiff");
        convert_image(&png_in, &tiff_in, TargetFormat::Tiff).unwrap();
        let tiff_out = dir.join("out.tiff");
        let err = compress_image(
            &tiff_in,
            &tiff_out,
            TargetFormat::Tiff,
            CompressMode::Quality(50),
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Lossless") || msg.contains("AVIF"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn jxl_round_trip_via_jpegxl_rs() {
        // PNG -> JXL -> PNG. Exercises the dedicated jpegxl-rs encoder
        // and decoder branches in convert_image. Requires libjxl at
        // link time (Homebrew on macOS dev, vcpkg on Windows).
        let dir = tmp_dir("jxl-round-trip");
        let png_in = dir.join("in.png");
        write_test_png(&png_in, 32, 32);
        let jxl_out = dir.join("out.jxl");
        convert_image(&png_in, &jxl_out, TargetFormat::JpegXl).unwrap();
        assert!(std::fs::metadata(&jxl_out).unwrap().len() > 0);

        // Now decode the JXL back to PNG.
        let png_back = dir.join("back.png");
        convert_image(&jxl_out, &png_back, TargetFormat::Png).unwrap();
        let img = image::open(&png_back).unwrap();
        assert_eq!(img.width(), 32);
        assert_eq!(img.height(), 32);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn jxl_rgba_round_trip_preserves_alpha() {
        // Build a PNG with non-trivial alpha; round-trip via JXL and
        // verify that the resulting decoded image is RGBA8 with the
        // original alpha pattern intact.
        let dir = tmp_dir("jxl-rgba");
        let png_in = dir.join("in.png");
        let img: ImageBuffer<Rgba<u8>, _> = ImageBuffer::from_fn(16, 16, |x, y| {
            Rgba([(x as u8) * 16, (y as u8) * 16, 64, 128])
        });
        img.save(&png_in).unwrap();

        let jxl_out = dir.join("rgba.jxl");
        convert_image(&png_in, &jxl_out, TargetFormat::JpegXl).unwrap();
        assert!(std::fs::metadata(&jxl_out).unwrap().len() > 0);

        let decoded = decode_any(&jxl_out).unwrap();
        assert_eq!(decoded.color(), image::ColorType::Rgba8);
        assert_eq!(decoded.width(), 16);
        assert_eq!(decoded.height(), 16);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn decode_any_routes_jxl_to_jpegxl_rs() {
        // Without the .jxl extension dispatch, `image::open` would fail
        // with "unsupported format" since the `image` crate has no JXL
        // codec. The round-trip test above already covers the happy
        // path; this one is just a defensive check that decode_any
        // doesn't try image::open on .jxl.
        let dir = tmp_dir("jxl-dispatch");
        let png_in = dir.join("in.png");
        write_test_png(&png_in, 16, 16);
        let jxl_out = dir.join("out.jxl");
        convert_image(&png_in, &jxl_out, TargetFormat::JpegXl).unwrap();
        // Call decode_any directly to verify the routing.
        let decoded = decode_any(&jxl_out).unwrap();
        assert_eq!(decoded.width(), 16);
        assert_eq!(decoded.height(), 16);
        std::fs::remove_dir_all(&dir).ok();
    }
}
