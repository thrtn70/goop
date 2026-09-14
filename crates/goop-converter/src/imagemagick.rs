use crate::backend::ConversionBackend;
use crate::imagemagick_probe::probe_image;
use crate::metadata;
use crate::naming::{allocate_output_path, stem_of};
use goop_core::{
    AlphaCompositing, CompressMode, CompressionExecution, ConvertRequest, ConvertResult, EventSink,
    GoopError, ImageAlphaExecution, ImageAlphaPolicy, ImageColorHandling, ImageColorPolicy,
    ImageMetadataExecution, JobId, MetadataPolicy, ProbeResult, ProgressEvent, TargetFormat,
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
        if req.video_options.is_some() {
            return Err(GoopError::InvalidRequest(
                "Explicit video settings cannot be processed by the image converter".into(),
            ));
        }
        let input = PathBuf::from(&req.input_path);
        if !input.exists() {
            return Err(GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("input file does not exist: {}", req.input_path),
            });
        }

        let source_bytes = goop_core::output::source_bytes(std::slice::from_ref(&input))?;
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
        let target = req.target;
        let compress_mode = req.compress_mode;
        let metadata_policy = req.metadata_policy.unwrap_or_default();
        let target_bytes = match compress_mode {
            Some(CompressMode::TargetSizeBytes(bytes)) => Some(bytes),
            _ => None,
        };
        let explicit_request = (req.image_options.is_some()
            || req.image_color_policy.unwrap_or_default() != ImageColorPolicy::Preserve
            || req.image_alpha_policy.is_some())
        .then(|| req.clone());
        let outcome_slot = Arc::new(std::sync::Mutex::new(None));
        let worker_outcome = Arc::clone(&outcome_slot);
        let worker_cancel = cancel.clone();
        let published = staged_image_output(output_path, target_bytes, cancel, move |out| {
            let outcome = if let Some(request) = &explicit_request {
                if request.image_color_policy.unwrap_or_default() != ImageColorPolicy::Preserve {
                    process_color_managed(&input, out, request, &worker_cancel)?
                } else {
                    let source = crate::jpeg_controls::prepare(
                        &input,
                        crate::jpeg_controls::MAX_INPUT_BYTES,
                    )?;
                    let probe = crate::jpeg_controls::probe_prepared(&input, source.as_ref())?;
                    crate::capabilities::validate_request(request, &probe)?;
                    if let Some(options) = &request.image_options {
                        crate::jpeg_controls::render_prepared(
                            &input,
                            out,
                            options,
                            metadata_policy,
                            source.as_ref(),
                        )?;
                    }
                    ImageProcessingOutcome {
                        image_alpha: None,
                        image_metadata: source
                            .as_ref()
                            .map(|source| jpeg_metadata_execution(source, metadata_policy, true))
                            .transpose()?,
                        compression: None,
                    }
                }
            } else {
                process_image_with_metadata(
                    &input,
                    out,
                    target,
                    compress_mode,
                    metadata_policy,
                    &worker_cancel,
                )?
            };
            *worker_outcome
                .lock()
                .map_err(|_| image_error("image outcome lock is unavailable"))? = Some(outcome);
            Ok(())
        })
        .await?;
        let outcome = outcome_slot
            .lock()
            .map_err(|_| image_error("image outcome lock is unavailable"))?
            .take()
            .ok_or_else(|| image_error("image processing completed without an outcome"))?;

        self.sink.emit_progress(ProgressEvent {
            job_id,
            percent: 100.0,
            eta_secs: Some(0),
            speed_hr: None,
            stage: "converting".into(),
            encoder: None,
        });

        Ok(ConvertResult {
            image_alpha_execution: outcome.image_alpha,
            compression_execution: outcome.compression,
            image_metadata_execution: outcome.image_metadata,
            video_track_execution: None,
            audio_execution: None,
            video_execution: None,
            track_execution: None,
            source_bytes: Some(source_bytes),
            target_bytes,
            output_path: published.path.to_string_lossy().into_owned(),
            bytes: published.bytes,
            duration_ms: started.elapsed().as_millis() as u64,
            reencoded: true,
        })
    }
}

fn process_color_managed(
    input: &Path,
    output: &Path,
    request: &ConvertRequest,
    cancel: &CancellationToken,
) -> Result<ImageProcessingOutcome, GoopError> {
    let policy = request.image_color_policy.unwrap_or_default();
    if policy == ImageColorPolicy::Preserve {
        return Err(GoopError::InvalidRequest(
            "Preserve must use the legacy image path".into(),
        ));
    }
    goop_core::validate_image_color_request_shape(request)?;
    goop_core::validate_image_alpha_request_shape(request)?;
    if let Some(options) = request.image_options.as_ref() {
        crate::image_options::validate_options(options)?;
    }
    let _working_set = crate::color::acquire_working_set(cancel)?;
    let prepared = crate::color::prepare_path(input, cancel)?;
    crate::color::validate_policy(&prepared.inspection, request.target, policy)?;
    let orientation_normalized =
        prepared.inspection.orientation != image::metadata::Orientation::NoTransforms;
    let source_had_exif = prepared.inspection.has_exif;
    let pixels = prepared.decode()?;
    let source_had_alpha = prepared.inspection.layout.has_alpha();
    if source_had_alpha && request.image_alpha_policy.is_none() {
        return Err(GoopError::InvalidRequest(
            "JPEG removes transparency; choose an explicit background before converting.".into(),
        ));
    }
    if source_had_alpha && request.target != TargetFormat::Jpeg {
        return Err(GoopError::InvalidRequest(
            "Transparency flattening is currently available only for JPEG output.".into(),
        ));
    }
    let mut transformed = if request.image_alpha_policy.is_some() {
        crate::color::transform_and_flatten_pixels(
            pixels,
            prepared.inspection.profile.clone(),
            policy,
            request.image_alpha_policy,
            cancel,
        )?
    } else {
        crate::color::transform_pixels(pixels, prepared.inspection.profile.clone(), policy, cancel)?
    };
    if let Some(options) = request.image_options.as_ref() {
        let dimensions = crate::image_options::output_dimensions(
            transformed.pixels.dimensions(),
            &options.resize,
        )?;
        if dimensions != transformed.pixels.dimensions() {
            transformed.pixels = image::imageops::resize(
                &transformed.pixels,
                dimensions.0,
                dimensions.1,
                image::imageops::FilterType::Lanczos3,
            );
        }
    }
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    let jpeg_quality = request
        .image_options
        .as_ref()
        .map_or(75, |options| options.jpeg_quality);
    let bytes = crate::color::encode_tagged(&transformed, request.target, jpeg_quality, cancel)?;
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    write_jpeg_output(
        output,
        &bytes,
        cancel,
        "failed to write verified color-managed image output",
    )?;
    prepared.verify_unchanged(input)?;
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    let mut notices = vec![match policy {
        ImageColorPolicy::ConvertToSrgb => {
            "Pixels were converted from the embedded profile to sRGB; the source ICC profile was replaced."
        }
        ImageColorPolicy::AssumeSrgb => {
            "The untagged source was explicitly assumed to be sRGB."
        }
        ImageColorPolicy::Preserve => unreachable!(),
    }
    .into()];
    notices.push(if source_had_exif {
        "Source EXIF was omitted so stale color and orientation tags cannot describe the transformed output."
            .into()
    } else {
        "Only the canonical destination sRGB profile was attached.".into()
    });
    if request.metadata_policy.unwrap_or_default() == MetadataPolicy::StripAll {
        notices.push(
            "All source metadata was removed; the generated destination sRGB profile was retained to describe the output pixels."
                .into(),
        );
    }
    Ok(ImageProcessingOutcome {
        image_alpha: request.image_alpha_policy.map(|requested_policy| {
            let background = match requested_policy {
                ImageAlphaPolicy::Flatten { background } => background,
            };
            ImageAlphaExecution {
                requested_policy,
                source_had_alpha,
                flattened: source_had_alpha,
                background,
                compositing: AlphaCompositing::LinearSrgb,
            }
        }),
        image_metadata: Some(ImageMetadataExecution {
            requested_policy: request.metadata_policy.unwrap_or_default(),
            requested_color_policy: policy,
            exif_retained: false,
            icc_retained: false,
            destination_srgb_profile_attached: true,
            orientation_normalized,
            color_handling: transformed.handling,
            notices,
        }),
        compression: None,
    })
}

#[derive(Debug, Default)]
struct ImageProcessingOutcome {
    image_metadata: Option<ImageMetadataExecution>,
    compression: Option<CompressionExecution>,
    image_alpha: Option<ImageAlphaExecution>,
}

fn jpeg_metadata_execution(
    source: &crate::jpeg_controls::JpegSource,
    policy: MetadataPolicy,
    normalize_preserve_orientation: bool,
) -> Result<ImageMetadataExecution, GoopError> {
    let inspection = source.inspect_metadata(metadata::JpegOutputColor::Rgb)?;
    let icc_retained = inspection.source_has_icc && policy == MetadataPolicy::Preserve;
    let exif_retained = inspection.source_has_exif && policy == MetadataPolicy::Preserve;
    let orientation_normalized = (policy != MetadataPolicy::Preserve
        || normalize_preserve_orientation)
        && matches!(
            inspection.orientation,
            crate::exif_geometry::OrientationStatus::Valid(value)
                if value != image::metadata::Orientation::NoTransforms
        );
    let color_handling = if icc_retained {
        ImageColorHandling::ExactProfileRetained
    } else if policy == MetadataPolicy::StripAll {
        ImageColorHandling::NoProfile
    } else {
        ImageColorHandling::Untagged
    };
    let notice = match policy {
        MetadataPolicy::Preserve if icc_retained => {
            "Supported metadata and the exact ICC profile were retained."
        }
        MetadataPolicy::Preserve => "The source had no ICC profile to retain.",
        MetadataPolicy::RemovePersonal => "Personal metadata removed from an untagged JPEG.",
        MetadataPolicy::StripAll => "All metadata removed; no color profile retained.",
    };
    Ok(ImageMetadataExecution {
        requested_policy: policy,
        requested_color_policy: ImageColorPolicy::Preserve,
        exif_retained,
        icc_retained,
        destination_srgb_profile_attached: false,
        orientation_normalized,
        color_handling,
        notices: vec![notice.into()],
    })
}

fn image_error(message: impl Into<String>) -> GoopError {
    GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: message.into(),
    }
}

