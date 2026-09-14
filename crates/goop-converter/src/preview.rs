//! Explicit, isolated sample generation. Never schedules jobs or writes source files.
use goop_core::{
    CompressMode, GoopError, ImageColorPolicy, ImageResize, JobId, MetadataPolicy, PreviewKind,
    PreviewRequest, PreviewResult, QualityPreset, ResolutionCap, TargetFormat,
};
use goop_sidecar::BinaryResolver;
use image::{DynamicImage, ImageDecoder, ImageFormat};
use img_parts::Bytes;
use std::{
    io::{Cursor, Read},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command, sync::Semaphore};
use tokio_util::sync::CancellationToken;
const EDGE: u32 = 1280;
pub(crate) const MAX_SOURCE_PIXELS: u64 = 4_000_000;
pub(crate) const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;
const BYTES: u64 = 16 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
fn invalid(message: impl Into<String>) -> GoopError {
    GoopError::InvalidRequest(message.into())
}
pub fn validate_pixels(width: u32, height: u32) -> Result<(), GoopError> {
    if width == 0
        || height == 0
        || width > 32_768
        || height > 32_768
        || u64::from(width) * u64::from(height) > MAX_SOURCE_PIXELS
    {
        Err(invalid(
            "Sample preview unavailable: source exceeds the 4 million decoded-pixel limit",
        ))
    } else {
        Ok(())
    }
}
pub fn bounded_dimensions(width: u32, height: u32, edge: u32) -> (u32, u32) {
    let ratio = f64::from(edge) / f64::from(width.max(height).max(1));
    if ratio >= 1.0 {
        (width, height)
    } else {
        (
            (f64::from(width) * ratio).round().max(1.0) as u32,
            (f64::from(height) * ratio).round().max(1.0) as u32,
        )
    }
}
fn checkpoint(cancel: &CancellationToken, deadline: Instant) -> Result<(), GoopError> {
    if cancel.is_cancelled() {
        Err(GoopError::Cancelled)
    } else if Instant::now() >= deadline {
        Err(invalid("Sample preview timed out"))
    } else {
        Ok(())
    }
}
#[derive(Default)]
struct State {
    active: Option<(String, CancellationToken)>,
    completed: Option<(String, PathBuf)>,
}
pub struct PreviewService {
    root: PathBuf,
    state: Mutex<State>,
    gate: Arc<Semaphore>,
}
struct Scratch(Option<PathBuf>);
impl Drop for Scratch {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}
/// Call only after acquiring the application's exclusive instance guard.
/// Unmarked directories and symlinks are deliberately left untouched.
pub fn cleanup_stale_sessions(root: &Path) -> Result<(), GoopError> {
    if !root.exists() {
        return Ok(());
    }
    if std::fs::symlink_metadata(root)?.file_type().is_symlink() {
        return Err(invalid("Preview root must not be a symlink"));
    }
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir()
            || !entry.file_name().to_string_lossy().starts_with("session-")
        {
            continue;
        }
        let marker = entry.path().join(".goop-preview-session");
        let owned = std::fs::symlink_metadata(&marker)
            .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink() && m.len() == 2);
        if owned && std::fs::read(&marker)? == b"v1" {
            std::fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}
