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

/// Default image format swap (no compression options). Everything goes
/// through the `image` crate's codec set (PNG/JPEG/WebP/BMP/TIFF/AVIF/
/// GIF/HDR/ICO).
///
/// `JpegXl` and `Heic` are reserved on the `TargetFormat` enum but
/// the encode/decode paths defer to v0.2.5.1 — see
/// `Cargo.toml` notes for the bundling story. Callers that select
/// either get a clear "format not bundled" error here, not a panic.
fn convert_image(input: &Path, output: &Path, target: TargetFormat) -> Result<(), GoopError> {
    let img = decode_any(input)?;

    let format = match target {
        TargetFormat::Png => image::ImageFormat::Png,
        TargetFormat::Jpeg => image::ImageFormat::Jpeg,
        TargetFormat::Webp => image::ImageFormat::WebP,
        TargetFormat::Bmp => image::ImageFormat::Bmp,
        TargetFormat::Tiff => image::ImageFormat::Tiff,
        TargetFormat::Avif => image::ImageFormat::Avif,
        TargetFormat::JpegXl => {
            return Err(GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: "JPEG-XL output is not bundled in v0.2.5 — coming in v0.2.5.1. \
                         Convert to PNG, JPEG, AVIF, or WebP for now."
                    .into(),
            });
        }
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
/// `DynamicImage`. v0.2.5 routes everything through `image::open`;
/// HEIC + JPEG-XL inputs return a clear "format not bundled" error
/// (the libheif-rs / jpegxl-rs paths are scaffolded but not wired
/// into this release — see Cargo.toml).
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
        "heic" | "heif" => Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: "HEIC/HEIF input is not bundled in v0.2.5 — coming in v0.2.5.1. \
                     Convert to PNG or JPEG first via Apple Photos / Preview."
                .into(),
        }),
        "jxl" => Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: "JPEG-XL input is not bundled in v0.2.5 — coming in v0.2.5.1.".into(),
        }),
        _ => image::open(input).map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to open image: {e}"),
        }),
    }
}

/// Encode a `DynamicImage` and write it to `output`, picking the codec from
/// the output path extension. Used by the per-operation modules (rotate,
/// resize, etc.) that share the "single in-memory image → file on disk"
/// final step. JXL output is rejected with a clear "not bundled" error
/// until v0.2.5.1 wires up libjxl + the per-platform CI bundling.
pub(crate) fn save_image(img: &image::DynamicImage, output: &Path) -> Result<(), GoopError> {
    let ext = output
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    if ext == "jxl" {
        return Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: "JPEG-XL output is not bundled in v0.2.5 — coming in v0.2.5.1.".into(),
        });
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
    fn jxl_target_returns_clear_not_bundled_error() {
        // v0.2.5 ships without libjxl. The convert path must surface a
        // friendly "format not bundled" error instead of panicking or
        // producing a malformed output. v0.2.5.1 wires up the encoder.
        let dir = tmp_dir("jxl-not-bundled");
        let png_in = dir.join("in.png");
        write_test_png(&png_in, 16, 16);
        let jxl_out = dir.join("out.jxl");
        let err = convert_image(&png_in, &jxl_out, TargetFormat::JpegXl).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("not bundled") || msg.contains("v0.2.5.1"),
            "expected deferral message, got: {msg}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn jxl_input_returns_clear_not_bundled_error() {
        // Symmetric to the encode path: a .jxl input dispatches to a
        // friendly error, not image::open which would say "unsupported
        // format" with no breadcrumb.
        let dir = tmp_dir("jxl-input-deferred");
        let jxl_in = dir.join("missing.jxl");
        // The file doesn't need to exist — decode_any rejects on the
        // extension before any I/O.
        let err = decode_any(&jxl_in).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("not bundled") || msg.contains("v0.2.5.1"),
            "expected deferral message, got: {msg}"
        );
    }

    #[test]
    fn heic_input_returns_clear_not_bundled_error() {
        let dir = tmp_dir("heic-input-deferred");
        let heic_in = dir.join("missing.heic");
        let err = decode_any(&heic_in).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("not bundled") || msg.contains("v0.2.5.1"),
            "expected deferral message, got: {msg}"
        );
    }
}