struct ImageDestination {
    path: PathBuf,
    automatic_name: Option<(String, &'static str)>,
}

impl From<PathBuf> for ImageDestination {
    fn from(path: PathBuf) -> Self {
        Self {
            path,
            automatic_name: None,
        }
    }
}

#[derive(Debug)]
struct PublishedImage {
    path: PathBuf,
    bytes: u64,
}

/// Private same-filesystem workspace. Dropping a cancelled worker's result
/// removes staging; the blocking worker never publishes the destination.
struct StagedImage {
    _staging: goop_core::output::StagedOutput,
    path: PathBuf,
    bytes: u64,
}
impl StagedImage {
    fn new(destination: &Path) -> Result<Self, GoopError> {
        let staging = goop_core::output::StagedOutput::new(destination)?;
        Ok(Self {
            path: staging.path().to_path_buf(),
            _staging: staging,
            bytes: 0,
        })
    }
}

fn prepare_image_output<F>(
    destination: &Path,
    target_bytes: Option<u64>,
    cancel: &CancellationToken,
    work: F,
) -> Result<StagedImage, GoopError>
where
    F: FnOnce(&Path) -> Result<(), GoopError>,
{
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    let mut staged = StagedImage::new(destination)?;
    work(&staged.path)?;
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    staged.bytes = staged._staging.validate(None, false)?.bytes;
    if staged.bytes == 0 {
        return Err(image_error("image encoder produced an empty output"));
    }
    if let Some(target) = target_bytes {
        if staged.bytes > target {
            return Err(image_error(format!("target size requested {target} bytes, but final output is {} bytes after metadata; strip metadata or increase the target", staged.bytes)));
        }
    }
    Ok(staged)
}

use goop_core::output::publish_no_replace as publish_image;

async fn finish_image_output(
    mut worker: tokio::task::JoinHandle<Result<StagedImage, GoopError>>,
    destination: ImageDestination,
    cancel: CancellationToken,
) -> Result<PublishedImage, GoopError> {
    let staged = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(GoopError::Cancelled),
        result = &mut worker => result.map_err(|e| image_error(format!("convert task panicked: {e}")))??,
    };
    // This synchronous no-clobber commit is the completion boundary. A late
    // cancellation after it succeeds belongs to an already completed operation.
    let mut path = destination.path.clone();
    for suffix in 1..=10_000 {
        if cancel.is_cancelled() {
            return Err(GoopError::Cancelled);
        }
        match publish_image(&staged.path, &path) {
            Ok(()) => {
                return Ok(PublishedImage {
                    path,
                    bytes: staged.bytes,
                })
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::AlreadyExists
                    && destination.automatic_name.is_some() =>
            {
                if let Some((stem, ext)) = &destination.automatic_name {
                    path = destination
                        .path
                        .with_file_name(format!("{stem} ({suffix}).{ext}"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Unsupported => {
                return Err(image_error(format!("destination filesystem does not support atomic publishing; choose another destination: {e}")));
            }
            Err(e) => {
                return Err(image_error(format!(
                    "cannot publish image output without replacing an existing file: {e}"
                )))
            }
        }
    }
    Err(image_error(
        "cannot allocate an unused image output name after 10000 publication attempts",
    ))
}

async fn staged_image_output<F>(
    destination: ImageDestination,
    target_bytes: Option<u64>,
    cancel: CancellationToken,
    work: F,
) -> Result<PublishedImage, GoopError>
where
    F: FnOnce(&Path) -> Result<(), GoopError> + Send + 'static,
{
    let worker_path = destination.path.clone();
    let worker_cancel = cancel.clone();
    let worker = tokio::task::spawn_blocking(move || {
        prepare_image_output(&worker_path, target_bytes, &worker_cancel, work)
    });
    finish_image_output(worker, destination, cancel).await
}

fn process_image_with_cancel(
    input: &Path,
    output: &Path,
    target: TargetFormat,
    compress_mode: Option<CompressMode>,
    cancel: &CancellationToken,
) -> Result<(), GoopError> {
    if let Some(mode) = compress_mode {
        compress_image_with_cancel(input, output, target, mode, cancel)
    } else {
        convert_image(input, output, target)
    }
}

fn process_image_with_metadata(
    input: &Path,
    output: &Path,
    target: TargetFormat,
    compress_mode: Option<CompressMode>,
    policy: MetadataPolicy,
    cancel: &CancellationToken,
) -> Result<ImageProcessingOutcome, GoopError> {
    if target == TargetFormat::Jpeg {
        if let Some(source) =
            crate::jpeg_controls::prepare(input, crate::jpeg_controls::MAX_INPUT_BYTES)?
        {
            let is_jpeg = source.bytes.starts_with(&[0xff, 0xd8, 0xff]);
            let needs_snapshot_path = is_jpeg;
            if needs_snapshot_path {
                return process_snapshot_jpeg(
                    &source,
                    input,
                    output,
                    compress_mode,
                    policy,
                    cancel,
                );
            }
        }
    }
    if policy == MetadataPolicy::RemovePersonal {
        return Err(GoopError::InvalidRequest(
            "Remove personal data is currently available only for JPEG to JPEG processing.".into(),
        ));
    }
    process_image_with_cancel(input, output, target, compress_mode, cancel)?;
    metadata::apply(input, output, policy)?;
    let image_metadata = (target == TargetFormat::Webp
        && matches!(compress_mode, Some(CompressMode::Quality(_))))
    .then(|| ImageMetadataExecution {
        requested_policy: policy,
        requested_color_policy: ImageColorPolicy::Preserve,
        exif_retained: false,
        icc_retained: false,
        destination_srgb_profile_attached: false,
        orientation_normalized: false,
        color_handling: if policy == MetadataPolicy::StripAll {
            ImageColorHandling::NoProfile
        } else {
            ImageColorHandling::Untagged
        },
        notices: vec![
            "Lossy WebP output is untagged; source metadata was not retained. Color-managed conversion is not established yet."
                .into(),
        ],
    });
    Ok(ImageProcessingOutcome {
        image_alpha: None,
        image_metadata,
        compression: None,
    })
}

fn process_snapshot_jpeg(
    source: &crate::jpeg_controls::JpegSource,
    input: &Path,
    output: &Path,
    compress_mode: Option<CompressMode>,
    policy: MetadataPolicy,
    cancel: &CancellationToken,
) -> Result<ImageProcessingOutcome, GoopError> {
    let (pixels, plan) =
        source.decode_with_target_metadata_plan(policy, metadata::JpegOutputColor::Rgb)?;
    let (bytes, compression) = match compress_mode {
        Some(CompressMode::LosslessReoptimize) => {
            return Err(image_error(
                "JPEG lossless reoptimization is unavailable; choose Quality or Target Size for lossy recompression",
            ))
        }
        Some(CompressMode::TargetSizeBytes(target_bytes)) => {
            let selected = target_size_search(
                pixels,
                target_bytes,
                image::DynamicImage::into_rgb8,
                |image, quality| plan.assemble_candidate(encode_jpeg(image, quality)?),
                || {
                    if cancel.is_cancelled() {
                        Err(GoopError::Cancelled)
                    } else {
                        Ok(())
                    }
                },
            )
            .map_err(|error| match error {
                GoopError::Cancelled => GoopError::Cancelled,
                other => image_error(format!(
                    "{}; metadata policy: {}",
                    other.user_message(),
                    metadata_policy_name(policy)
                )),
            })?;
            let final_bytes = selected.bytes.len() as u64;
            let execution = CompressionExecution {
                requested_mode: CompressMode::TargetSizeBytes(target_bytes),
                attempts: selected.attempts,
                selected_quality: Some(selected.quality),
                target_bytes: Some(target_bytes),
                final_bytes,
                target_met: final_bytes <= target_bytes,
                metadata_policy: policy,
            };
            (selected.bytes, Some(execution))
        }
        Some(CompressMode::Quality(quality)) => {
            let pixels = pixels.into_rgb8();
            (
                plan.assemble_candidate(encode_jpeg(&pixels, quality.clamp(1, 100))?)?,
                None,
            )
        }
        None => {
            let pixels = pixels.into_rgb8();
            (plan.assemble_candidate(encode_jpeg(&pixels, 75)?)?, None)
        }
    };
    verify_and_write_snapshot_jpeg(&plan, output, &bytes, cancel)?;
    source.verify_unchanged(input, crate::jpeg_controls::MAX_INPUT_BYTES)?;
    Ok(ImageProcessingOutcome {
        image_alpha: None,
        image_metadata: Some(jpeg_metadata_execution(source, policy, false)?),
        compression,
    })
}

fn verify_and_write_snapshot_jpeg(
    plan: &metadata::JpegMetadataPlan,
    output: &Path,
    bytes: &[u8],
    cancel: &CancellationToken,
) -> Result<(), GoopError> {
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    plan.verify_candidate(bytes)?;
    write_jpeg_output(
        output,
        bytes,
        cancel,
        "failed to write metadata-verified JPEG output",
    )
}

fn write_jpeg_output(
    output: &Path,
    bytes: &[u8],
    cancel: &CancellationToken,
    error_context: &str,
) -> Result<(), GoopError> {
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    std::fs::write(output, bytes).map_err(|error| image_error(format!("{error_context}: {error}")))
}

fn metadata_policy_name(policy: MetadataPolicy) -> &'static str {
    match policy {
        MetadataPolicy::Preserve => "preserve",
        MetadataPolicy::RemovePersonal => "remove personal data",
        MetadataPolicy::StripAll => "remove all",
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
    let img = if target == TargetFormat::Jpeg {
        decode_for_jpeg_output(input)?
    } else {
        decode_any(input)?
    };

    if target == TargetFormat::Jpeg && img.color().has_alpha() {
        return Err(GoopError::InvalidRequest(
            "JPEG removes transparency; choose an explicit background before converting.".into(),
        ));
    }

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
/// statically-linked C-library bindings; everything else through the
/// `image` crate.
///
/// Exposed `pub(crate)` so the per-operation modules (`image_rotate`,
/// `image_resize`, etc.) can reuse the same decode dispatch instead of
/// duplicating extension-sniffing logic. Keeping a single decode entry
/// point also means a future input format (e.g. RAW) only needs to be
/// added here.
pub(crate) fn decode_any(input: &Path) -> Result<image::DynamicImage, GoopError> {
    let ext = input
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    if crate::raw::is_raw_extension(&ext) {
        return crate::raw::decode_raw(input);
    }

    match ext.as_str() {
        "jxl" => decode_jxl(input),
        "heic" | "heif" => decode_heic(input),
        _ => image::open(input).map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to open image: {e}"),
        }),
    }
}

/// Decode a HEIC/HEIF file via libheif-rs into an RGB DynamicImage.
fn decode_heic(input: &Path) -> Result<image::DynamicImage, GoopError> {
    decode_heic_with_limits(input, false)
}

pub(crate) fn decode_heic_explicit(input: &Path) -> Result<image::DynamicImage, GoopError> {
    decode_heic_with_limits(input, true)
}

fn decode_for_jpeg_output(input: &Path) -> Result<image::DynamicImage, GoopError> {
    let is_heic = input
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("heic") || extension.eq_ignore_ascii_case("heif")
        });
    if is_heic {
        decode_heic_explicit(input)
    } else {
        decode_any(input)
    }
}

fn decode_heic_with_limits(input: &Path, explicit: bool) -> Result<image::DynamicImage, GoopError> {
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
    if explicit {
        crate::jpeg_controls::check_raster(width, height, 3)?;
        if handle.has_alpha_channel() {
            return Err(GoopError::InvalidRequest(
                "JPEG removes transparency; choose an explicit background before converting."
                    .into(),
            ));
        }
        if crate::heif_header::primary_item_format(input, handle.item_id())? != "HEIC" {
            return Err(image_error(
                "Explicit JPEG settings require HEIC image data",
            ));
        }
    }
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
/// - JPEG: Quality (direct) or TargetSizeBytes (exhaustive quality 100 down to 1)
/// - WebP: Quality (lossy libwebp) or LosslessReoptimize (image crate)
/// - PNG: LosslessReoptimize (re-save with max deflate via image crate defaults)
/// - BMP: all modes rejected
#[cfg(test)]
fn compress_image(
    input: &Path,
    output: &Path,
    target: TargetFormat,
    mode: CompressMode,
) -> Result<(), GoopError> {
    compress_image_with_cancel(input, output, target, mode, &CancellationToken::new())
}

fn compress_image_with_cancel(
    input: &Path,
    output: &Path,
    target: TargetFormat,
    mode: CompressMode,
    cancel: &CancellationToken,
) -> Result<(), GoopError> {
    match target {
        TargetFormat::Jpeg => compress_jpeg_with_cancel(input, output, mode, cancel),
        TargetFormat::Webp => compress_webp(input, output, mode, cancel),
        TargetFormat::Png => match mode {
            CompressMode::LosslessReoptimize => convert_image(input, output, TargetFormat::Png),
            _ => Err(GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr:
                    "PNG compression only supports Lossless Re-optimize. Convert to JPEG for lossy compression."
                        .into(),
            }),
        },
        TargetFormat::Tiff => match mode {
            // The compiled-in TIFF encoder supports lossless re-saving only.
            CompressMode::LosslessReoptimize => convert_image(input, output, TargetFormat::Tiff),
            _ => Err(GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: "TIFF compression only supports Lossless Re-optimize. \
                         Convert to JPEG for lossy compression."
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

/// Encode prepared RGB8 pixels as JPEG at a given quality into a Vec.
fn encode_jpeg(img: &image::RgbImage, quality: u8) -> Result<Vec<u8>, GoopError> {
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
        encoder
            .encode(
                img.as_raw(),
                img.width(),
                img.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("jpeg encode failed: {e}"),
            })?;
    }
    Ok(buf)
}

/// Encode WebP using the compiled-in lossless encoder.
fn encode_webp(img: &image::DynamicImage) -> Result<Vec<u8>, GoopError> {
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

#[derive(Debug)]
struct TargetSizeEncoding {
    bytes: Vec<u8>,
    quality: u8,
    attempts: u8,
}

/// Search from quality 100 down to 1. Every candidate supplied by `encode`
/// must already include its final metadata/container bytes, so the first fit
/// is the highest proven fitting quality without assuming size monotonicity.
/// Quality 1 is not a safe lower-bound sentinel: JPEG entropy coding can make
/// a higher-quality candidate smaller for some pixel patterns.
fn target_size_search<P, F, C>(
    img: image::DynamicImage,
    target_bytes: u64,
    prepare: P,
    mut encode: F,
    mut checkpoint: C,
) -> Result<TargetSizeEncoding, GoopError>
where
    P: FnOnce(image::DynamicImage) -> image::RgbImage,
    F: FnMut(&image::RgbImage, u8) -> Result<Vec<u8>, GoopError>,
    C: FnMut() -> Result<(), GoopError>,
{
    checkpoint()?;
    let prepared = prepare(img);
    checkpoint()?;
    let mut smallest = u64::MAX;
    for (index, quality) in (1u8..=100).rev().enumerate() {
        checkpoint()?;
        let buf = encode(&prepared, quality)?;
        checkpoint()?;
        let size = buf.len() as u64;
        smallest = smallest.min(size);
        if buf.len() as u64 <= target_bytes {
            return Ok(TargetSizeEncoding {
                bytes: buf,
                quality,
                attempts: (index + 1) as u8,
            });
        }
    }
    Err(image_error(format!(
        "target size requested {target_bytes} bytes; smallest attempted final size was {smallest} bytes after 100 attempts"
    )))
}

#[cfg(test)]
fn compress_jpeg(input: &Path, output: &Path, mode: CompressMode) -> Result<(), GoopError> {
    compress_jpeg_with_cancel(input, output, mode, &CancellationToken::new())
}

fn compress_jpeg_with_cancel(
    input: &Path,
    output: &Path,
    mode: CompressMode,
    cancel: &CancellationToken,
) -> Result<(), GoopError> {
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    if matches!(mode, CompressMode::LosslessReoptimize) {
        return Err(image_error("JPEG lossless reoptimization is unavailable; choose Quality or Target Size for lossy recompression"));
    }
    // Route through decode_any so HEIC + JXL inputs reach the dedicated
    // decoders. image::open would fail on those formats with a generic
    // "unsupported format" error.
    let img = decode_for_jpeg_output(input)?;
    if img.color().has_alpha() {
        return Err(GoopError::InvalidRequest(
            "JPEG removes transparency; choose an explicit background before compressing.".into(),
        ));
    }

    let checkpoint = || {
        if cancel.is_cancelled() {
            Err(GoopError::Cancelled)
        } else {
            Ok(())
        }
    };
    let buf = match mode {
        CompressMode::Quality(q) => {
            checkpoint()?;
            let prepared = img.into_rgb8();
            checkpoint()?;
            let bytes = encode_jpeg(&prepared, q.clamp(1, 100))?;
            checkpoint()?;
            bytes
        }
        CompressMode::TargetSizeBytes(bytes) => {
            target_size_search(
                img,
                bytes,
                image::DynamicImage::into_rgb8,
                encode_jpeg,
                checkpoint,
            )?
            .bytes
        }
        CompressMode::LosslessReoptimize => unreachable!("rejected before decoding"),
    };

    write_jpeg_output(output, &buf, cancel, "failed to write output")
}

fn compress_webp(
    input: &Path,
    output: &Path,
    mode: CompressMode,
    cancel: &CancellationToken,
) -> Result<(), GoopError> {
    if matches!(mode, CompressMode::TargetSizeBytes(_)) {
        return Err(image_error(
            "WebP Target Size is not available; choose Quality or Lossless",
        ));
    }
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    let buf = match mode {
        CompressMode::Quality(quality) => {
            let source = crate::webp_lossy::WebpSource::capture(input, cancel)?;
            let image = source.decode(cancel)?;
            let bytes = crate::webp_lossy::encode(&image, quality, cancel)?;
            write_jpeg_output(output, &bytes, cancel, "failed to write WebP output")?;
            if let Err(error) = source.verify_unchanged(input, cancel) {
                let _ = std::fs::remove_file(output);
                return Err(error);
            }
            return Ok(());
        }
        CompressMode::LosslessReoptimize => encode_webp(&decode_any(input)?)?,
        CompressMode::TargetSizeBytes(_) => unreachable!("rejected before decoding"),
    };
    write_jpeg_output(output, &buf, cancel, "failed to write WebP output")
}

fn resolve_output_path(
    input_path: &str,
    requested: &str,
    req: &ConvertRequest,
) -> Result<ImageDestination, GoopError> {
    let requested_buf = PathBuf::from(requested);
    if requested_buf.is_dir() {
        let stem = stem_of(input_path);
        let ext = req.target.extension();
        Ok(ImageDestination {
            path: allocate_output_path(&requested_buf, &stem, ext),
            automatic_name: Some((stem, ext)),
        })
    } else {
        if let Some(parent) = requested_buf.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent)?;
            }
        }
        Ok(requested_buf.into())
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

    fn color_request(input: &Path, output: &Path, target: TargetFormat) -> ConvertRequest {
        serde_json::from_value(serde_json::json!({
            "input_path": input,
            "output_path": output,
            "target": target,
            "quality_preset": null,
            "resolution_cap": null,
            "gif_options": null,
            "compress_mode": null,
            "batch_id": null,
            "metadata_policy": "preserve",
            "image_color_policy": "assume_srgb",
            "subtitle": null,
            "image_options": null
        }))
        .unwrap()
    }

    struct SilentSink;
    impl EventSink for SilentSink {
        fn emit_progress(&self, _: ProgressEvent) {}
        fn emit_queue(&self, _: goop_core::QueueEvent) {}
        fn emit_sidecar(&self, _: goop_core::SidecarEvent) {}
    }

    #[tokio::test]
    async fn transparent_png_requires_background_and_never_publishes_legacy_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("transparent.png");
        let output = dir.path().join("output.jpg");
        image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 255, 0]))
            .save(&input)
            .unwrap();
        let request: ConvertRequest = serde_json::from_value(serde_json::json!({
            "input_path": input,
            "output_path": output,
            "target": "jpeg"
        }))
        .unwrap();
        let resolver = BinaryResolver::new(dir.path().to_owned());
        let backend = ImageMagickBackend::new(&resolver, Arc::new(SilentSink));