impl PreviewService {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: root.join(format!("session-{}", JobId::new().0)),
            state: Mutex::new(State::default()),
            gate: Arc::new(Semaphore::new(1)),
        }
    }
    pub fn cancel(&self, id: &str) {
        let mut state = self.state.lock().unwrap();
        if let Some((active, token)) = &state.active {
            if active == id {
                token.cancel();
            }
        }
        if state.completed.as_ref().is_some_and(|(done, _)| done == id) {
            if let Some((_, path)) = state.completed.take() {
                let _ = std::fs::remove_dir_all(path);
            }
        }
    }
    pub async fn generate(
        &self,
        resolver: &BinaryResolver,
        request: PreviewRequest,
    ) -> Result<PreviewResult, GoopError> {
        if request.video_options.is_some() {
            return Err(invalid(crate::video_options::PREVIEW_REASON));
        }
        if request.request_id.is_empty() || request.request_id.len() > 200 {
            return Err(invalid("Invalid preview request identity"));
        }
        if let Some(options) = &request.image_options {
            crate::image_options::validate_options(options)?;
            if request.compress_mode.is_some() {
                return Err(invalid(
                    "Image settings cannot be combined with compression",
                ));
            }
            if request.target != TargetFormat::Jpeg {
                return Err(invalid("Explicit image samples require a JPEG target"));
            }
            if !matches!(options.resize, ImageResize::Original) {
                return Err(invalid("Fit within image samples are not available yet"));
            }
        }
        if matches!(
            request.compress_mode,
            Some(CompressMode::TargetSizeBytes(_))
        ) {
            return Err(invalid(
                "Sample preview unavailable for target-size compression",
            ));
        }
        if request.subtitle.is_some() || request.gif_options.is_some() {
            return Err(invalid(
                "Sample preview unavailable for subtitles or GIF settings",
            ));
        }
        let input = std::fs::canonicalize(goop_core::path::expand(&request.input_path))?;
        if !input.is_file() {
            return Err(invalid("Sample preview requires a file"));
        }
        let ext = input
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let is_image = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp");
        if !is_image && crate::backend_for_extension(&ext) == crate::BackendKind::ImageMagick {
            return Err(invalid("Sample preview unavailable for this image source; bounded decoding is not supported"));
        }
        if is_image
            && !matches!(
                request.target,
                TargetFormat::Jpeg | TargetFormat::Png | TargetFormat::Webp
            )
        {
            return Err(invalid("Sample preview unavailable for this image target"));
        }
        if is_image
            && request
                .resolution_cap
                .is_some_and(|cap| cap != ResolutionCap::Original)
        {
            return Err(invalid("Image conversion does not support resolution caps"));
        }
        if is_image
            && request.target == TargetFormat::Jpeg
            && matches!(
                request.compress_mode,
                Some(CompressMode::LosslessReoptimize)
            )
        {
            return Err(invalid("Lossless JPEG sample preview is unavailable"));
        }
        if !is_image && request.target != TargetFormat::Mp4 {
            return Err(invalid("Video sample preview is available for MP4 only"));
        }
        if is_image
            && request
                .quality_preset
                .is_some_and(|q| q != QualityPreset::Original)
        {
            return Err(invalid(
                "Image sample does not support video quality presets",
            ));
        }
        if matches!(request.compress_mode,Some(CompressMode::Quality(q)) if q==0 || q>100) {
            return Err(invalid("Quality must be between 1 and 100"));
        }
        if is_image
            && matches!(request.compress_mode, Some(CompressMode::Quality(_)))
            && !matches!(request.target, TargetFormat::Jpeg | TargetFormat::Webp)
        {
            return Err(invalid(
                "Sample quality control is available for JPEG and WebP only",
            ));
        }
        if !is_image
            && matches!(
                request.compress_mode,
                Some(CompressMode::LosslessReoptimize)
            )
        {
            return Err(invalid("Lossless video sample preview is unavailable"));
        }
        if request.image_options.is_some() && !is_image {
            return Err(invalid(
                "Explicit image samples are available for JPEG sources only",
            ));
        }
        let cancel = CancellationToken::new();
        {
            let mut state = self.state.lock().unwrap();
            if let Some((_, old)) = state
                .active
                .replace((request.request_id.clone(), cancel.clone()))
            {
                old.cancel();
            }
        }
        let deadline = Instant::now() + TIMEOUT;
        let permit = tokio::select! {
            permit=self.gate.clone().acquire_owned()=>permit.map_err(|_|invalid("Preview service closed"))?,
            _=cancel.cancelled()=>return Err(GoopError::Cancelled),
            _=tokio::time::sleep_until(tokio::time::Instant::from_std(deadline))=>return Err(invalid("Sample preview timed out")),
        };
        checkpoint(&cancel, deadline)?;
        let directory = self.root.join(JobId::new().0.to_string());
        std::fs::create_dir_all(&directory)?;
        std::fs::write(self.root.join(".goop-preview-session"), b"v1")?;
        let mut scratch = (!is_image).then(|| Scratch(Some(directory.clone())));
        let original_video_metadata = if is_image {
            None
        } else {
            Some(std::fs::metadata(&input)?)
        };
        let result = if is_image {
            let req = request.clone();
            let path = input.clone();
            let dir = directory.clone();
            let token = cancel.clone();
            let mut worker = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                image_worker(&path, &dir, &req, &token, deadline)
            });
            let mut interrupt_error = None;
            let completed = tokio::select! {
                result = &mut worker => Some(result.map_err(|e| invalid(e.to_string()))?),
                _ = cancel.cancelled() => {
                    interrupt_error = Some(GoopError::Cancelled);
                    None
                },
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                    interrupt_error = Some(invalid("Sample preview timed out"));
                    None
                }
            };
            if let Some((result, image_scratch)) = completed {
                scratch = Some(image_scratch);
                result
            } else {
                cancel.cancel();
                // A running spawn_blocking task cannot be aborted safely. Await its
                // bounded cooperative shutdown so it cannot retain permits/locks or
                // race scratch cleanup after this request returns.
                let _ = worker.await;
                return Err(interrupt_error.expect("interrupted preview has an error"));
            }
        } else {
            let _permit = permit;
            video_sample(resolver, &input, &directory, &request, &cancel, deadline).await
        };
        let result = result?;
        checkpoint(&cancel, deadline)?;
        if let Some(original) = original_video_metadata {
            let latest = std::fs::metadata(&input)?;
            if latest.len() != original.len() || latest.modified().ok() != original.modified().ok()
            {
                return Err(invalid("Source changed while generating preview"));
            }
        }
        let mut state = self.state.lock().unwrap();
        checkpoint(&cancel, deadline)?;
        if let Some((_, old)) = state
            .completed
            .replace((request.request_id.clone(), directory))
        {
            let _ = std::fs::remove_dir_all(old);
        }
        if let Some(scratch) = scratch.as_mut() {
            scratch.0.take();
        }
        Ok(result)
    }
}
impl Drop for PreviewService {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn edge(request: &PreviewRequest) -> u32 {
    match request.resolution_cap {
        Some(ResolutionCap::R480p) => 854,
        Some(ResolutionCap::R720p) => 1280,
        _ => EDGE,
    }
}
fn response(
    request: &PreviewRequest,
    kind: PreviewKind,
    before: Option<PathBuf>,
    after: PathBuf,
    dimensions: (u32, u32),
    bytes: u64,
    duration: Option<u32>,
) -> PreviewResult {
    PreviewResult {
        request_id: request.request_id.clone(),
        source_revision: request.source_revision.clone(),
        kind,
        before_path: before.map(|p| p.to_string_lossy().into_owned()),
        after_path: after.to_string_lossy().into_owned(),
        width: dimensions.0,
        height: dimensions.1,
        sample_bytes: bytes as u32,
        duration_ms: duration,
        max_edge: EDGE,
        max_duration_ms: 3000,
    }
}

fn image_worker(
    input: &Path,
    directory: &Path,
    request: &PreviewRequest,
    cancel: &CancellationToken,
    deadline: Instant,
) -> (Result<PreviewResult, GoopError>, Scratch) {
    let scratch = Scratch(Some(directory.to_path_buf()));
    let result = image_sample(input, directory, request, cancel, deadline);
    (result, scratch)
}
fn image_sample(
    input: &Path,
    dir: &Path,
    request: &PreviewRequest,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<PreviewResult, GoopError> {
    let bytes = capture_image(input, MAX_INPUT_BYTES, cancel, deadline)?;
    let result = image_sample_bytes(bytes.clone(), dir, request, cancel, deadline)?;
    verify_snapshot_unchanged(input, &bytes, cancel, deadline)?;
    Ok(result)
}

fn verify_snapshot_unchanged(
    input: &Path,
    snapshot: &[u8],
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<(), GoopError> {
    let changed = || invalid("Source changed while generating preview");
    let mut file = std::fs::File::open(input)?;
    let mut offset = 0usize;
    let mut buffer = [0_u8; 64 * 1024];
    while offset < snapshot.len() {
        checkpoint(cancel, deadline)?;
        let requested = (snapshot.len() - offset).min(buffer.len());
        let count = file.read(&mut buffer[..requested])?;
        if count == 0 || buffer[..count] != snapshot[offset..offset + count] {
            return Err(changed());
        }
        offset += count;
    }
    if file.read(&mut buffer[..1])? != 0 {
        return Err(changed());
    }
    Ok(())
}

fn capture_image(
    input: &Path,
    limit: u64,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<Bytes, GoopError> {
    checkpoint(cancel, deadline)?;
    let file = std::fs::File::open(input)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(invalid("Sample preview requires a file"));
    }
    if metadata.len() > limit {
        return Err(invalid("Image preview source exceeds 64 MiB input limit"));
    }
    let bytes = crate::image_read::read_snapshot(
        file,
        limit,
        "Image preview source exceeds 64 MiB input limit",
        || checkpoint(cancel, deadline),
    )?;
    checkpoint(cancel, deadline)?;
    Ok(bytes)
}

fn image_sample_bytes(
    bytes: Bytes,
    dir: &Path,
    request: &PreviewRequest,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<PreviewResult, GoopError> {
    checkpoint(cancel, deadline)?;
    if request.image_color_policy.unwrap_or_default() != ImageColorPolicy::Preserve
        || request.image_alpha_policy.is_some()
    {
        return color_managed_image_sample(bytes, dir, request, cancel, deadline);
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP)
    ) {
        return Err(invalid(
            "Sample preview unavailable for this image encoding",
        ));
    }
    if request.image_options.is_some() && reader.format() != Some(ImageFormat::Jpeg) {
        return Err(invalid(
            "Explicit image samples are available for JPEG sources only",
        ));
    }
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| invalid(e.to_string()))?;
    let (width, height) = decoder.dimensions();
    validate_pixels(width, height)?;
    if let Some(options) = &request.image_options {
        crate::image_options::output_dimensions((width, height), &options.resize)?;
    }
    if decoder.total_bytes() > MAX_SOURCE_PIXELS * 16 {
        return Err(invalid("Decoded image exceeds preview memory limit"));
    }
    if request.target == TargetFormat::Jpeg && decoder.color_type().has_alpha() {
        return Err(invalid(
            "JPEG removes transparency; choose an explicit background before previewing.",
        ));
    }
    let orientation = if request.image_options.is_some() {
        let orientation = decoder
            .exif_metadata()
            .map_err(|e| invalid(e.to_string()))
            .and_then(|bytes| {
                bytes
                    .as_deref()
                    .map(crate::exif_geometry::orientation)
                    .transpose()
            });
        match orientation {
            Ok(value) => value.unwrap_or(image::metadata::Orientation::NoTransforms),
            Err(_) if request.metadata_policy == Some(MetadataPolicy::StripAll) => {
                image::metadata::Orientation::NoTransforms
            }
            Err(error) => return Err(error),
        }
    } else {
        decoder.orientation().map_err(|e| invalid(e.to_string()))?
    };
    checkpoint(cancel, deadline)?;
    let mut image =
        image::DynamicImage::from_decoder(decoder).map_err(|e| invalid(e.to_string()))?;
    image.apply_orientation(orientation);
    checkpoint(cancel, deadline)?;
    let (w, h) = bounded_dimensions(image.width(), image.height(), edge(request));
    let sample = image.resize_exact(w, h, image::imageops::FilterType::Triangle);
    checkpoint(cancel, deadline)?;
    let before = dir.join("before.png");
    sample
        .save_with_format(&before, ImageFormat::Png)
        .map_err(|e| invalid(e.to_string()))?;
    let mut encoded = Cursor::new(Vec::new());
    match request.target {
        TargetFormat::Jpeg => {
            let q = request.image_options.as_ref().map_or_else(
                || match request.compress_mode {
                    Some(CompressMode::Quality(q)) => q.max(1),
                    _ => 75,
                },
                |options| options.jpeg_quality,
            );
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, q);
            if let Some(gray) = sample
                .as_luma8()
                .filter(|_| request.image_options.is_some())
            {
                encoder.encode_image(gray)
            } else {
                encoder.encode_image(&sample.to_rgb8())
            }
            .map_err(|e| invalid(e.to_string()))?;
        }
        TargetFormat::Png => sample
            .write_to(&mut encoded, ImageFormat::Png)
            .map_err(|e| invalid(e.to_string()))?,
        TargetFormat::Webp => match request.compress_mode {
            Some(CompressMode::Quality(quality)) => {
                encoded = Cursor::new(crate::webp_lossy::encode(&sample, quality, cancel)?);
            }
            _ => sample
                .write_to(&mut encoded, ImageFormat::WebP)
                .map_err(|e| invalid(e.to_string()))?,
        },
        _ => unreachable!(),
    }
    checkpoint(cancel, deadline)?;
    let bytes = encoded.get_ref().len() as u64;
    if bytes > BYTES {
        return Err(invalid("Sample artifact exceeds 16 MiB"));
    }
    let after = dir.join("after.png");
    image::load_from_memory(encoded.get_ref())
        .map_err(|e| invalid(e.to_string()))?
        .save_with_format(&after, ImageFormat::Png)
        .map_err(|e| invalid(e.to_string()))?;
    if std::fs::metadata(&before)?.len() + std::fs::metadata(&after)?.len() > BYTES {
        return Err(invalid("Sample artifacts exceed 16 MiB"));
    }
    checkpoint(cancel, deadline)?;
    Ok(response(
        request,
        PreviewKind::Image,
        Some(before),
        after,
        (w, h),
        bytes,
        None,
    ))
}

fn color_managed_image_sample(
    bytes: Bytes,
    dir: &Path,
    request: &PreviewRequest,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<PreviewResult, GoopError> {
    let policy = request.image_color_policy.unwrap_or_default();
    if request.image_alpha_policy.is_some() && request.target != TargetFormat::Jpeg {
        return Err(invalid(
            "Transparency flattening is currently available only for JPEG output",
        ));
    }
    if request.image_alpha_policy.is_some() && policy == ImageColorPolicy::Preserve {
        return Err(invalid(
            "JPEG transparency flattening requires Convert to sRGB or Assume sRGB",
        ));
    }
    if !matches!(request.target, TargetFormat::Jpeg | TargetFormat::Png) {
        return Err(invalid(
            "Color-managed conversion is available only for JPEG and PNG output",
        ));
    }
    if request.compress_mode.is_some() {
        return Err(invalid(
            "Explicit color handling is currently available in Convert only",
        ));
    }
    if request.video_options.is_some()
        || request.gif_options.is_some()
        || request.subtitle.is_some()
        || request
            .quality_preset
            .is_some_and(|value| value != goop_core::QualityPreset::Original)
        || request
            .resolution_cap
            .is_some_and(|value| value != goop_core::ResolutionCap::Original)
    {
        return Err(invalid(
            "Explicit image color handling cannot be combined with media, GIF, subtitle, or video quality controls",
        ));
    }
    if let Some(options) = request.image_options.as_ref() {
        crate::image_options::validate_options(options)?;
        if request.target != TargetFormat::Jpeg {
            return Err(invalid(
                "Explicit JPEG quality and resize settings require JPEG output",
            ));
        }
    }
    let _working_set = crate::color::acquire_working_set(cancel)?;
    let prepared = crate::color::prepare_bytes(bytes)?;
    validate_pixels(
        prepared.inspection.dimensions.0,
        prepared.inspection.dimensions.1,
    )?;
    crate::color::validate_policy(&prepared.inspection, request.target, policy)?;
    checkpoint(cancel, deadline)?;
    let source = prepared.decode()?;
    validate_pixels(source.width(), source.height())?;
    let source_had_alpha = prepared.inspection.layout.has_alpha();
    if source_had_alpha && request.image_alpha_policy.is_none() {
        return Err(invalid(
            "JPEG removes transparency; choose an explicit background before previewing.",
        ));
    }
    let alpha_before = if source_had_alpha {
        let source_sample = crate::color::transform_alpha_preview_pixels(
            &source,
            prepared.inspection.profile.clone(),
            policy,
            cancel,
        )?;
        let (width, height) = bounded_dimensions(source.width(), source.height(), edge(request));
        Some(DynamicImage::ImageRgba8(image::imageops::resize(
            &source_sample,
            width,
            height,
            image::imageops::FilterType::Triangle,
        )))
    } else {
        None
    };
    let mut transformed = if request.image_alpha_policy.is_some() {
        crate::color::transform_and_flatten_pixels(
            source,
            prepared.inspection.profile.clone(),
            policy,
            request.image_alpha_policy,
            cancel,
        )?
    } else {
        crate::color::transform_pixels(source, prepared.inspection.profile.clone(), policy, cancel)?
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
    checkpoint(cancel, deadline)?;
    let (width, height) = bounded_dimensions(
        transformed.pixels.width(),
        transformed.pixels.height(),
        edge(request),
    );
    let before_sample = alpha_before.unwrap_or_else(|| {
        DynamicImage::ImageRgb8(image::imageops::resize(
            &transformed.pixels,
            width,
            height,
            image::imageops::FilterType::Triangle,
        ))
    });
    let after_pixels = image::imageops::resize(
        &transformed.pixels,
        width,
        height,
        image::imageops::FilterType::Triangle,
    );
    let before = dir.join("before.png");
    before_sample
        .save_with_format(&before, ImageFormat::Png)
        .map_err(|error| invalid(error.to_string()))?;
    checkpoint(cancel, deadline)?;
    let sample_transform = crate::color::TransformResult {
        pixels: after_pixels,
        destination_profile: transformed.destination_profile,
        handling: transformed.handling,
    };
    let quality = request
        .image_options
        .as_ref()
        .map_or(75, |options| options.jpeg_quality);
    let encoded = crate::color::encode_tagged(&sample_transform, request.target, quality, cancel)?;
    if encoded.len() as u64 > BYTES {
        return Err(invalid("Sample artifact exceeds 16 MiB"));
    }
    checkpoint(cancel, deadline)?;
    let after = dir.join("after.png");
    image::load_from_memory(&encoded)
        .map_err(|error| invalid(error.to_string()))?
        .save_with_format(&after, ImageFormat::Png)
        .map_err(|error| invalid(error.to_string()))?;
    if std::fs::metadata(&before)?.len() + std::fs::metadata(&after)?.len() > BYTES {
        return Err(invalid("Sample artifacts exceed 16 MiB"));
    }
    checkpoint(cancel, deadline)?;
    Ok(response(
        request,
        PreviewKind::Image,
        Some(before),
        after,
        (width, height),
        encoded.len() as u64,
        None,
    ))
}
async fn child_output(
    mut command: Command,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<Vec<u8>, GoopError> {
    checkpoint(cancel, deadline)?;
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child.stdout.take().unwrap();
    let mut reader = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    });
    let status = tokio::select! {status=child.wait()=>status.map_err(GoopError::from),_=cancel.cancelled()=>{let _=child.kill().await;let _=child.wait().await;Err(GoopError::Cancelled)},_=tokio::time::sleep_until(tokio::time::Instant::from_std(deadline))=>{let _=child.kill().await;let _=child.wait().await;Err(invalid("Sample preview timed out"))}};
    let status = match status {
        Ok(status) => status,
        Err(error) => {
            reader.abort();
            let _ = reader.await;
            return Err(error);
        }
    };
    if !status.success() {
        reader.abort();
        let _ = reader.await;
        return Err(invalid("Could not generate sample preview"));
    }
    // A descendant may retain stdout even after the immediate child exits.
    // The same deadline and cancellation also bound that final pipe read.
    let bytes = tokio::select! {
        result = &mut reader => result.map_err(|e| invalid(e.to_string()))??,
        _ = cancel.cancelled() => {
            reader.abort();
            let _ = reader.await;
            return Err(GoopError::Cancelled);
        }
        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
            reader.abort();
            let _ = reader.await;
            return Err(invalid("Sample preview timed out"));
        }
    };
    if bytes.len() > 1024 * 1024 {
        return Err(invalid("Preview probe output exceeds limit"));
    }
    Ok(bytes)
}
async fn video_sample(
    resolver: &BinaryResolver,
    input: &Path,
    dir: &Path,
    request: &PreviewRequest,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<PreviewResult, GoopError> {
    let mut probe = Command::new(resolver.resolve("ffprobe")?.path);
    probe
        .args([
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(input);
    let source = crate::parse_probe_json(&child_output(probe, cancel, deadline).await?)?;
    if !source.has_video || source.duration_ms == 0 {
        return Err(invalid(
            "Video sample requires a video stream with known duration",
        ));
    }
    validate_pixels(source.width.unwrap_or(0), source.height.unwrap_or(0))?;
    let (w, h) = bounded_dimensions(
        source.width.unwrap_or(0),
        source.height.unwrap_or(0),
        edge(request),
    );
    if w < 2 || h < 2 {
        return Err(invalid("Invalid video dimensions"));
    }
    let duration = source.duration_ms.min(3000) as u32;
    let (mut preset, crf) =
        crate::compat::h264_preset(request.quality_preset.unwrap_or(QualityPreset::Balanced));
    let crf = match request.compress_mode {
        Some(CompressMode::Quality(q)) => {
            preset = "medium";
            crate::compat::slider_to_crf(q).to_string()
        }
        _ => crf.to_string(),
    };
    let after = dir.join("sample.mp4");
    let mut command = Command::new(resolver.resolve("ffmpeg")?.path);
    command
        .args(["-v", "error", "-nostdin", "-threads", "1", "-i"])
        .arg(input)
        .args([
            "-t",
            &format!("{:.3}", f64::from(duration) / 1000.0),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-vf",
            &format!("scale=w=\'min({},iw)\':h=\'min({},ih)\':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",edge(request),edge(request)),
            "-c:v",
            "libx264",
            "-preset",
            preset,
            "-crf",
            &crf.to_string(),
            "-pix_fmt",
            "yuv420p",
            "-threads",
            "1",
            "-fs",
            &BYTES.to_string(),
            "-movflags",
            "+faststart",
        ])
        .arg(&after);
    child_output(command, cancel, deadline).await?;
    let bytes = std::fs::metadata(&after)?.len();
    if bytes == 0 || bytes >= BYTES {
        return Err(invalid("Sample artifact exceeds 16 MiB"));
    }
    let mut probe = Command::new(resolver.resolve("ffprobe")?.path);
    probe
        .args([
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(&after);
    let verified = crate::parse_probe_json(&child_output(probe, cancel, deadline).await?)?;
    let width = verified.width.unwrap_or(0);
    let height = verified.height.unwrap_or(0);
    if !verified.has_video
        || verified.has_audio
        || width == 0
        || height == 0
        || width > EDGE
        || height > EDGE
        || verified.duration_ms == 0
        || verified.duration_ms > 3000
    {
        return Err(invalid(
            "Generated video sample did not meet preview limits",
        ));
    }
    Ok(response(
        request,
        PreviewKind::Video,
        None,
        after,
        (width, height),
        bytes,
        Some(verified.duration_ms as u32),
    ))
}

#[cfg(all(test, unix))]
mod process_tests {
    use super::*;
    #[tokio::test]
    async fn deadline_still_applies_after_parent_exit_with_inherited_stdout() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 1 & exit 0"]);
        let result = tokio::time::timeout(
            Duration::from_millis(400),
            child_output(
                command,
                &CancellationToken::new(),
                Instant::now() + Duration::from_millis(30),
            ),
        )
        .await
        .expect("inherited stdout must not keep the preview request alive");
        assert!(result.unwrap_err().to_string().contains("timed out"));
    }
    #[tokio::test]
    async fn cancellation_kills_and_reaps_child() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exec sleep 30"]);
        let token = CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            cancel.cancel();
        });
        let start = Instant::now();
        assert!(matches!(
            child_output(command, &token, start + TIMEOUT).await,
            Err(GoopError::Cancelled)
        ));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[tokio::test]
    async fn timeout_stops_child() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exec sleep 30"]);
        let start = Instant::now();
        assert!(child_output(
            command,
            &CancellationToken::new(),
            start + Duration::from_millis(30)
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    fn explicit_request(input: &Path) -> PreviewRequest {
        serde_json::from_value(serde_json::json!({
            "request_id":"captured", "input_path":input, "source_revision":"1",
            "target":"jpeg", "metadata_policy":"preserve",
            "image_options":{"jpeg_quality":75,"resize":{"kind":"original"}}
        }))
        .unwrap()
    }

    fn wide_rgb_profile() -> Vec<u8> {
        use lcms2::{CIExyY, CIExyYTRIPLE, Profile, ToneCurve};

        let white = CIExyY {
            x: 0.3127,
            y: 0.3290,
            Y: 1.0,
        };
        let primaries = CIExyYTRIPLE {
            Red: CIExyY {
                x: 0.680,
                y: 0.320,
                Y: 1.0,
            },
            Green: CIExyY {
                x: 0.265,
                y: 0.690,
                Y: 1.0,
            },
            Blue: CIExyY {
                x: 0.150,
                y: 0.060,
                Y: 1.0,
            },
        };
        let curve = ToneCurve::new(2.2);
        Profile::new_rgb(&white, &primaries, &[&curve, &curve, &curve])
            .unwrap()
            .icc()
            .unwrap()
    }

    fn gray_profile() -> Vec<u8> {
        use lcms2::{CIExyY, Profile, ToneCurve};

        let d50 = CIExyY {
            x: 0.3457,
            y: 0.3585,
            Y: 1.0,
        };
        Profile::new_gray(&d50, &ToneCurve::new(2.2))
            .unwrap()
            .icc()
            .unwrap()
    }

    #[test]
    fn jpeg_preview_refuses_implicit_alpha_and_explicit_preview_keeps_source_transparency() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 255, 0]))
            .save(&input)
            .unwrap();
        let bytes: Bytes = std::fs::read(&input).unwrap().into();
        let mut request: PreviewRequest = serde_json::from_value(serde_json::json!({
            "request_id": "alpha",
            "input_path": input,
            "source_revision": "1",
            "target": "jpeg"
        }))
        .unwrap();
        let cancel = CancellationToken::new();
        let deadline = Instant::now() + TIMEOUT;

        let error =
            image_sample_bytes(bytes.clone(), tmp.path(), &request, &cancel, deadline).unwrap_err();
        assert!(error.user_message().contains("background"));

        request.image_color_policy = Some(ImageColorPolicy::AssumeSrgb);
        request.image_alpha_policy = Some(goop_core::ImageAlphaPolicy::Flatten {
            background: goop_core::SrgbColor {
                red: 12,
                green: 34,
                blue: 56,
            },
        });
        let result = image_sample_bytes(
            bytes,
            tmp.path(),
            &request,
            &cancel,
            Instant::now() + TIMEOUT,
        )
        .unwrap();
        let before = image::open(result.before_path.unwrap()).unwrap();
        assert_eq!(before.to_rgba8().get_pixel(0, 0).0[3], 0);
        let after = image::open(result.after_path).unwrap().to_rgb8();
        let pixel = after.get_pixel(0, 0).0;
        assert!((i16::from(pixel[0]) - 12).abs() <= 3);
        assert!((i16::from(pixel[1]) - 34).abs() <= 3);
        assert!((i16::from(pixel[2]) - 56).abs() <= 3);
    }

    #[test]
    fn explicit_alpha_policy_with_preserve_uses_managed_validation() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 255, 0]))
            .save(&input)
            .unwrap();
        let bytes: Bytes = std::fs::read(&input).unwrap().into();
        let mut request: PreviewRequest = serde_json::from_value(serde_json::json!({
            "request_id": "alpha-preserve",
            "input_path": input,
            "source_revision": "1",
            "target": "jpeg",
            "image_color_policy": "preserve",
            "image_alpha_policy": {
                "kind": "flatten",
                "background": { "red": 12, "green": 34, "blue": 56 }
            }
        }))
        .unwrap();
        let cancel = CancellationToken::new();

        let error = image_sample_bytes(
            bytes.clone(),
            tmp.path(),
            &request,
            &cancel,
            Instant::now() + TIMEOUT,
        )
        .unwrap_err();
        assert!(error
            .user_message()
            .contains("requires Convert to sRGB or Assume sRGB"));

        request.target = TargetFormat::Png;
        let error = image_sample_bytes(
            bytes,
            tmp.path(),
            &request,
            &cancel,
            Instant::now() + TIMEOUT,
        )
        .unwrap_err();
        assert!(error
            .user_message()
            .contains("available only for JPEG output"));
    }

    #[test]
    fn successful_image_worker_keeps_scratch_armed_until_publication() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.jpg");
        let output = tmp.path().join("sample");
        std::fs::create_dir(&output).unwrap();
        image::RgbImage::from_pixel(16, 8, image::Rgb([40, 80, 120]))
            .save(&input)
            .unwrap();
        let request = explicit_request(&input);

        let (result, scratch) = image_worker(
            &input,
            &output,
            &request,
            &CancellationToken::new(),
            Instant::now() + TIMEOUT,
        );

        assert!(result.is_ok());
        assert!(output.exists());
        drop(scratch);
        assert!(!output.exists());
    }

    #[test]
    fn captured_preview_ignores_a_later_replacement() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.jpg");
        let output = tmp.path().join("sample");
        std::fs::create_dir(&output).unwrap();
        image::RgbImage::from_pixel(16, 8, image::Rgb([240, 10, 20]))
            .save(&input)
            .unwrap();
        let request = explicit_request(&input);
        let deadline = Instant::now() + TIMEOUT;
        let token = CancellationToken::new();
        let bytes = capture_image(&input, MAX_INPUT_BYTES, &token, deadline).unwrap();
        std::fs::remove_file(&input).unwrap();
        image::RgbImage::from_pixel(8, 16, image::Rgb([10, 20, 240]))
            .save_with_format(&input, ImageFormat::Png)
            .unwrap();
        let result = image_sample_bytes(bytes, &output, &request, &token, deadline).unwrap();
        assert_eq!((result.width, result.height), (16, 8));
        for path in [result.before_path.unwrap(), result.after_path] {
            let pixel = image::open(path).unwrap().to_rgb8().get_pixel(3, 3).0;
            assert!(pixel[0] > 200 && pixel[2] < 60);
        }
        assert_eq!(
            image::ImageReader::open(input)
                .unwrap()
                .with_guessed_format()
                .unwrap()
                .into_dimensions()
                .unwrap(),
            (8, 16)
        );
    }

    #[test]
    fn captured_format_controls_explicit_preview_admission() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.png");
        image::RgbImage::new(16, 8).save(&input).unwrap();
        let token = CancellationToken::new();
        let deadline = Instant::now() + TIMEOUT;
        let bytes = capture_image(&input, MAX_INPUT_BYTES, &token, deadline).unwrap();
        std::fs::remove_file(&input).unwrap();
        image::RgbImage::new(8, 16)
            .save_with_format(&input, ImageFormat::Jpeg)
            .unwrap();
        let output = tmp.path().join("sample");
        std::fs::create_dir(&output).unwrap();
        let error = image_sample_bytes(bytes, &output, &explicit_request(&input), &token, deadline)
            .unwrap_err();
        assert!(error.to_string().contains("JPEG sources only"));
        assert_eq!(std::fs::read_dir(output).unwrap().count(), 0);
    }

    #[test]
    fn explicit_color_preview_uses_conversion_resize_and_verified_output_path() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.jpg");
        image::RgbImage::from_pixel(16, 8, image::Rgb([40, 80, 120]))
            .save(&input)
            .unwrap();
        let output = tmp.path().join("sample");
        std::fs::create_dir(&output).unwrap();
        let request: PreviewRequest = serde_json::from_value(serde_json::json!({
            "request_id":"color", "input_path":input, "source_revision":"1",
            "target":"jpeg", "metadata_policy":"strip_all",
            "image_color_policy":"assume_srgb",
            "image_options":{"jpeg_quality":88,"resize":{"kind":"fit_within","width":8,"height":4}}
        }))
        .unwrap();
        let token = CancellationToken::new();
        let deadline = Instant::now() + TIMEOUT;
        let bytes = capture_image(&input, MAX_INPUT_BYTES, &token, deadline).unwrap();

        let result = image_sample_bytes(bytes, &output, &request, &token, deadline).unwrap();

        assert_eq!((result.width, result.height), (8, 4));
        assert_eq!(
            image::open(result.before_path.unwrap())
                .unwrap()
                .dimensions(),
            (8, 4)
        );
        assert_eq!(image::open(result.after_path).unwrap().dimensions(), (8, 4));
    }

    #[test]
    fn tagged_color_preview_renders_source_sample_in_display_srgb() {
        use img_parts::{png::Png, ImageICC};

        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("wide-gamut.png");
        let source = image::RgbImage::from_pixel(2, 1, image::Rgb([64, 180, 96]));
        source.save(&input).unwrap();
        let profile = wide_rgb_profile();
        let expected = crate::color::transform_pixels(
            DynamicImage::ImageRgb8(source.clone()),
            Some(profile.clone()),
            ImageColorPolicy::ConvertToSrgb,
            &CancellationToken::new(),
        )
        .unwrap()
        .pixels;
        assert_ne!(expected, source);
        let mut tagged = Png::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
        tagged.set_icc_profile(Some(profile.into()));
        std::fs::write(&input, tagged.encoder().bytes()).unwrap();

        let output = tmp.path().join("sample");
        std::fs::create_dir(&output).unwrap();
        let request: PreviewRequest = serde_json::from_value(serde_json::json!({
            "request_id":"tagged", "input_path":input, "source_revision":"1",
            "target":"png", "metadata_policy":"preserve",
            "image_color_policy":"convert_to_srgb"
        }))
        .unwrap();
        let token = CancellationToken::new();
        let deadline = Instant::now() + TIMEOUT;
        let bytes = capture_image(&input, MAX_INPUT_BYTES, &token, deadline).unwrap();

        let result = image_sample_bytes(bytes, &output, &request, &token, deadline).unwrap();

        assert_eq!(
            image::open(result.before_path.unwrap()).unwrap().to_rgb8(),
            expected
        );
    }

    #[test]
    fn tagged_alpha_preview_transforms_source_sample_and_preserves_transparency() {
        use img_parts::{png::Png, ImageICC};

        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("wide-gamut-alpha.png");
        let source = image::RgbaImage::from_pixel(2, 1, image::Rgba([64, 180, 96, 127]));
        source.save(&input).unwrap();
        let profile = wide_rgb_profile();
        let expected_foreground = crate::color::transform_pixels(
            DynamicImage::ImageRgb8(image::RgbImage::from_pixel(2, 1, image::Rgb([64, 180, 96]))),
            Some(profile.clone()),
            ImageColorPolicy::ConvertToSrgb,
            &CancellationToken::new(),
        )
        .unwrap()
        .pixels;
        assert_ne!(expected_foreground.get_pixel(0, 0).0, [64, 180, 96]);
        let mut tagged = Png::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
        tagged.set_icc_profile(Some(profile.into()));
        std::fs::write(&input, tagged.encoder().bytes()).unwrap();

        let output = tmp.path().join("sample");
        std::fs::create_dir(&output).unwrap();
        let request: PreviewRequest = serde_json::from_value(serde_json::json!({
            "request_id":"tagged-alpha", "input_path":input, "source_revision":"1",
            "target":"jpeg", "metadata_policy":"strip_all",
            "image_color_policy":"convert_to_srgb",
            "image_alpha_policy":{
                "kind":"flatten",
                "background":{"red":255,"green":255,"blue":255}
            }
        }))
        .unwrap();
        let token = CancellationToken::new();
        let deadline = Instant::now() + TIMEOUT;
        let bytes = capture_image(&input, MAX_INPUT_BYTES, &token, deadline).unwrap();

        let result = image_sample_bytes(bytes, &output, &request, &token, deadline).unwrap();
        let before = image::open(result.before_path.unwrap()).unwrap().to_rgba8();

        assert_eq!(
            &before.get_pixel(0, 0).0[..3],
            &expected_foreground.get_pixel(0, 0).0
        );
        assert_eq!(before.get_pixel(0, 0).0[3], 127);
    }

    #[test]
    fn tagged_gray_alpha_preview_transforms_source_sample_and_preserves_transparency() {
        use img_parts::{png::Png, ImageICC};

        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("tagged-gray-alpha.png");
        let source = image::GrayAlphaImage::from_pixel(2, 1, image::LumaA([180, 127]));
        source.save(&input).unwrap();
        let profile = gray_profile();
        let expected_foreground = crate::color::transform_pixels(
            DynamicImage::ImageLuma8(image::GrayImage::from_pixel(2, 1, image::Luma([180]))),
            Some(profile.clone()),
            ImageColorPolicy::ConvertToSrgb,
            &CancellationToken::new(),
        )
        .unwrap()
        .pixels;
        let mut tagged = Png::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
        tagged.set_icc_profile(Some(profile.into()));
        std::fs::write(&input, tagged.encoder().bytes()).unwrap();

        let output = tmp.path().join("sample");
        std::fs::create_dir(&output).unwrap();
        let request: PreviewRequest = serde_json::from_value(serde_json::json!({
            "request_id":"tagged-gray-alpha", "input_path":input, "source_revision":"1",
            "target":"jpeg", "metadata_policy":"strip_all",
            "image_color_policy":"convert_to_srgb",
            "image_alpha_policy":{
                "kind":"flatten",
                "background":{"red":255,"green":255,"blue":255}
            }
        }))
        .unwrap();
        let token = CancellationToken::new();
        let deadline = Instant::now() + TIMEOUT;
        let bytes = capture_image(&input, MAX_INPUT_BYTES, &token, deadline).unwrap();

        let result = image_sample_bytes(bytes, &output, &request, &token, deadline).unwrap();
        let before = image::open(result.before_path.unwrap()).unwrap().to_rgba8();

        assert_eq!(
            &before.get_pixel(0, 0).0[..3],
            &expected_foreground.get_pixel(0, 0).0
        );
        assert_eq!(before.get_pixel(0, 0).0[3], 127);
    }

    #[test]
    fn webp_quality_preview_uses_the_lossy_encoder() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.png");
        image::RgbImage::from_fn(64, 64, |x, y| {
            image::Rgb([x as u8 * 4, y as u8 * 4, (x ^ y) as u8 * 4])
        })
        .save(&input)
        .unwrap();
        let token = CancellationToken::new();
        let deadline = Instant::now() + TIMEOUT;
        let bytes = capture_image(&input, MAX_INPUT_BYTES, &token, deadline).unwrap();
        let make_request = |quality| {
            serde_json::from_value(serde_json::json!({
                "request_id": format!("webp-{quality}"),
                "input_path": input,
                "source_revision": "1",
                "target": "webp",
                "compress_mode": { "kind": "quality", "value": quality }
            }))
            .unwrap()
        };
        let low_dir = tmp.path().join("low");
        let high_dir = tmp.path().join("high");
        std::fs::create_dir(&low_dir).unwrap();
        std::fs::create_dir(&high_dir).unwrap();
        let low = image_sample_bytes(bytes.clone(), &low_dir, &make_request(1), &token, deadline)
            .unwrap();
        let high =
            image_sample_bytes(bytes, &high_dir, &make_request(100), &token, deadline).unwrap();
        assert_ne!(low.sample_bytes, high.sample_bytes);
    }

    #[test]
    fn capture_rejects_over_limit_and_cancelled_or_expired_work() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.jpg");
        std::fs::write(&input, [0; 33]).unwrap();
        let token = CancellationToken::new();
        let deadline = Instant::now() + TIMEOUT;
        assert!(capture_image(&input, 32, &token, deadline)
            .unwrap_err()
            .to_string()
            .contains("64 MiB"));
        assert_eq!(
            capture_image(&input, 33, &token, deadline).unwrap().len(),
            33
        );
        let missing = tmp.path().join("missing");
        assert!(capture_image(&missing, 33, &token, Instant::now())
            .unwrap_err()
            .to_string()
            .contains("timed out"));
        token.cancel();
        assert!(matches!(
            capture_image(&missing, 33, &token, deadline),
            Err(GoopError::Cancelled)
        ));
        let output = tmp.path().join("uncreated");
        assert!(matches!(
            image_sample_bytes(
                img_parts::Bytes::new(),
                &output,
                &explicit_request(&input),
                &token,
                deadline
            ),
            Err(GoopError::Cancelled)
        ));
        assert!(!output.exists());
    }

    #[test]
    fn snapshot_revalidation_rejects_same_size_same_mtime_substitution() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.png");
        std::fs::write(&input, [1_u8; 32]).unwrap();
        let original = std::fs::metadata(&input).unwrap();
        let snapshot = std::fs::read(&input).unwrap();

        std::fs::write(&input, [2_u8; 32]).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&input)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(original.modified().unwrap()))
            .unwrap();
        let replacement = std::fs::metadata(&input).unwrap();
        assert_eq!(replacement.len(), original.len());
        assert_eq!(
            replacement.modified().unwrap(),
            original.modified().unwrap()
        );

        let error = verify_snapshot_unchanged(
            &input,
            &snapshot,
            &CancellationToken::new(),
            Instant::now() + TIMEOUT,
        )
        .unwrap_err();
        assert!(error.to_string().contains("Source changed"));
    }
}
