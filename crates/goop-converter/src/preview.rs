//! Explicit, isolated sample generation. Never schedules jobs or writes source files.
use goop_core::{
    CompressMode, GoopError, JobId, PreviewKind, PreviewRequest, PreviewResult, QualityPreset,
    ResolutionCap, TargetFormat,
};
use goop_sidecar::BinaryResolver;
use image::{ImageDecoder, ImageFormat};
use std::{
    io::Cursor,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command, sync::Semaphore};
use tokio_util::sync::CancellationToken;
const EDGE: u32 = 1280;
const PIXELS: u64 = 4_000_000;
const BYTES: u64 = 16 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
fn invalid(message: impl Into<String>) -> GoopError {
    GoopError::InvalidRequest(message.into())
}
pub fn validate_pixels(width: u32, height: u32) -> Result<(), GoopError> {
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > PIXELS {
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
        if request.request_id.is_empty() || request.request_id.len() > 200 {
            return Err(invalid("Invalid preview request identity"));
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
            && request.target != TargetFormat::Jpeg
        {
            return Err(invalid("Sample quality control is available for JPEG only"));
        }
        if !is_image
            && matches!(
                request.compress_mode,
                Some(CompressMode::LosslessReoptimize)
            )
        {
            return Err(invalid("Lossless video sample preview is unavailable"));
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
        let mut scratch = Scratch(Some(directory.clone()));
        let original = std::fs::metadata(&input)?;
        let result = if is_image {
            let req = request.clone();
            let path = input.clone();
            let dir = directory.clone();
            let token = cancel.clone();
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                image_sample(&path, &dir, &req, &token, deadline)
            })
            .await
            .map_err(|e| invalid(e.to_string()))?
        } else {
            let _permit = permit;
            video_sample(resolver, &input, &directory, &request, &cancel, deadline).await
        };
        let result = result?;
        checkpoint(&cancel, deadline)?;
        let latest = std::fs::metadata(&input)?;
        if latest.len() != original.len() || latest.modified().ok() != original.modified().ok() {
            return Err(invalid("Source changed while generating preview"));
        }
        let mut state = self.state.lock().unwrap();
        checkpoint(&cancel, deadline)?;
        if let Some((_, old)) = state
            .completed
            .replace((request.request_id.clone(), directory))
        {
            let _ = std::fs::remove_dir_all(old);
        }
        scratch.0.take();
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
fn image_sample(
    input: &Path,
    dir: &Path,
    request: &PreviewRequest,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<PreviewResult, GoopError> {
    if std::fs::metadata(input)?.len() > 64 * 1024 * 1024 {
        return Err(invalid("Image preview source exceeds 64 MiB input limit"));
    }
    let mut reader = image::ImageReader::open(input)?.with_guessed_format()?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP)
    ) {
        return Err(invalid(
            "Sample preview unavailable for this image encoding",
        ));
    }
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| invalid(e.to_string()))?;
    let (width, height) = decoder.dimensions();
    validate_pixels(width, height)?;
    if decoder.total_bytes() > PIXELS * 16 {
        return Err(invalid("Decoded image exceeds preview memory limit"));
    }
    let orientation = decoder.orientation().map_err(|e| invalid(e.to_string()))?;
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
            let q = match request.compress_mode {
                Some(CompressMode::Quality(q)) => q.max(1),
                _ => 75,
            };
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, q)
                .encode_image(&sample.to_rgb8())
                .map_err(|e| invalid(e.to_string()))?;
        }
        TargetFormat::Png => sample
            .write_to(&mut encoded, ImageFormat::Png)
            .map_err(|e| invalid(e.to_string()))?,
        TargetFormat::Webp => sample
            .write_to(&mut encoded, ImageFormat::WebP)
            .map_err(|e| invalid(e.to_string()))?,
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