        let error = backend
            .convert(JobId::new(), &request, CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.user_message().contains("background"));
        assert!(!output.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn legacy_heic_jpeg_paths_refuse_alpha_before_decode_and_keep_opaque_compatibility() {
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let resolver = BinaryResolver::new(fixtures.clone());
        let backend = ImageMagickBackend::new(&resolver, Arc::new(SilentSink));
        let directory = tempfile::tempdir().unwrap();

        for (index, compress_mode) in [None, Some(CompressMode::Quality(75))]
            .into_iter()
            .enumerate()
        {
            let output = directory.path().join(format!("alpha-{index}.jpg"));
            let request: ConvertRequest = serde_json::from_value(serde_json::json!({
                "input_path": fixtures.join("alpha.heic"),
                "output_path": output,
                "target": "jpeg",
                "compress_mode": compress_mode
            }))
            .unwrap();

            let error = backend
                .convert(JobId::new(), &request, CancellationToken::new())
                .await
                .unwrap_err();
            assert!(error.user_message().contains("background"), "{error:?}");
            assert!(!output.exists());
        }

        let opaque_output = directory.path().join("opaque.jpg");
        let opaque: ConvertRequest = serde_json::from_value(serde_json::json!({
            "input_path": fixtures.join("sample.heic"),
            "output_path": opaque_output,
            "target": "jpeg"
        }))
        .unwrap();
        backend
            .convert(JobId::new(), &opaque, CancellationToken::new())
            .await
            .unwrap();
        assert!(opaque_output.exists());
    }

    #[tokio::test]
    async fn explicit_flatten_precedes_resize_and_reports_verified_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("transparent.png");
        let output = dir.path().join("output.jpg");
        let pixels =
            image::RgbaImage::from_raw(3, 1, vec![0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255])
                .unwrap();
        pixels.save(&input).unwrap();
        let mut request = color_request(&input, &output, TargetFormat::Jpeg);
        request.image_alpha_policy = Some(ImageAlphaPolicy::Flatten {
            background: goop_core::SrgbColor {
                red: 0,
                green: 0,
                blue: 0,
            },
        });
        request.image_options = Some(goop_core::ImageConvertOptions {
            jpeg_quality: 100,
            resize: goop_core::ImageResize::FitWithin {
                width: 1,
                height: 1,
            },
        });
        let resolver = BinaryResolver::new(dir.path().to_owned());
        let backend = ImageMagickBackend::new(&resolver, Arc::new(SilentSink));

        let result = backend
            .convert(JobId::new(), &request, CancellationToken::new())
            .await
            .unwrap();
        let receipt = result.image_alpha_execution.unwrap();
        assert!(receipt.source_had_alpha);
        assert!(receipt.flattened);
        assert_eq!(receipt.compositing, AlphaCompositing::LinearSrgb);
        let output_pixel = image::open(&output).unwrap().to_rgb8().get_pixel(0, 0).0;
        assert!(
            output_pixel.iter().all(|channel| *channel <= 2),
            "flatten-before-resize must stay black, got {output_pixel:?}"
        );
    }

    #[tokio::test]
    async fn explicit_background_is_inert_for_opaque_source_except_for_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("opaque.png");
        let legacy_output = dir.path().join("legacy.jpg");
        let explicit_output = dir.path().join("explicit.jpg");
        image::RgbImage::from_fn(16, 8, |x, y| {
            image::Rgb([x as u8 * 11, y as u8 * 23, (x + y) as u8 * 7])
        })
        .save(&input)
        .unwrap();
        let resolver = BinaryResolver::new(dir.path().to_owned());
        let backend = ImageMagickBackend::new(&resolver, Arc::new(SilentSink));

        let legacy = backend
            .convert(
                JobId::new(),
                &color_request(&input, &legacy_output, TargetFormat::Jpeg),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let mut explicit = color_request(&input, &explicit_output, TargetFormat::Jpeg);
        let background = goop_core::SrgbColor {
            red: 239,
            green: 41,
            blue: 83,
        };
        explicit.image_alpha_policy = Some(ImageAlphaPolicy::Flatten { background });
        let explicit = backend
            .convert(JobId::new(), &explicit, CancellationToken::new())
            .await
            .unwrap();

        let legacy_pixels = image::open(&legacy_output).unwrap().to_rgb8();
        let explicit_pixels = image::open(&explicit_output).unwrap().to_rgb8();
        assert_eq!(legacy_pixels.dimensions(), (16, 8));
        assert_eq!(explicit_pixels.dimensions(), (16, 8));
        assert_eq!(legacy_pixels, explicit_pixels);

        let legacy_inspection =
            crate::color::inspect_bytes(std::fs::read(&legacy_output).unwrap().into()).unwrap();
        let explicit_inspection =
            crate::color::inspect_bytes(std::fs::read(&explicit_output).unwrap().into()).unwrap();
        assert_eq!(legacy_inspection.layout, explicit_inspection.layout);
        assert_eq!(legacy_inspection.dimensions, explicit_inspection.dimensions);
        assert!(!legacy_inspection.has_exif);
        assert!(!explicit_inspection.has_exif);

        let verify_srgb_profile = |profile: Option<Vec<u8>>| {
            use lcms2::{Intent, PixelFormat, Profile, Transform};

            let profile = profile.expect("managed JPEG must carry a destination profile");
            assert_eq!(crate::color::validate_profile(&profile).unwrap(), b"RGB ");
            let source = Profile::new_icc(&profile).expect("destination profile must parse");
            let destination = Profile::new_srgb();
            let transform = Transform::new(
                &source,
                PixelFormat::RGB_8,
                &destination,
                PixelFormat::RGB_8,
                Intent::Perceptual,
            )
            .expect("destination profile must describe transformable sRGB");
            let samples = [[0_u8, 0, 0], [32, 96, 192], [255, 255, 255]];
            let mut transformed = [[0_u8; 3]; 3];
            transform.transform_pixels(&samples, &mut transformed);
            assert_eq!(transformed, samples);
        };
        verify_srgb_profile(legacy_inspection.profile);
        verify_srgb_profile(explicit_inspection.profile);

        assert_eq!(legacy.image_alpha_execution, None);
        assert_eq!(
            legacy.image_metadata_execution,
            explicit.image_metadata_execution
        );
        let metadata = explicit.image_metadata_execution.unwrap();
        assert_eq!(
            metadata.requested_color_policy,
            ImageColorPolicy::AssumeSrgb
        );
        assert_eq!(metadata.color_handling, ImageColorHandling::AssumedSrgb);
        assert!(metadata.destination_srgb_profile_attached);
        let receipt = explicit.image_alpha_execution.unwrap();
        assert!(!receipt.source_had_alpha);
        assert!(!receipt.flattened);
        assert_eq!(receipt.background, background);
    }

    #[tokio::test]
    async fn opaque_png_image_settings_require_explicit_color_and_execute_when_selected() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("opaque.png");
        let output = dir.path().join("output.jpg");
        image::RgbImage::from_pixel(8, 4, image::Rgb([30, 90, 180]))
            .save(&input)
            .unwrap();
        let resolver = BinaryResolver::new(dir.path().to_owned());
        let options = goop_core::ImageConvertOptions {
            jpeg_quality: 90,
            resize: goop_core::ImageResize::FitWithin {
                width: 4,
                height: 4,
            },
        };
        let mut missing_policy: ConvertRequest = serde_json::from_value(serde_json::json!({
            "input_path": input,
            "output_path": output,
            "target": "jpeg",
            "image_options": options
        }))
        .unwrap();

        let inspection = crate::capabilities::inspect_source(&resolver, &input)
            .await
            .unwrap();
        let settings = inspection
            .capabilities
            .targets
            .iter()
            .find(|target| target.target == TargetFormat::Jpeg)
            .unwrap()
            .image_settings
            .as_ref()
            .unwrap();
        assert_eq!(
            settings.required_color_policy,
            Some(ImageColorPolicy::AssumeSrgb)
        );
        assert!(settings.preview_original_available);
        assert!(!settings.preview_fit_within);
        assert!(settings
            .preview_unavailable_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("Fit within")));

        let error = crate::capabilities::validate_request_source(&resolver, &missing_policy)
            .await
            .unwrap_err();
        assert!(error.user_message().contains("explicit color"), "{error:?}");

        missing_policy.image_color_policy = Some(ImageColorPolicy::AssumeSrgb);
        crate::capabilities::validate_request_source(&resolver, &missing_policy)
            .await
            .unwrap();
        let backend = ImageMagickBackend::new(&resolver, Arc::new(SilentSink));
        let result = backend
            .convert(JobId::new(), &missing_policy, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            image::image_dimensions(&result.output_path).unwrap(),
            (4, 2)
        );
        assert!(result.image_metadata_execution.is_some());
        assert_eq!(result.image_alpha_execution, None);
    }

    #[tokio::test]
    async fn pre_cancelled_alpha_conversion_preserves_destination_and_leaves_no_staging() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("transparent.png");
        let output = dir.path().join("output.jpg");
        image::RgbaImage::from_pixel(64, 64, image::Rgba([200, 40, 90, 128]))
            .save(&input)
            .unwrap();
        std::fs::write(&output, b"existing destination").unwrap();
        let mut request = color_request(&input, &output, TargetFormat::Jpeg);
        request.image_alpha_policy = Some(ImageAlphaPolicy::Flatten {
            background: goop_core::SrgbColor {
                red: 255,
                green: 255,
                blue: 255,
            },
        });
        let resolver = BinaryResolver::new(dir.path().to_owned());
        let backend = ImageMagickBackend::new(&resolver, Arc::new(SilentSink));
        let cancel = CancellationToken::new();
        cancel.cancel();

        let error = backend
            .convert(JobId::new(), &request, cancel)
            .await
            .unwrap_err();

        assert!(matches!(error, GoopError::Cancelled));
        assert_eq!(std::fs::read(&output).unwrap(), b"existing destination");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn transparent_webp_quality_and_target_size_refuse_before_output() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("transparent.webp");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 0]))
            .save(&input)
            .unwrap();
        for mode in [
            CompressMode::Quality(80),
            CompressMode::TargetSizeBytes(4096),
        ] {
            let output = dir.path().join(format!("{:?}.jpg", mode));
            let error = compress_jpeg_with_cancel(&input, &output, mode, &CancellationToken::new())
                .unwrap_err();
            assert!(error.user_message().contains("background"));
            assert!(!output.exists());
        }
    }

    #[test]
    fn assume_srgb_writes_verified_rgb_with_destination_profile() {
        use image::{Rgb, RgbImage};

        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("source.png");
        let output = directory.path().join("output.jpg");
        RgbImage::from_fn(8, 6, |x, y| Rgb([x as u8 * 20, y as u8 * 30, 90]))
            .save(&input)
            .unwrap();
        let request = color_request(&input, &output, TargetFormat::Jpeg);
        let outcome =
            process_color_managed(&input, &output, &request, &CancellationToken::new()).unwrap();
        let execution = outcome.image_metadata.unwrap();
        assert_eq!(
            execution.requested_color_policy,
            ImageColorPolicy::AssumeSrgb
        );
        assert_eq!(execution.color_handling, ImageColorHandling::AssumedSrgb);
        assert!(!execution.icc_retained);
        assert!(execution.destination_srgb_profile_attached);
        let inspected =
            crate::color::inspect_bytes(std::fs::read(&output).unwrap().into()).unwrap();
        assert!(inspected.profile.is_some());
        assert!(!inspected.has_exif);
    }

    #[test]
    fn convert_to_srgb_executes_tagged_rgb_product_path() {
        use image::{Rgb, RgbImage};
        use img_parts::{png::Png, ImageICC};

        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("tagged.png");
        let output = directory.path().join("output.png");
        let expected = RgbImage::from_fn(8, 6, |x, y| Rgb([x as u8 * 20, y as u8 * 30, 90]));
        expected.save(&input).unwrap();
        let mut tagged = Png::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
        tagged.set_icc_profile(Some(lcms2::Profile::new_srgb().icc().unwrap().into()));
        std::fs::write(&input, tagged.encoder().bytes()).unwrap();

        let mut request = color_request(&input, &output, TargetFormat::Png);
        request.image_color_policy = Some(ImageColorPolicy::ConvertToSrgb);
        let outcome =
            process_color_managed(&input, &output, &request, &CancellationToken::new()).unwrap();

        assert_eq!(image::open(&output).unwrap().to_rgb8(), expected);
        let execution = outcome.image_metadata.unwrap();
        assert_eq!(
            execution.requested_color_policy,
            ImageColorPolicy::ConvertToSrgb
        );
        assert_eq!(
            execution.color_handling,
            ImageColorHandling::ConvertedToSrgb
        );
        assert!(execution.destination_srgb_profile_attached);
    }

    #[test]
    fn convert_to_srgb_executes_tagged_gray_product_path() {
        use image::{GrayImage, Luma};
        use img_parts::{png::Png, ImageICC};
        use lcms2::{CIExyY, Profile, ToneCurve};

        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("tagged-gray.png");
        let output = directory.path().join("output.png");
        GrayImage::from_fn(8, 1, |x, _| Luma([x as u8 * 32]))
            .save(&input)
            .unwrap();
        let d50 = CIExyY {
            x: 0.3457,
            y: 0.3585,
            Y: 1.0,
        };
        let profile = Profile::new_gray(&d50, &ToneCurve::new(2.2))
            .unwrap()
            .icc()
            .unwrap();
        let mut tagged = Png::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
        tagged.set_icc_profile(Some(profile.into()));
        std::fs::write(&input, tagged.encoder().bytes()).unwrap();

        let mut request = color_request(&input, &output, TargetFormat::Png);
        request.image_color_policy = Some(ImageColorPolicy::ConvertToSrgb);
        process_color_managed(&input, &output, &request, &CancellationToken::new()).unwrap();

        let pixels = image::open(&output).unwrap().to_rgb8();
        assert_eq!(pixels.dimensions(), (8, 1));
        assert!(pixels
            .pixels()
            .all(|pixel| pixel.0[0] == pixel.0[1] && pixel.0[1] == pixel.0[2]));
        assert!(pixels
            .pixels()
            .collect::<Vec<_>>()
            .windows(2)
            .all(|pair| pair[0].0[0] < pair[1].0[0]));
    }

    #[test]
    fn explicit_color_refuses_unresolved_alpha_before_publication() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("alpha.png");
        let output = directory.path().join("output.png");
        write_test_png(&input, 8, 6);
        let request = color_request(&input, &output, TargetFormat::Png);
        let error = process_color_managed(&input, &output, &request, &CancellationToken::new())
            .unwrap_err();
        assert!(error.user_message().contains("background"));
        assert!(!output.exists());
    }

    #[test]
    fn explicit_color_rejects_invalid_image_options_before_source_io() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("missing.png");
        let output = directory.path().join("output.jpg");
        let mut request = color_request(&input, &output, TargetFormat::Jpeg);
        request.image_options = Some(goop_core::ImageConvertOptions {
            jpeg_quality: 0,
            resize: goop_core::ImageResize::Original,
        });

        let error = process_color_managed(&input, &output, &request, &CancellationToken::new())
            .unwrap_err();

        assert!(error.user_message().contains("quality must be 1–100"));
        assert!(!output.exists());
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

    fn write_oriented_untagged_jpeg(path: &Path) {
        use image::{Rgb, RgbImage};
        use img_parts::{jpeg::Jpeg, ImageEXIF};

        let image = RgbImage::from_fn(160, 120, |x, y| match (x < 80, y < 60) {
            (true, true) => Rgb([240, 20, 20]),
            (false, true) => Rgb([20, 240, 20]),
            (true, false) => Rgb([20, 20, 240]),
            (false, false) => Rgb([240, 240, 20]),
        });
        image.save(path).unwrap();
        let mut jpeg = Jpeg::from_bytes(std::fs::read(path).unwrap().into()).unwrap();
        jpeg.set_exif(Some(orientation_exif(6).into()));
        std::fs::write(path, jpeg.encoder().bytes()).unwrap();
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
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn publish_moves_staging_instead_of_requiring_hard_links() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("staged");
        let destination = dir.path().join("final");
        std::fs::write(&source, b"complete").unwrap();
        publish_image(&source, &destination).unwrap();
        assert!(
            !source.exists(),
            "publishing must move the staging pathname"
        );
        assert_eq!(std::fs::read(&destination).unwrap(), b"complete");
    }

    #[test]
    fn publish_collision_preserves_both_files() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("staged");
        let destination = dir.path().join("final");
        std::fs::write(&source, b"complete").unwrap();
        std::fs::write(&destination, b"original").unwrap();
        assert!(publish_image(&source, &destination).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"complete");
        assert_eq!(std::fs::read(&destination).unwrap(), b"original");
    }

    #[test]
    #[cfg(unix)]
    fn publish_does_not_replace_dangling_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("staged");
        let destination = dir.path().join("final");
        let missing = dir.path().join("missing");
        std::fs::write(&source, b"complete").unwrap();
        std::os::unix::fs::symlink(&missing, &destination).unwrap();
        assert!(publish_image(&source, &destination).is_err());
        assert_eq!(std::fs::read_link(&destination).unwrap(), missing);
        assert_eq!(std::fs::read(&source).unwrap(), b"complete");
    }

    #[tokio::test]
    async fn backend_reports_published_bytes_and_preserves_original_on_collision() {
        #[derive(Default)]
        struct Sink(std::sync::Mutex<Vec<f32>>);
        impl EventSink for Sink {
            fn emit_progress(&self, event: ProgressEvent) {
                self.0.lock().unwrap().push(event.percent);
            }
            fn emit_queue(&self, _: goop_core::QueueEvent) {}
            fn emit_sidecar(&self, _: goop_core::SidecarEvent) {}
        }
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.png");
        let output = dir.path().join("out.webp");
        write_test_png(&input, 16, 16);
        let original = std::fs::read(&input).unwrap();
        let resolver = BinaryResolver::new(dir.path().to_owned());
        let sink = Arc::new(Sink::default());
        let backend = ImageMagickBackend::new(&resolver, sink.clone());
        let mut req: ConvertRequest = serde_json::from_value(serde_json::json!({
            "input_path": input, "output_path": output, "target": TargetFormat::Webp,
            "compress_mode": CompressMode::LosslessReoptimize,
            "video_options": null,
        }))
        .unwrap();
        let result = backend
            .convert(JobId::new(), &req, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result.bytes, std::fs::metadata(&output).unwrap().len());
        assert_eq!(
            image::open(&output).unwrap().to_rgba8(),
            image::open(&input).unwrap().to_rgba8()
        );
        assert_eq!(sink.0.lock().unwrap().last(), Some(&100.0));
        sink.0.lock().unwrap().clear();
        req.output_path = input.to_string_lossy().into_owned();
        req.target = TargetFormat::Png;
        let error = backend
            .convert(JobId::new(), &req, CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("cannot publish"));
        assert_eq!(std::fs::read(&input).unwrap(), original);
        assert!(!sink.0.lock().unwrap().contains(&100.0));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[tokio::test]
    async fn target_size_result_counts_final_metadata_bytes_and_reports_execution() {
        struct Sink;
        impl EventSink for Sink {
            fn emit_progress(&self, _: ProgressEvent) {}
            fn emit_queue(&self, _: goop_core::QueueEvent) {}
            fn emit_sidecar(&self, _: goop_core::SidecarEvent) {}
        }

        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.jpg");
        let output = dir.path().join("output.jpg");
        write_test_jpeg(&input);
        let mut profile = vec![0; 4_000];
        profile[..4].copy_from_slice(&4_000u32.to_be_bytes());
        profile[16..20].copy_from_slice(b"RGB ");
        profile[36..40].copy_from_slice(b"acsp");
        let mut jpeg =
            img_parts::jpeg::Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
        use img_parts::ImageICC;
        jpeg.set_icc_profile(Some(profile.clone().into()));
        std::fs::write(&input, jpeg.encoder().bytes()).unwrap();

        let source = crate::jpeg_controls::prepare(&input, crate::jpeg_controls::MAX_INPUT_BYTES)
            .unwrap()
            .unwrap();
        let (pixels, plan) = source
            .decode_with_target_metadata_plan(
                MetadataPolicy::Preserve,
                metadata::JpegOutputColor::Rgb,
            )
            .unwrap();
        let pixels = pixels.to_rgb8();
        let mut candidates = Vec::new();
        for quality in (1..=100).rev() {
            let raw = encode_jpeg(&pixels, quality).unwrap();
            let final_bytes = plan.assemble_candidate(raw.clone()).unwrap();
            candidates.push((quality, raw.len() as u64, final_bytes.len() as u64));
        }
        let (target, expected_quality, raw_quality) = candidates
            .iter()
            .map(|(_, _, final_bytes)| *final_bytes)
            .find_map(|target| {
                let expected = candidates
                    .iter()
                    .find(|(_, _, final_bytes)| *final_bytes <= target)?
                    .0;
                let raw = candidates
                    .iter()
                    .find(|(_, raw_bytes, _)| *raw_bytes <= target)?
                    .0;
                (raw > expected).then_some((target, expected, raw))
            })
            .expect("fixture must distinguish raw and metadata-bearing candidate sizes");

        let resolver = BinaryResolver::new(dir.path().to_owned());
        let backend = ImageMagickBackend::new(&resolver, Arc::new(Sink));
        let req: ConvertRequest = serde_json::from_value(serde_json::json!({
            "input_path": input,
            "output_path": output,
            "target": TargetFormat::Jpeg,
            "compress_mode": CompressMode::TargetSizeBytes(target),
            "metadata_policy": MetadataPolicy::Preserve,
        }))
        .unwrap();
        let result = backend
            .convert(JobId::new(), &req, CancellationToken::new())
            .await
            .unwrap();
        let execution = result.compression_execution.unwrap();
        assert_eq!(execution.selected_quality, Some(expected_quality));
        assert!(raw_quality > expected_quality);
        assert_eq!(execution.attempts, 101 - expected_quality);
        assert_eq!(execution.final_bytes, result.bytes);
        assert!(execution.target_met);
        assert!(result.bytes <= target);
        assert_eq!(std::fs::metadata(&output).unwrap().len(), result.bytes);
        assert_eq!(metadata::read(&output).unwrap().1.unwrap(), profile);
        let metadata_execution = result.image_metadata_execution.unwrap();
        assert_eq!(
            metadata_execution.requested_policy,
            MetadataPolicy::Preserve
        );
        assert!(metadata_execution.icc_retained);
        assert!(!metadata_execution.orientation_normalized);
    }

    #[tokio::test]
    async fn remove_personal_target_size_normalizes_and_publishes_verified_private_jpeg() {
        struct Sink;
        impl EventSink for Sink {
            fn emit_progress(&self, _: ProgressEvent) {}
            fn emit_queue(&self, _: goop_core::QueueEvent) {}
            fn emit_sidecar(&self, _: goop_core::SidecarEvent) {}
        }

        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.jpg");
        let output = dir.path().join("output.jpg");
        write_oriented_untagged_jpeg(&input);
        let original = std::fs::read(&input).unwrap();

        let source = crate::jpeg_controls::prepare(&input, crate::jpeg_controls::MAX_INPUT_BYTES)
            .unwrap()
            .unwrap();
        let (pixels, plan) = source
            .decode_with_target_metadata_plan(
                MetadataPolicy::RemovePersonal,
                metadata::JpegOutputColor::Rgb,
            )
            .unwrap();
        let pixels = pixels.to_rgb8();
        let target = plan
            .assemble_candidate(encode_jpeg(&pixels, 75).unwrap())
            .unwrap()
            .len() as u64;
        let expected_quality = (1..=100)
            .rev()
            .find(|quality| {
                plan.assemble_candidate(encode_jpeg(&pixels, *quality).unwrap())
                    .unwrap()
                    .len() as u64
                    <= target
            })
            .unwrap();

        let resolver = BinaryResolver::new(dir.path().to_owned());
        let backend = ImageMagickBackend::new(&resolver, Arc::new(Sink));
        let req: ConvertRequest = serde_json::from_value(serde_json::json!({
            "input_path": input,
            "output_path": output,
            "target": TargetFormat::Jpeg,
            "compress_mode": CompressMode::TargetSizeBytes(target),
            "metadata_policy": MetadataPolicy::RemovePersonal,
        }))
        .unwrap();
        let result = backend
            .convert(JobId::new(), &req, CancellationToken::new())
            .await
            .unwrap();

        assert_eq!(std::fs::read(&input).unwrap(), original);
        assert_eq!(image::image_dimensions(&output).unwrap(), (120, 160));
        let rendered = image::open(&output).unwrap().to_rgb8();
        assert!(rendered.get_pixel(30, 40)[2] > 180);
        assert!(rendered.get_pixel(90, 40)[0] > 180);
        assert!(rendered.get_pixel(30, 120)[0] > 180);
        assert!(rendered.get_pixel(30, 120)[1] > 180);
        assert!(rendered.get_pixel(90, 120)[1] > 180);
        let (exif, icc) = metadata::read(&output).unwrap();
        assert!(exif.is_none());
        assert!(icc.is_none());

        let compression = result.compression_execution.unwrap();
        assert_eq!(compression.selected_quality, Some(expected_quality));
        assert_eq!(compression.attempts, 101 - expected_quality);
        assert_eq!(compression.final_bytes, result.bytes);
        assert!(compression.target_met);
        assert!(result.bytes <= target);
        let metadata = result.image_metadata_execution.unwrap();
        assert_eq!(metadata.requested_policy, MetadataPolicy::RemovePersonal);
        assert!(!metadata.exif_retained);
        assert!(!metadata.icc_retained);
        assert!(metadata.orientation_normalized);
        assert_eq!(metadata.color_handling, ImageColorHandling::Untagged);
    }

    #[tokio::test]
    async fn target_size_policies_publish_the_exact_assembled_winner() {
        struct Sink;
        impl EventSink for Sink {
            fn emit_progress(&self, _: ProgressEvent) {}
            fn emit_queue(&self, _: goop_core::QueueEvent) {}
            fn emit_sidecar(&self, _: goop_core::SidecarEvent) {}
        }

        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.jpg");
        write_oriented_untagged_jpeg(&input);
        let original = std::fs::read(&input).unwrap();
        let resolver = BinaryResolver::new(dir.path().to_owned());
        let backend = ImageMagickBackend::new(&resolver, Arc::new(Sink));

        for policy in [
            MetadataPolicy::Preserve,
            MetadataPolicy::RemovePersonal,
            MetadataPolicy::StripAll,
        ] {
            let (target, expected_quality, expected_bytes) = {
                let source =
                    crate::jpeg_controls::prepare(&input, crate::jpeg_controls::MAX_INPUT_BYTES)
                        .unwrap()
                        .unwrap();
                let (pixels, plan) = source
                    .decode_with_target_metadata_plan(policy, metadata::JpegOutputColor::Rgb)
                    .unwrap();
                let pixels = pixels.to_rgb8();
                let target = plan
                    .assemble_candidate(encode_jpeg(&pixels, 75).unwrap())
                    .unwrap()
                    .len() as u64;
                let (quality, bytes) = (1..=100)
                    .rev()
                    .find_map(|quality| {
                        let bytes = plan
                            .assemble_candidate(encode_jpeg(&pixels, quality).unwrap())
                            .unwrap();
                        (bytes.len() as u64 <= target).then_some((quality, bytes))
                    })
                    .unwrap();
                (target, quality, bytes)
            };
            let output = dir.path().join(format!("{policy:?}.jpg"));
            let req: ConvertRequest = serde_json::from_value(serde_json::json!({
                "input_path": input,
                "output_path": output,
                "target": TargetFormat::Jpeg,
                "compress_mode": CompressMode::TargetSizeBytes(target),
                "metadata_policy": policy,
            }))
            .unwrap();

            let result = backend
                .convert(JobId::new(), &req, CancellationToken::new())
                .await
                .unwrap();
            let execution = result.compression_execution.unwrap();
            assert_eq!(execution.selected_quality, Some(expected_quality));
            assert_eq!(execution.attempts, 101 - expected_quality);
            assert_eq!(execution.target_bytes, Some(target));
            assert_eq!(execution.final_bytes, expected_bytes.len() as u64);
            assert!(execution.target_met);
            assert_eq!(std::fs::read(&output).unwrap(), expected_bytes);
            assert_eq!(std::fs::read(&input).unwrap(), original);
        }
    }

    #[tokio::test]
    async fn ordinary_jpeg_preserve_reports_verified_metadata_execution() {
        struct Sink;
        impl EventSink for Sink {
            fn emit_progress(&self, _: ProgressEvent) {}
            fn emit_queue(&self, _: goop_core::QueueEvent) {}
            fn emit_sidecar(&self, _: goop_core::SidecarEvent) {}
        }

        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.jpg");
        let output = dir.path().join("output.jpg");
        write_test_jpeg(&input);
        let resolver = BinaryResolver::new(dir.path().to_owned());
        let backend = ImageMagickBackend::new(&resolver, Arc::new(Sink));
        let req: ConvertRequest = serde_json::from_value(serde_json::json!({
            "input_path": input,
            "output_path": output,
            "target": TargetFormat::Jpeg,
            "metadata_policy": MetadataPolicy::Preserve,
        }))
        .unwrap();

        let result = backend
            .convert(JobId::new(), &req, CancellationToken::new())
            .await
            .unwrap();
        let execution = result
            .image_metadata_execution
            .expect("JPEG Preserve must report a verified metadata outcome");
        assert_eq!(execution.requested_policy, MetadataPolicy::Preserve);
        assert!(!execution.exif_retained);
        assert!(!execution.icc_retained);
        assert_eq!(execution.color_handling, ImageColorHandling::Untagged);
        assert_eq!(result.bytes, std::fs::metadata(&output).unwrap().len());
    }

    #[tokio::test]
    async fn impossible_target_size_publishes_nothing() {
        struct Sink;
        impl EventSink for Sink {
            fn emit_progress(&self, _: ProgressEvent) {}
            fn emit_queue(&self, _: goop_core::QueueEvent) {}
            fn emit_sidecar(&self, _: goop_core::SidecarEvent) {}
        }
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.jpg");
        let output = dir.path().join("output.jpg");
        write_test_jpeg(&input);
        let resolver = BinaryResolver::new(dir.path().to_owned());
        let backend = ImageMagickBackend::new(&resolver, Arc::new(Sink));
        let req: ConvertRequest = serde_json::from_value(serde_json::json!({
            "input_path": input,
            "output_path": output,
            "target": TargetFormat::Jpeg,
            "compress_mode": CompressMode::TargetSizeBytes(1),
            "metadata_policy": MetadataPolicy::StripAll,
        }))
        .unwrap();
        let error = backend
            .convert(JobId::new(), &req, CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("after 100 attempts"));
        assert!(error.to_string().contains("remove all"));
        assert!(!output.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn explicit_video_options_are_rejected_before_image_output_work() {
        struct Sink;
        impl EventSink for Sink {
            fn emit_progress(&self, _: ProgressEvent) {}
            fn emit_queue(&self, _: goop_core::QueueEvent) {}
            fn emit_sidecar(&self, _: goop_core::SidecarEvent) {}
        }

        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.png");
        write_test_png(&input, 8, 8);
        let source = std::fs::read(&input).unwrap();
        let resolver = BinaryResolver::new(dir.path().to_owned());
        let backend = ImageMagickBackend::new(&resolver, Arc::new(Sink));

        for options in [
            goop_core::VideoConvertOptions::Copy,
            goop_core::VideoConvertOptions::Encode {
                codec: goop_core::VideoCodec::H264,
                rate_control: goop_core::VideoRateControl::ConstantQuality { crf: 23 },
                speed: goop_core::VideoSpeed::Medium,
                processor: goop_core::VideoProcessor::Software,
                resize: None,
                frame_rate: None,
            },
        ] {
            let destination_dir = dir.path().join(match options {
                goop_core::VideoConvertOptions::Copy => "copy-output",
                goop_core::VideoConvertOptions::Encode { .. } => "encode-output",
            });
            let output = destination_dir.join("result.png");
            let mut req: ConvertRequest = serde_json::from_value(serde_json::json!({
                "input_path": input,
                "output_path": output,
                "target": TargetFormat::Png,
            }))
            .unwrap();
            req.video_options = Some(options);

            let error = backend
                .convert(JobId::new(), &req, CancellationToken::new())
                .await
                .unwrap_err();
            assert!(matches!(error, GoopError::InvalidRequest(_)), "{error:?}");
            assert!(!destination_dir.exists());
            assert_eq!(std::fs::read(&input).unwrap(), source);
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn invalid_destination_leaves_no_staging_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(StagedImage::new(&dir.path().join("..")).is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_automatic_names_publish_both_results() {
        struct Sink(std::sync::Barrier);
        impl EventSink for Sink {
            fn emit_progress(&self, event: ProgressEvent) {
                if event.percent == 0.0 {
                    self.0.wait();
                }
            }
            fn emit_queue(&self, _: goop_core::QueueEvent) {}
            fn emit_sidecar(&self, _: goop_core::SidecarEvent) {}
        }
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("output");
        std::fs::create_dir(&output).unwrap();
        let sink = Arc::new(Sink(std::sync::Barrier::new(2)));
        let mut tasks = Vec::new();
        for (name, color) in [("a", [255, 0, 0]), ("b", [0, 255, 0])] {
            let source_dir = dir.path().join(name);
            std::fs::create_dir(&source_dir).unwrap();
            let input = source_dir.join("photo.png");
            let expected = image::RgbImage::from_pixel(8, 8, image::Rgb(color));
            expected.save(&input).unwrap();
            let req: ConvertRequest = serde_json::from_value(serde_json::json!({
                "input_path": input, "output_path": output, "target": TargetFormat::Webp,
            }))
            .unwrap();
            let sink = sink.clone();
            let resolver = BinaryResolver::new(dir.path().to_owned());
            tasks.push(tokio::spawn(async move {
                let backend = ImageMagickBackend::new(&resolver, sink);
                let result = backend
                    .convert(JobId::new(), &req, CancellationToken::new())
                    .await
                    .unwrap();
                assert_eq!(
                    result.bytes,
                    std::fs::metadata(&result.output_path).unwrap().len()
                );
                assert_eq!(
                    image::open(&result.output_path).unwrap().to_rgb8(),
                    expected
                );
                result.output_path
            }));
        }
        let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            (
                tasks.remove(0).await.unwrap(),
                tasks.remove(0).await.unwrap(),
            )
        })
        .await
        .unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read_dir(output).unwrap().count(), 2);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn automatic_name_skips_and_preserves_dangling_symlink() {
        struct Sink;
        impl EventSink for Sink {
            fn emit_progress(&self, _: ProgressEvent) {}
            fn emit_queue(&self, _: goop_core::QueueEvent) {}
            fn emit_sidecar(&self, _: goop_core::SidecarEvent) {}
        }
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("photo.png");
        write_test_png(&input, 8, 8);
        let destination = dir.path().join("photo.webp");
        let missing = dir.path().join("missing");
        std::os::unix::fs::symlink(&missing, &destination).unwrap();
        let req: ConvertRequest = serde_json::from_value(serde_json::json!({
            "input_path": input, "output_path": dir.path(), "target": TargetFormat::Webp,
        }))
        .unwrap();
        let resolver = BinaryResolver::new(dir.path().to_owned());
        let backend = ImageMagickBackend::new(&resolver, Arc::new(Sink));
        let result = backend
            .convert(JobId::new(), &req, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            Path::new(&result.output_path),
            dir.path().join("photo (1).webp")
        );
        assert_eq!(std::fs::read_link(destination).unwrap(), missing);
        assert_eq!(
            result.bytes,
            std::fs::metadata(&result.output_path).unwrap().len()
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 3);
    }

    #[tokio::test]
    async fn cancelled_blocking_worker_never_publishes_and_cleans_staging() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("out.png");
        let cancel = CancellationToken::new();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let worker_output = output.clone();
        let worker_cancel = cancel.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let result = prepare_image_output(&worker_output, None, &worker_cancel, |path| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                std::fs::write(path, b"late encode")?;
                Ok(())
            });
            // Cancellation makes prepare return Err after dropping staging.
            assert!(matches!(result, Err(GoopError::Cancelled)));
            done_tx.send(()).unwrap();
            result
        });
        let task = tokio::spawn(finish_image_output(
            worker,
            output.clone().into(),
            cancel.clone(),
        ));
        entered_rx.await.unwrap();
        cancel.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(GoopError::Cancelled)));
        assert!(!output.exists());
        release_tx.send(()).unwrap();
        done_rx.await.unwrap();
        assert!(!output.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn cancelled_explicit_jpeg_encode_never_publishes_and_preserves_destination() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("out.jpg");
        let input = dir.path().join("in.jpg");
        image::RgbImage::new(160, 120).save(&input).unwrap();
        std::fs::write(&output, b"original destination").unwrap();
        let cancel = CancellationToken::new();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let worker_output = output.clone();
        let worker_cancel = cancel.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let result = prepare_image_output(&worker_output, None, &worker_cancel, |path| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                crate::jpeg_controls::render(
                    &input,
                    path,
                    &goop_core::ImageConvertOptions {
                        jpeg_quality: 90,
                        resize: goop_core::ImageResize::FitWithin {
                            width: 80,
                            height: 80,
                        },
                    },
                    goop_core::MetadataPolicy::StripAll,
                )?;
                assert_eq!(image::image_dimensions(path).unwrap(), (80, 60));
                Ok(())
            });
            // Cancellation makes prepare return Err after dropping staging.
            assert!(matches!(result, Err(GoopError::Cancelled)));
            done_tx.send(()).unwrap();
            result
        });
        let task = tokio::spawn(finish_image_output(
            worker,
            output.clone().into(),
            cancel.clone(),
        ));
        entered_rx.await.unwrap();
        cancel.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(GoopError::Cancelled)));
        assert_eq!(std::fs::read(&output).unwrap(), b"original destination");
        release_tx.send(()).unwrap();
        done_rx.await.unwrap();
        assert_eq!(std::fs::read(&output).unwrap(), b"original destination");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[tokio::test]
    async fn staging_preserves_existing_output_on_error_and_collision() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("out.jpg");
        std::fs::write(&output, b"original").unwrap();
        let result = staged_image_output(
            output.clone().into(),
            None,
            CancellationToken::new(),
            |path| {
                std::fs::write(path, b"partial")?;
                Err(GoopError::Cancelled)
            },
        )
        .await;
        assert!(result.is_err());
        let result = staged_image_output(
            output.clone().into(),
            None,
            CancellationToken::new(),
            |path| {
                std::fs::write(path, b"new")?;
                Ok(())
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(std::fs::read(&output).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn staging_checks_final_postprocess_size() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.jpg");
        write_test_jpeg(&input);
        use img_parts::ImageICC;
        let bytes = std::fs::read(&input).unwrap();
        let mut jpeg = img_parts::jpeg::Jpeg::from_bytes(bytes.into()).unwrap();
        jpeg.set_icc_profile(Some(vec![42; 4000].into()));
        std::fs::write(&input, jpeg.encoder().bytes()).unwrap();
        let output = dir.path().join("out.jpg");
        let result = staged_image_output(
            output.clone().into(),
            Some(2000),
            CancellationToken::new(),
            move |path| {
                compress_jpeg(&input, path, CompressMode::TargetSizeBytes(2000))?;
                assert!(std::fs::metadata(path)?.len() <= 2000);
                metadata::apply(&input, path, goop_core::MetadataPolicy::Preserve)?;
                Ok(())
            },
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("2000"));
        assert!(!output.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn unsupported_compression_modes_fail() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.png");
        write_test_png(&input, 16, 16);
        for (target, mode) in [
            (TargetFormat::Jpeg, CompressMode::LosslessReoptimize),
            (TargetFormat::Webp, CompressMode::TargetSizeBytes(100_000)),
        ] {
            let output = dir.path().join("out");
            assert!(compress_image(&input, &output, target, mode).is_err());
            assert!(!output.exists());
        }
    }

    #[test]
    fn webp_quality_uses_lossy_encoder_preserves_alpha_and_reports_untagged_color() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.png");
        let source = ImageBuffer::from_fn(64, 64, |x, y| {
            Rgba([
                x as u8 * 4,
                y as u8 * 4,
                (x ^ y) as u8 * 4,
                (x + y) as u8 * 2,
            ])
        });
        source.save(&input).unwrap();
        let low = dir.path().join("low.webp");
        let high = dir.path().join("high.webp");
        compress_image(&input, &low, TargetFormat::Webp, CompressMode::Quality(1)).unwrap();
        compress_image(
            &input,
            &high,
            TargetFormat::Webp,
            CompressMode::Quality(100),
        )
        .unwrap();
        assert_ne!(
            std::fs::metadata(&low).unwrap().len(),
            std::fs::metadata(&high).unwrap().len()
        );
        for output in [&low, &high] {
            let decoded = image::open(output).unwrap().to_rgba8();
            assert!(source.as_raw().iter().skip(3).step_by(4).eq(decoded
                .as_raw()
                .iter()
                .skip(3)
                .step_by(4)));
        }

        let metadata_output = dir.path().join("metadata.webp");
        let outcome = process_image_with_metadata(
            &input,
            &metadata_output,
            TargetFormat::Webp,
            Some(CompressMode::Quality(50)),
            MetadataPolicy::Preserve,
            &CancellationToken::new(),
        )
        .unwrap();
        let execution = outcome.image_metadata.unwrap();
        assert_eq!(execution.color_handling, ImageColorHandling::Untagged);
        assert!(!execution.icc_retained);
        assert!(execution
            .notices
            .iter()
            .any(|notice| notice.contains("untagged")));
    }

    #[test]
    fn webp_quality_refuses_malformed_input_and_pre_cancel_without_output() {
        let dir = tempfile::tempdir().unwrap();
        let malformed = dir.path().join("malformed.png");
        std::fs::write(&malformed, b"not an image").unwrap();
        let malformed_output = dir.path().join("malformed.webp");
        assert!(compress_image(
            &malformed,
            &malformed_output,
            TargetFormat::Webp,
            CompressMode::Quality(50),
        )
        .is_err());
        assert!(!malformed_output.exists());

        let input = dir.path().join("input.png");
        write_test_png(&input, 16, 16);
        let cancelled_output = dir.path().join("cancelled.webp");
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            compress_image_with_cancel(
                &input,
                &cancelled_output,
                TargetFormat::Webp,
                CompressMode::Quality(50),
                &cancel,
            ),
            Err(GoopError::Cancelled)
        ));
        assert!(!cancelled_output.exists());
    }

    #[test]
    fn target_search_checks_final_candidates_from_highest_quality_down() {
        let img = image::DynamicImage::new_rgb8(1, 1);
        let result = target_size_search(
            img,
            50,
            image::DynamicImage::into_rgb8,
            |_, quality| {
                let size = match quality {
                    100 => 60,
                    99 => 40,
                    98 => 45,
                    _ => 10,
                };
                Ok(vec![0; size])
            },
            || Ok(()),
        )
        .unwrap();
        assert_eq!(result.quality, 99);
        assert_eq!(result.attempts, 2);
        assert_eq!(result.bytes.len(), 40);
    }

    #[test]
    fn quality_one_is_not_a_safe_impossibility_sentinel() {
        use image::{Rgb, RgbImage};

        let pixels = RgbImage::from_fn(256, 8, |x, _| {
            let gray = if (x / 8) % 2 == 0 { 143 } else { 144 };
            Rgb([gray, gray, gray])
        });
        let quality_one = encode_jpeg(&pixels, 1).unwrap();
        let quality_four = encode_jpeg(&pixels, 4).unwrap();

        assert!(
            quality_one.len() > quality_four.len(),
            "quality 1 cannot reject higher qualities when its final bytes are not a lower bound"
        );
    }

    #[test]
    fn exhaustive_search_accepts_a_higher_quality_when_quality_one_misses() {
        let img = image::DynamicImage::new_rgb8(1, 1);
        let target = 50;
        let candidate_size = |quality| -> usize {
            match quality {
                80 => 40,
                1 => 60,
                _ => 70,
            }
        };
        let sentinel_result = ((candidate_size(1) as u64) <= target).then_some(1);
        let exhaustive_result = (1..=100)
            .rev()
            .find(|quality| candidate_size(*quality) as u64 <= target);

        assert_eq!(sentinel_result, None);
        assert_eq!(exhaustive_result, Some(80));

        let selected = target_size_search(
            img,
            target,
            image::DynamicImage::into_rgb8,
            |_, quality| Ok(vec![quality; candidate_size(quality)]),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(selected.quality, exhaustive_result.unwrap());
        assert_eq!(selected.bytes, vec![80; 40]);
    }

    #[test]
    fn target_search_prepares_once_and_returns_the_encoded_winner() {
        use std::cell::Cell;

        let img = image::DynamicImage::new_rgb8(2, 3);
        let preparations = Cell::new(0);
        let mut encoded = Vec::new();
        let result = target_size_search(
            img,
            97,
            |image| {
                preparations.set(preparations.get() + 1);
                image.into_rgb8()
            },
            |pixels, quality| {
                assert_eq!(pixels.dimensions(), (2, 3));
                encoded.push(quality);
                Ok(vec![quality; quality as usize])
            },
            || Ok(()),
        )
        .unwrap();

        assert_eq!(preparations.get(), 1);
        assert_eq!(encoded, vec![100, 99, 98, 97]);
        assert_eq!(result.attempts, 4);
        assert_eq!(result.quality, 97);
        assert_eq!(result.bytes, vec![97; 97]);
    }

    #[test]
    fn target_search_quality_one_winner_encodes_each_quality_once() {
        let img = image::DynamicImage::new_rgb8(1, 1);
        let mut encoded = Vec::new();
        let result = target_size_search(
            img,
            1,
            image::DynamicImage::into_rgb8,
            |_, quality| {
                encoded.push(quality);
                Ok(vec![quality; quality as usize])
            },
            || Ok(()),
        )
        .unwrap();

        assert_eq!(encoded, (1..=100).rev().collect::<Vec<_>>());
        assert_eq!(result.attempts, 100);
        assert_eq!(result.quality, 1);
        assert_eq!(result.bytes, vec![1]);
    }

    #[test]
    fn target_search_quality_one_hundred_fit_has_exact_attempt_order() {
        let img = image::DynamicImage::new_rgb8(1, 1);
        let mut encoded = Vec::new();
        let result = target_size_search(
            img,
            1,
            image::DynamicImage::into_rgb8,
            |_, quality| {
                encoded.push(quality);
                Ok(vec![quality])
            },
            || Ok(()),
        )
        .unwrap();

        assert_eq!(encoded, vec![100]);
        assert_eq!(result.attempts, 1);
        assert_eq!(result.quality, 100);
        assert_eq!(result.bytes, vec![100]);
    }

    #[test]
    fn target_search_reports_smallest_final_candidate_when_none_fit() {
        let img = image::DynamicImage::new_rgb8(1, 1);
        let err = target_size_search(
            img,
            5,
            image::DynamicImage::into_rgb8,
            |_, quality| Ok(vec![0; if quality == 37 { 7 } else { 20 }]),
            || Ok(()),
        )
        .unwrap_err();
        let message = err.to_string();
        assert!(message.contains("smallest attempted final size was 7 bytes"));
        assert!(message.contains("after 100 attempts"));
    }

    #[test]
    fn target_search_checks_cancellation_between_attempts() {
        let img = image::DynamicImage::new_rgb8(1, 1);
        let mut checkpoints = 0;
        let err = target_size_search(
            img,
            1,
            image::DynamicImage::into_rgb8,
            |_, _| Ok(vec![0; 20]),
            || {
                checkpoints += 1;
                if checkpoints == 4 {
                    Err(GoopError::Cancelled)
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert!(matches!(err, GoopError::Cancelled));
        assert_eq!(checkpoints, 4);
    }

    #[test]
    fn target_search_cancellation_before_encode_runs_no_encoder() {
        let img = image::DynamicImage::new_rgb8(1, 1);
        let preparations = std::cell::Cell::new(0);
        let mut encodes = 0;
        let err = target_size_search(
            img,
            1,
            |image| {
                preparations.set(preparations.get() + 1);
                image.into_rgb8()
            },
            |_, _| {
                encodes += 1;
                Ok(vec![0; 20])
            },
            || Err(GoopError::Cancelled),
        )
        .unwrap_err();

        assert!(matches!(err, GoopError::Cancelled));
        assert_eq!(preparations.get(), 0);
        assert_eq!(encodes, 0);
    }

    #[test]
    fn target_search_cancellation_after_encode_discards_candidate() {
        let img = image::DynamicImage::new_rgb8(1, 1);
        let mut encodes = 0;
        let mut checkpoints = 0;
        let err = target_size_search(
            img,
            100,
            image::DynamicImage::into_rgb8,
            |_, _| {
                encodes += 1;
                Ok(vec![0; 20])
            },
            || {
                checkpoints += 1;
                if checkpoints == 4 {
                    Err(GoopError::Cancelled)
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();

        assert!(matches!(err, GoopError::Cancelled));
        assert_eq!(encodes, 1);
        assert_eq!(checkpoints, 4);
    }

    #[test]
    fn generic_jpeg_target_search_honors_cancellation_before_encoding() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("output.jpg");
        write_test_png(&input, 64, 64);
        let cancel = CancellationToken::new();
        cancel.cancel();

        let err =
            compress_jpeg_with_cancel(&input, &output, CompressMode::TargetSizeBytes(1), &cancel)
                .unwrap_err();

        assert!(matches!(err, GoopError::Cancelled));
        assert!(!output.exists());
    }

    #[test]
    fn generic_jpeg_target_search_writes_the_exact_exhaustive_winner() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.png");
        let output = dir.path().join("output.jpg");
        image::RgbImage::from_pixel(64, 64, image::Rgb([40, 80, 120]))
            .save(&input)
            .unwrap();
        let prepared = decode_any(&input).unwrap().into_rgb8();
        let target = encode_jpeg(&prepared, 75).unwrap().len() as u64;
        let expected = (1..=100)
            .rev()
            .find_map(|quality| {
                let bytes = encode_jpeg(&prepared, quality).unwrap();
                (bytes.len() as u64 <= target).then_some(bytes)
            })
            .unwrap();

        compress_jpeg_with_cancel(
            &input,
            &output,
            CompressMode::TargetSizeBytes(target),
            &CancellationToken::new(),
        )
        .unwrap();

        assert_eq!(std::fs::read(&output).unwrap(), expected);
    }

    #[test]
    fn cancellation_after_snapshot_selection_preserves_existing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.jpg");
        let output = dir.path().join("output.jpg");
        write_test_jpeg(&input);
        std::fs::write(&output, b"existing destination").unwrap();
        let source = crate::jpeg_controls::prepare(&input, crate::jpeg_controls::MAX_INPUT_BYTES)
            .unwrap()
            .unwrap();
        let (pixels, plan) = source
            .decode_with_target_metadata_plan(
                MetadataPolicy::Preserve,
                metadata::JpegOutputColor::Rgb,
            )
            .unwrap();
        let candidate = plan
            .assemble_candidate(encode_jpeg(&pixels.to_rgb8(), 75).unwrap())
            .unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();

        let err = verify_and_write_snapshot_jpeg(&plan, &output, &candidate, &cancel).unwrap_err();

        assert!(matches!(err, GoopError::Cancelled));
        assert_eq!(std::fs::read(&output).unwrap(), b"existing destination");
    }

    #[test]
    fn cancellation_after_generic_selection_preserves_existing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("output.jpg");
        std::fs::write(&output, b"existing destination").unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();

        let err = write_jpeg_output(
            &output,
            b"selected candidate",
            &cancel,
            "failed to write output",
        )
        .unwrap_err();

        assert!(matches!(err, GoopError::Cancelled));
        assert_eq!(std::fs::read(&output).unwrap(), b"existing destination");
    }

    #[test]
    fn decode_rejects_raster_disguised_as_raw() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("test.png");
        let raw = dir.path().join("test.dng");
        image::RgbImage::new(8, 8).save(&png).unwrap();
        std::fs::rename(png, &raw).unwrap();
        assert!(decode_any(&raw).is_err());
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
        assert!(size > 0 && size <= target);
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
        // link time (Homebrew on macOS dev, apt-get on Ubuntu CI,
        // vcpkg on Windows CI).
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

    #[test]
    fn decode_any_decodes_heic_fixture() {
        // Real end-to-end decode through the statically-linked libheif +
        // libde265 (v0.2.8). The fixture is a 64x64 red-dominant-noise
        // HEIC (HEVC Main Still Picture) — noisy content keeps the
        // compressed file large enough to clear libheif's decompression-
        // bomb guard (tiny inputs aren't allowed to decode to large
        // images). Dimensions must be exact; the pixel assert allows
        // HEVC lossy-compression tolerance on the noisy source.
        let fixture =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sample.heic");
        let img = decode_any(&fixture).expect("HEIC fixture must decode");
        assert_eq!(img.width(), 64);
        assert_eq!(img.height(), 64);
        let rgb = img.to_rgb8();
        let p = rgb.get_pixel(32, 32);
        assert!(
            p[0] > 130 && p[1] < 110 && p[2] < 110,
            "expected red-dominant centre pixel, got {p:?}"
        );
    }

    #[test]
    fn decode_heic_errors_clearly_on_corrupt_input() {
        // A non-HEIC payload with a .heic extension must surface a
        // libheif-attributed error, not a panic or a generic image error.
        let dir = tmp_dir("heic-corrupt");
        let heic_in = dir.join("photo.heic");
        std::fs::write(&heic_in, b"definitely not a heif container").unwrap();
        let err = decode_any(&heic_in).unwrap_err();
        let GoopError::SubprocessFailed { binary, .. } = err else {
            panic!("expected SubprocessFailed, got {err:?}");
        };
        assert_eq!(binary, "libheif");
        std::fs::remove_dir_all(&dir).ok();
    }
}
