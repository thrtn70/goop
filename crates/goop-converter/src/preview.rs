//! Explicit, isolated sample generation. Never schedules jobs or writes source files.
use goop_core::{
    is_canonical_preview_session_id, new_preview_session_id, CompressMode, GoopError,
    ImageColorPolicy, ImageResize, JobId, MetadataPolicy, PreviewEligibility, PreviewKind,
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
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{Notify, Semaphore},
};
use tokio_util::sync::CancellationToken;
#[cfg(feature = "heic-thumbnail-preview")]
use {
    crate::heic_preview_sampler::{
        inspect_heic_thumbnail, sample_heic_thumbnail, Dimensions, SampleFrame, SamplerError,
    },
    goop_core::{ImagePreviewDetails, ImageSampleKind},
    sha2::{Digest, Sha256},
};

#[cfg(feature = "heic-thumbnail-preview")]
type HeicSampler =
    dyn Fn(&[u8], &CancellationToken, Instant) -> Result<SampleFrame, SamplerError> + Send + Sync;

#[cfg(feature = "heic-thumbnail-preview")]
type HeicAdmissionInspector =
    dyn Fn(&[u8], &CancellationToken, Instant) -> Result<(), SamplerError> + Send + Sync;

#[cfg(feature = "heic-thumbnail-preview")]
fn default_heic_sampler() -> Arc<HeicSampler> {
    Arc::new(|bytes, cancel, deadline| {
        sample_heic_thumbnail(bytes, &|| {
            checkpoint(cancel, deadline).map_err(|error| SamplerError::Interrupted {
                reason: error.user_message(),
            })
        })
    })
}

#[cfg(feature = "heic-thumbnail-preview")]
fn default_heic_admission_inspector() -> Arc<HeicAdmissionInspector> {
    Arc::new(|bytes, cancel, deadline| {
        inspect_heic_thumbnail(bytes, &|| {
            checkpoint(cancel, deadline).map_err(|error| SamplerError::Interrupted {
                reason: error.user_message(),
            })
        })
    })
}
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

fn validate_request_identity(request: &PreviewRequest) -> Result<(), GoopError> {
    if request.request_id.is_empty() || request.request_id.len() > 200 {
        Err(invalid("Invalid preview request identity"))
    } else {
        Ok(())
    }
}

fn validate_request_admission(request: &PreviewRequest) -> Result<(), GoopError> {
    if request.video_options.is_some() {
        return Err(invalid(crate::video_options::PREVIEW_REASON));
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
    if matches!(request.compress_mode,Some(CompressMode::Quality(q)) if q==0 || q>100) {
        return Err(invalid("Quality must be between 1 and 100"));
    }
    Ok(())
}

enum PreviewInputPath {
    File(PathBuf),
    Missing,
    NotFile,
}

fn inspect_preview_input_path(
    input_path: &str,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<PreviewInputPath, GoopError> {
    checkpoint(cancel, deadline)?;
    let expanded = goop_core::path::expand(input_path);
    let input = match std::fs::canonicalize(expanded) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PreviewInputPath::Missing)
        }
        Err(error) => return Err(GoopError::Io(error)),
    };
    let metadata = match std::fs::metadata(&input) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PreviewInputPath::Missing)
        }
        Err(error) => return Err(GoopError::Io(error)),
    };
    checkpoint(cancel, deadline)?;
    if metadata.is_file() {
        Ok(PreviewInputPath::File(input))
    } else {
        Ok(PreviewInputPath::NotFile)
    }
}

async fn preview_input_path(
    input_path: &str,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<PreviewInputPath, GoopError> {
    let input_path = input_path.to_owned();
    let cancel = cancel.clone();
    tokio::task::spawn_blocking(move || inspect_preview_input_path(&input_path, &cancel, deadline))
        .await
        .map_err(|error| {
            GoopError::InvalidRequest(format!("Preview path inspection task failed: {error}"))
        })?
}

fn preview_source_family(
    request: &PreviewRequest,
    extension: &str,
) -> Result<PreviewSourceFamily, GoopError> {
    let is_heic = matches!(extension, "heic" | "heif");
    if is_heic {
        #[cfg(not(feature = "heic-thumbnail-preview"))]
        return Err(GoopError::PreviewUnavailable(
            "Bounded HEIC preview is not enabled in this build.".into(),
        ));
        #[cfg(feature = "heic-thumbnail-preview")]
        if request.image_options.is_none() || request.target != TargetFormat::Jpeg {
            return Err(invalid(
                "Bounded HEIC preview requires explicit JPEG conversion settings",
            ));
        }
    }

    let family = if matches!(extension, "png" | "jpg" | "jpeg" | "webp") {
        PreviewSourceFamily::Raster
    } else if is_heic {
        PreviewSourceFamily::Heic
    } else if crate::backend_for_extension(extension) == crate::BackendKind::ImageMagick {
        return Err(invalid(
            "Sample preview unavailable for this image source; bounded decoding is not supported",
        ));
    } else {
        PreviewSourceFamily::Video
    };

    if matches!(family, PreviewSourceFamily::Raster)
        && request
            .image_options
            .as_ref()
            .is_some_and(|options| !matches!(options.resize, ImageResize::Original))
    {
        return Err(invalid("Fit within image samples are not available yet"));
    }
    if matches!(
        family,
        PreviewSourceFamily::Raster | PreviewSourceFamily::Heic
    ) && !matches!(
        request.target,
        TargetFormat::Jpeg | TargetFormat::Png | TargetFormat::Webp
    ) {
        return Err(invalid("Sample preview unavailable for this image target"));
    }
    if matches!(
        family,
        PreviewSourceFamily::Raster | PreviewSourceFamily::Heic
    ) && request
        .resolution_cap
        .is_some_and(|cap| cap != ResolutionCap::Original)
    {
        return Err(invalid("Image conversion does not support resolution caps"));
    }
    if matches!(
        family,
        PreviewSourceFamily::Raster | PreviewSourceFamily::Heic
    ) && request.target == TargetFormat::Jpeg
        && matches!(
            request.compress_mode,
            Some(CompressMode::LosslessReoptimize)
        )
    {
        return Err(invalid("Lossless JPEG sample preview is unavailable"));
    }
    if matches!(family, PreviewSourceFamily::Video) && request.target != TargetFormat::Mp4 {
        return Err(invalid("Video sample preview is available for MP4 only"));
    }
    if matches!(
        family,
        PreviewSourceFamily::Raster | PreviewSourceFamily::Heic
    ) && request
        .quality_preset
        .is_some_and(|quality| quality != QualityPreset::Original)
    {
        return Err(invalid(
            "Image sample does not support video quality presets",
        ));
    }
    if matches!(
        family,
        PreviewSourceFamily::Raster | PreviewSourceFamily::Heic
    ) && matches!(request.compress_mode, Some(CompressMode::Quality(_)))
        && !matches!(request.target, TargetFormat::Jpeg | TargetFormat::Webp)
    {
        return Err(invalid(
            "Sample quality control is available for JPEG and WebP only",
        ));
    }
    if matches!(family, PreviewSourceFamily::Video)
        && matches!(
            request.compress_mode,
            Some(CompressMode::LosslessReoptimize)
        )
    {
        return Err(invalid("Lossless video sample preview is unavailable"));
    }
    if request.image_options.is_some() && matches!(family, PreviewSourceFamily::Video) {
        return Err(invalid(
            "Explicit image samples are available for JPEG sources only",
        ));
    }
    Ok(family)
}

fn validate_source_facts(
    request: &PreviewRequest,
    facts: &PreviewSourceFacts,
) -> Result<(), GoopError> {
    match facts {
        PreviewSourceFacts::Raster {
            format,
            width,
            height,
            decoded_bytes,
            has_alpha,
        } => {
            if !matches!(
                format,
                ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP
            ) {
                return Err(invalid(
                    "Sample preview unavailable for this image encoding",
                ));
            }
            let uses_managed_image_path = request.image_color_policy.unwrap_or_default()
                != ImageColorPolicy::Preserve
                || request.image_alpha_policy.is_some();
            if request.image_options.is_some()
                && *format != ImageFormat::Jpeg
                && !uses_managed_image_path
            {
                return Err(invalid(
                    "Explicit image samples are available for JPEG sources only",
                ));
            }
            validate_pixels(*width, *height)?;
            if *decoded_bytes > MAX_SOURCE_PIXELS * 16 {
                return Err(invalid("Decoded image exceeds preview memory limit"));
            }
            if request.target == TargetFormat::Jpeg
                && *has_alpha
                && request.image_alpha_policy.is_none()
            {
                return Err(invalid(
                    "JPEG removes transparency; choose an explicit background before previewing.",
                ));
            }
        }
        #[cfg(feature = "heic-thumbnail-preview")]
        PreviewSourceFacts::Heic { unavailable_reason } => {
            if let Some(reason) = unavailable_reason {
                return Err(GoopError::PreviewUnavailable(reason.clone()));
            }
        }
        PreviewSourceFacts::Unavailable(reason) => {
            return Err(GoopError::PreviewUnavailable(reason.clone()));
        }
        PreviewSourceFacts::Video {
            has_video,
            duration_ms,
            width,
            height,
        } => {
            if !has_video || *duration_ms == 0 {
                return Err(invalid(
                    "Video sample requires a video stream with known duration",
                ));
            }
            validate_pixels(width.unwrap_or(0), height.unwrap_or(0))?;
            let (width, height) =
                bounded_dimensions(width.unwrap_or(0), height.unwrap_or(0), edge(request));
            if width < 2 || height < 2 {
                return Err(invalid("Invalid video dimensions"));
            }
        }
    }
    Ok(())
}

/// Convert only a refusal returned by the deterministic admission helpers.
/// Inspection and worker errors must bypass this function so the client can retry them.
fn deterministic_unavailable(error: GoopError) -> PreviewEligibility {
    match error {
        GoopError::InvalidRequest(reason) | GoopError::PreviewUnavailable(reason) => {
            PreviewEligibility {
                available: false,
                reason: Some(reason),
            }
        }
        error => unreachable!("admission helper returned a non-refusal error: {error}"),
    }
}
struct ActiveRequest {
    request_id: String,
    epoch: u64,
    cancel: CancellationToken,
}

struct ActiveEligibility {
    key: Vec<u8>,
    epoch: u64,
    work_cancel: CancellationToken,
    shared: Arc<EligibilityFlight>,
    waiters: Vec<EligibilityWaiter>,
}

struct EligibilityWaiter {
    id: u64,
    request_id: String,
    cancel: CancellationToken,
}

struct EligibilityRegistration {
    flight_epoch: u64,
    waiter_id: u64,
    owner: bool,
    work_cancel: CancellationToken,
    waiter_cancel: CancellationToken,
    shared: Arc<EligibilityFlight>,
}

struct EligibilityFlight {
    result: Mutex<Option<SharedEligibilityResult>>,
    notify: Notify,
}

type SharedEligibilityResult = Result<PreviewEligibility, SharedEligibilityError>;

#[derive(Clone)]
enum SharedEligibilityError {
    SidecarMissing(String),
    SubprocessFailed {
        binary: String,
        stderr: String,
    },
    Queue(String),
    Config(String),
    InvalidRequest(String),
    PreviewUnavailable(String),
    Cancelled,
    Paused,
    Network(String),
    WaitingExternal {
        retry_after_ms: u64,
    },
    Io {
        kind: std::io::ErrorKind,
        message: String,
    },
    Serde(String),
}

impl From<&GoopError> for SharedEligibilityError {
    fn from(error: &GoopError) -> Self {
        match error {
            GoopError::SidecarMissing(value) => Self::SidecarMissing(value.clone()),
            GoopError::SubprocessFailed { binary, stderr } => Self::SubprocessFailed {
                binary: binary.clone(),
                stderr: stderr.clone(),
            },
            GoopError::Queue(value) => Self::Queue(value.clone()),
            GoopError::Config(value) => Self::Config(value.clone()),
            GoopError::InvalidRequest(value) => Self::InvalidRequest(value.clone()),
            GoopError::PreviewUnavailable(value) => Self::PreviewUnavailable(value.clone()),
            GoopError::Cancelled => Self::Cancelled,
            GoopError::Paused => Self::Paused,
            GoopError::Network(value) => Self::Network(value.clone()),
            GoopError::WaitingExternal { retry_after_ms } => Self::WaitingExternal {
                retry_after_ms: *retry_after_ms,
            },
            GoopError::Io(error) => Self::Io {
                kind: error.kind(),
                message: error.to_string(),
            },
            GoopError::Serde(error) => Self::Serde(error.to_string()),
        }
    }
}

impl SharedEligibilityError {
    fn into_error(self) -> GoopError {
        match self {
            Self::SidecarMissing(value) => GoopError::SidecarMissing(value),
            Self::SubprocessFailed { binary, stderr } => {
                GoopError::SubprocessFailed { binary, stderr }
            }
            Self::Queue(value) => GoopError::Queue(value),
            Self::Config(value) => GoopError::Config(value),
            Self::InvalidRequest(value) => GoopError::InvalidRequest(value),
            Self::PreviewUnavailable(value) => GoopError::PreviewUnavailable(value),
            Self::Cancelled => GoopError::Cancelled,
            Self::Paused => GoopError::Paused,
            Self::Network(value) => GoopError::Network(value),
            Self::WaitingExternal { retry_after_ms } => {
                GoopError::WaitingExternal { retry_after_ms }
            }
            Self::Io { kind, message } => GoopError::Io(std::io::Error::new(kind, message)),
            Self::Serde(message) => GoopError::Serde(serde_json::Error::io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            ))),
        }
    }
}

impl EligibilityFlight {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            notify: Notify::new(),
        }
    }

    fn publish(&self, result: &Result<PreviewEligibility, GoopError>) {
        let shared = match result {
            Ok(value) => Ok(value.clone()),
            Err(error) => Err(SharedEligibilityError::from(error)),
        };
        *self.result.lock().unwrap() = Some(shared);
        self.notify.notify_waiters();
    }

    fn cloned_result(&self) -> Option<Result<PreviewEligibility, GoopError>> {
        self.result
            .lock()
            .unwrap()
            .clone()
            .map(|result| result.map_err(SharedEligibilityError::into_error))
    }

    async fn wait(
        &self,
        caller_cancel: &CancellationToken,
    ) -> Result<PreviewEligibility, GoopError> {
        loop {
            let notified = self.notify.notified();
            if caller_cancel.is_cancelled() {
                return Err(GoopError::Cancelled);
            }
            if let Some(result) = self.cloned_result() {
                return result;
            }
            tokio::select! {
                _ = notified => {}
                _ = caller_cancel.cancelled() => return Err(GoopError::Cancelled),
            }
        }
    }
}

struct PublishedArtifacts {
    request_id: String,
    path: PathBuf,
}

struct PendingSessionCleanup {
    session_id: Option<String>,
    artifacts: Vec<PublishedArtifacts>,
}

#[cfg(feature = "heic-thumbnail-preview")]
#[derive(Clone)]
struct HeicCacheEntry {
    session_id: String,
    source_digest: [u8; 32],
    frame: Arc<SampleFrame>,
}

#[cfg(not(feature = "heic-thumbnail-preview"))]
type HeicCacheEntry = ();

struct ImageWorkerContext {
    root: PathBuf,
    cached_heic: Option<HeicCacheEntry>,
    #[cfg(feature = "heic-thumbnail-preview")]
    heic_sampler: Arc<HeicSampler>,
}

#[derive(Clone, Copy)]
enum PreviewSourceFamily {
    Raster,
    Heic,
    Video,
}

enum PreviewSourceFacts {
    Raster {
        format: ImageFormat,
        width: u32,
        height: u32,
        decoded_bytes: u64,
        has_alpha: bool,
    },
    #[cfg(feature = "heic-thumbnail-preview")]
    Heic {
        unavailable_reason: Option<String>,
    },
    Unavailable(String),
    Video {
        has_video: bool,
        duration_ms: u64,
        width: Option<u32>,
        height: Option<u32>,
    },
}

#[cfg(feature = "heic-thumbnail-preview")]
#[derive(Clone)]
struct HeicAdmissionCacheEntry {
    path: PathBuf,
    source_digest: [u8; 32],
    unavailable_reason: Option<String>,
}

#[derive(Default)]
struct State {
    epoch: u64,
    eligibility_epoch: u64,
    session_id: Option<String>,
    active: Option<ActiveRequest>,
    eligibility: Option<ActiveEligibility>,
    completed: Option<PublishedArtifacts>,
    retired: Option<PublishedArtifacts>,
    pending_cleanup: Option<PendingSessionCleanup>,
}

fn invalidate_generation(state: &mut State) -> Vec<PublishedArtifacts> {
    state.epoch = state
        .epoch
        .checked_add(1)
        .expect("preview session epoch exhausted");
    if let Some(active) = state.active.take() {
        active.cancel.cancel();
    }
    state
        .completed
        .take()
        .into_iter()
        .chain(state.retired.take())
        .collect()
}

fn remove_artifacts(
    artifacts: Vec<PublishedArtifacts>,
    remove: &mut impl FnMut(&Path) -> std::io::Result<()>,
) -> (Vec<PublishedArtifacts>, Option<std::io::Error>) {
    let mut retained = Vec::with_capacity(artifacts.len());
    let mut first_error = None;
    for artifact in artifacts {
        match remove(&artifact.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
                retained.push(artifact);
            }
        }
    }
    (retained, first_error)
}

fn retry_pending_cleanup(
    state: &mut State,
    session_id: Option<&str>,
    remove: &mut impl FnMut(&Path) -> std::io::Result<()>,
) -> Result<(), GoopError> {
    let should_retry = state
        .pending_cleanup
        .as_ref()
        .is_some_and(|pending| session_id.is_none() || pending.session_id.as_deref() == session_id);
    if !should_retry {
        return Ok(());
    }
    let mut pending = state
        .pending_cleanup
        .take()
        .expect("checked pending cleanup exists");
    let (retained, first_error) = remove_artifacts(pending.artifacts, remove);
    if !retained.is_empty() {
        pending.artifacts = retained;
        state.pending_cleanup = Some(pending);
    }
    first_error.map_or(Ok(()), |error| Err(GoopError::Io(error)))
}

fn remove_slot(
    slot: &mut Option<PublishedArtifacts>,
    remove: &mut impl FnMut(&Path) -> std::io::Result<()>,
) -> Result<(), GoopError> {
    let Some(artifact) = slot.take() else {
        return Ok(());
    };
    match remove(&artifact.path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            *slot = Some(artifact);
            Err(GoopError::Io(error))
        }
    }
}

fn epoch_context_is_current(
    state: &State,
    requested_session: Option<&str>,
    requested_epoch: u64,
) -> bool {
    let session_matches = match requested_session {
        Some(session_id) => state.session_id.as_deref() == Some(session_id),
        None => state.session_id.is_none(),
    };
    session_matches && state.epoch == requested_epoch
}

fn publication_is_current(
    state: &State,
    request_id: &str,
    requested_session: Option<&str>,
    requested_epoch: u64,
) -> bool {
    let active_matches = state
        .active
        .as_ref()
        .is_some_and(|active| active.request_id == request_id && active.epoch == requested_epoch);
    active_matches && epoch_context_is_current(state, requested_session, requested_epoch)
}

fn register_request(
    state: &mut State,
    request_id: String,
    requested_session: Option<&str>,
    requested_epoch: u64,
    cancel: CancellationToken,
) -> Result<(), GoopError> {
    if !epoch_context_is_current(state, requested_session, requested_epoch) {
        return Err(GoopError::PreviewUnavailable(
            "Preview session is no longer active.".into(),
        ));
    }
    if let Some(old) = state.active.replace(ActiveRequest {
        request_id,
        epoch: requested_epoch,
        cancel,
    }) {
        old.cancel.cancel();
    }
    if let Some(eligibility) = state.eligibility.take() {
        cancel_eligibility_flight(eligibility);
    }
    Ok(())
}

fn eligibility_key(
    resolver: &BinaryResolver,
    request: &PreviewRequest,
) -> Result<Vec<u8>, GoopError> {
    let mut admission = request.clone();
    admission.request_id.clear();
    admission.preview_session_id = None;
    admission.pinned_jpeg_quality = None;
    serde_json::to_vec(&(admission, resolver.sidecar_dir(), resolver.update_dir()))
        .map_err(GoopError::from)
}

fn cancel_eligibility_flight(active: ActiveEligibility) {
    active.work_cancel.cancel();
    for waiter in active.waiters {
        waiter.cancel.cancel();
    }
}

fn register_eligibility(
    state: &mut State,
    key: Vec<u8>,
    request_id: String,
) -> EligibilityRegistration {
    state.eligibility_epoch = state
        .eligibility_epoch
        .checked_add(1)
        .expect("preview eligibility epoch exhausted");
    let waiter_id = state.eligibility_epoch;
    let waiter_cancel = CancellationToken::new();
    if let Some(active) = state
        .eligibility
        .as_mut()
        .filter(|active| active.key == key && !active.work_cancel.is_cancelled())
    {
        active.waiters.push(EligibilityWaiter {
            id: waiter_id,
            request_id,
            cancel: waiter_cancel.clone(),
        });
        return EligibilityRegistration {
            flight_epoch: active.epoch,
            waiter_id,
            owner: false,
            work_cancel: active.work_cancel.clone(),
            waiter_cancel,
            shared: Arc::clone(&active.shared),
        };
    }
    if let Some(old) = state.eligibility.take() {
        cancel_eligibility_flight(old);
    }
    let work_cancel = CancellationToken::new();
    let shared = Arc::new(EligibilityFlight::new());
    state.eligibility = Some(ActiveEligibility {
        key,
        epoch: waiter_id,
        work_cancel: work_cancel.clone(),
        shared: Arc::clone(&shared),
        waiters: vec![EligibilityWaiter {
            id: waiter_id,
            request_id,
            cancel: waiter_cancel.clone(),
        }],
    });
    EligibilityRegistration {
        flight_epoch: waiter_id,
        waiter_id,
        owner: true,
        work_cancel,
        waiter_cancel,
        shared,
    }
}

fn finish_eligibility(state: &mut State, epoch: u64) {
    if state
        .eligibility
        .as_ref()
        .is_some_and(|active| active.epoch == epoch)
    {
        state.eligibility = None;
    }
}

fn detach_eligibility_waiter(state: &mut State, flight_epoch: u64, waiter_id: u64) {
    let Some(active) = state
        .eligibility
        .as_mut()
        .filter(|active| active.epoch == flight_epoch)
    else {
        return;
    };
    active.waiters.retain(|waiter| waiter.id != waiter_id);
    if active.waiters.is_empty() {
        active.work_cancel.cancel();
        state.eligibility = None;
    }
}

pub struct PreviewService {
    root: PathBuf,
    state: Mutex<State>,
    #[cfg(feature = "heic-thumbnail-preview")]
    heic_cache: Mutex<Option<HeicCacheEntry>>,
    #[cfg(feature = "heic-thumbnail-preview")]
    heic_admission_cache: Mutex<Option<HeicAdmissionCacheEntry>>,
    #[cfg(feature = "heic-thumbnail-preview")]
    heic_sampler: Arc<HeicSampler>,
    #[cfg(feature = "heic-thumbnail-preview")]
    heic_admission_inspector: Arc<HeicAdmissionInspector>,
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

fn prepare_preview_output(
    root: &Path,
    staging: &Path,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<(), GoopError> {
    checkpoint(cancel, deadline)?;
    std::fs::create_dir_all(staging)?;
    std::fs::write(root.join(".goop-preview-session"), b"v1")?;
    checkpoint(cancel, deadline)
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
            #[cfg(feature = "heic-thumbnail-preview")]
            heic_cache: Mutex::new(None),
            #[cfg(feature = "heic-thumbnail-preview")]
            heic_admission_cache: Mutex::new(None),
            #[cfg(feature = "heic-thumbnail-preview")]
            heic_sampler: default_heic_sampler(),
            #[cfg(feature = "heic-thumbnail-preview")]
            heic_admission_inspector: default_heic_admission_inspector(),
            gate: Arc::new(Semaphore::new(1)),
        }
    }

    #[cfg(all(test, feature = "heic-thumbnail-preview"))]
    fn new_with_heic_sampler(root: PathBuf, heic_sampler: Arc<HeicSampler>) -> Self {
        Self {
            root: root.join(format!("session-{}", JobId::new().0)),
            state: Mutex::new(State::default()),
            heic_cache: Mutex::new(None),
            heic_admission_cache: Mutex::new(None),
            heic_sampler,
            heic_admission_inspector: default_heic_admission_inspector(),
            gate: Arc::new(Semaphore::new(1)),
        }
    }

    #[cfg(all(test, feature = "heic-thumbnail-preview"))]
    fn new_with_heic_admission_inspector(
        root: PathBuf,
        inspector: Arc<HeicAdmissionInspector>,
    ) -> Self {
        Self {
            root: root.join(format!("session-{}", JobId::new().0)),
            state: Mutex::new(State::default()),
            heic_cache: Mutex::new(None),
            heic_admission_cache: Mutex::new(None),
            heic_sampler: default_heic_sampler(),
            heic_admission_inspector: inspector,
            gate: Arc::new(Semaphore::new(1)),
        }
    }
    pub fn cancel(&self, id: &str) {
        self.cancel_with(id, |path| std::fs::remove_dir_all(path));
    }

    fn cancel_with(&self, id: &str, mut remove: impl FnMut(&Path) -> std::io::Result<()>) {
        let mut state = self.state.lock().unwrap();
        if let Some(active) = &state.active {
            if active.request_id == id {
                active.cancel.cancel();
            }
        }
        let mut cancel_empty_flight = false;
        if let Some(active) = state.eligibility.as_mut() {
            active.waiters.retain(|waiter| {
                if waiter.request_id == id {
                    waiter.cancel.cancel();
                    false
                } else {
                    true
                }
            });
            cancel_empty_flight = active.waiters.is_empty();
            if cancel_empty_flight {
                active.work_cancel.cancel();
            }
        }
        if cancel_empty_flight {
            state.eligibility = None;
        }
        if state
            .completed
            .as_ref()
            .is_some_and(|artifact| artifact.request_id == id)
        {
            // Request cancellation is intentionally best-effort. Session release
            // uses the retryable cleanup path below and never loses failed paths.
            let _ = remove_slot(&mut state.completed, &mut remove);
        }
        if state
            .retired
            .as_ref()
            .is_some_and(|artifact| artifact.request_id == id)
        {
            let _ = remove_slot(&mut state.retired, &mut remove);
        }
    }

    /// Evaluate deterministic bounded-preview admission without creating a
    /// session or output artifact. Runtime generation still revalidates the
    /// source, session and pin state.
    pub async fn eligibility(
        &self,
        resolver: &BinaryResolver,
        request: PreviewRequest,
    ) -> Result<PreviewEligibility, GoopError> {
        validate_request_identity(&request)?;
        let key = eligibility_key(resolver, &request)?;
        let registration = {
            let mut state = self.state.lock().unwrap();
            register_eligibility(&mut state, key, request.request_id.clone())
        };
        if registration.owner {
            let result = self
                .eligibility_inner(resolver, &request, &registration.work_cancel)
                .await;
            registration.shared.publish(&result);
            finish_eligibility(&mut self.state.lock().unwrap(), registration.flight_epoch);
            if registration.waiter_cancel.is_cancelled() {
                Err(GoopError::Cancelled)
            } else {
                result
            }
        } else {
            let result = registration.shared.wait(&registration.waiter_cancel).await;
            detach_eligibility_waiter(
                &mut self.state.lock().unwrap(),
                registration.flight_epoch,
                registration.waiter_id,
            );
            result
        }
    }

    async fn eligibility_inner(
        &self,
        resolver: &BinaryResolver,
        request: &PreviewRequest,
        cancel: &CancellationToken,
    ) -> Result<PreviewEligibility, GoopError> {
        let deadline = Instant::now() + TIMEOUT;
        checkpoint(cancel, deadline)?;
        if let Err(error) = validate_request_admission(request) {
            return Ok(deterministic_unavailable(error));
        }
        let input = match preview_input_path(&request.input_path, cancel, deadline).await? {
            PreviewInputPath::File(path) => path,
            PreviewInputPath::NotFile => {
                return Ok(PreviewEligibility {
                    available: false,
                    reason: Some("Sample preview requires a file".into()),
                })
            }
            PreviewInputPath::Missing => {
                return Ok(PreviewEligibility {
                    available: false,
                    reason: Some("Sample preview requires an existing file".into()),
                })
            }
        };
        let extension = input
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let family = match preview_source_family(request, &extension) {
            Ok(family) => family,
            Err(error) => return Ok(deterministic_unavailable(error)),
        };
        let permit = tokio::select! {
            permit=self.gate.clone().acquire_owned()=>permit.map_err(|_|invalid("Preview service closed"))?,
            _=cancel.cancelled()=>return Err(GoopError::Cancelled),
            _=tokio::time::sleep_until(tokio::time::Instant::from_std(deadline))=>return Err(invalid("Sample preview inspection timed out")),
        };
        checkpoint(cancel, deadline)?;
        let facts = self
            .inspect_source_facts(resolver, &input, family, cancel, deadline)
            .await?;
        drop(permit);
        match validate_source_facts(request, &facts) {
            Ok(()) => Ok(PreviewEligibility {
                available: true,
                reason: None,
            }),
            Err(error) => Ok(deterministic_unavailable(error)),
        }
    }

    async fn inspect_source_facts(
        &self,
        resolver: &BinaryResolver,
        input: &Path,
        family: PreviewSourceFamily,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<PreviewSourceFacts, GoopError> {
        match family {
            PreviewSourceFamily::Raster => {
                let input = input.to_path_buf();
                let cancel = cancel.clone();
                tokio::task::spawn_blocking(move || {
                    inspect_raster_source(&input, &cancel, deadline)
                })
                .await
                .map_err(|error| {
                    GoopError::InvalidRequest(format!("Preview inspection task failed: {error}"))
                })?
            }
            PreviewSourceFamily::Heic => {
                #[cfg(feature = "heic-thumbnail-preview")]
                {
                    let input = input.to_path_buf();
                    let cancel = cancel.clone();
                    let input_for_capture = input.clone();
                    let cancel_for_capture = cancel.clone();
                    let captured = tokio::task::spawn_blocking(move || {
                        capture_heic_admission(&input_for_capture, &cancel_for_capture, deadline)
                    })
                    .await
                    .map_err(|error| {
                        GoopError::InvalidRequest(format!(
                            "Preview inspection task failed: {error}"
                        ))
                    })??;
                    let Some((bytes, digest)) = captured else {
                        return Ok(PreviewSourceFacts::Unavailable(
                            "Image preview source exceeds the 64 MiB input limit".into(),
                        ));
                    };
                    let cached = {
                        let cache = self.heic_admission_cache.lock().unwrap();
                        cache
                            .as_ref()
                            .filter(|cached| cached.path == input && cached.source_digest == digest)
                            .cloned()
                    };
                    if let Some(cached) = cached {
                        let input_for_verify = input.clone();
                        let cancel_for_verify = cancel.clone();
                        tokio::task::spawn_blocking(move || {
                            verify_snapshot_unchanged(
                                &input_for_verify,
                                &bytes,
                                &cancel_for_verify,
                                deadline,
                                true,
                            )
                        })
                        .await
                        .map_err(|error| {
                            GoopError::InvalidRequest(format!(
                                "Preview inspection task failed: {error}"
                            ))
                        })??;
                        return Ok(PreviewSourceFacts::Heic {
                            unavailable_reason: cached.unavailable_reason,
                        });
                    }
                    let input_for_worker = input.clone();
                    let cancel_for_worker = cancel.clone();
                    let inspector = Arc::clone(&self.heic_admission_inspector);
                    let unavailable_reason = tokio::task::spawn_blocking(move || {
                        inspect_heic_admission(
                            &input_for_worker,
                            bytes,
                            &cancel_for_worker,
                            deadline,
                            inspector.as_ref(),
                        )
                    })
                    .await
                    .map_err(|error| {
                        GoopError::InvalidRequest(format!(
                            "Preview inspection task failed: {error}"
                        ))
                    })??;
                    *self.heic_admission_cache.lock().unwrap() = Some(HeicAdmissionCacheEntry {
                        path: input.to_path_buf(),
                        source_digest: digest,
                        unavailable_reason: unavailable_reason.clone(),
                    });
                    Ok(PreviewSourceFacts::Heic { unavailable_reason })
                }
                #[cfg(not(feature = "heic-thumbnail-preview"))]
                unreachable!("feature-disabled HEIC is rejected before inspection")
            }
            PreviewSourceFamily::Video => {
                inspect_video_source(resolver, input, cancel, deadline).await
            }
        }
    }

    pub fn begin_session(&self) -> Result<String, GoopError> {
        self.begin_session_with(new_preview_session_id, |path| std::fs::remove_dir_all(path))
    }

    fn begin_session_with(
        &self,
        mut next_id: impl FnMut() -> String,
        mut remove: impl FnMut(&Path) -> std::io::Result<()>,
    ) -> Result<String, GoopError> {
        let mut state = self.state.lock().unwrap();
        retry_pending_cleanup(&mut state, None, &mut remove)?;
        let session_id = loop {
            let candidate = next_id();
            debug_assert!(is_canonical_preview_session_id(&candidate));
            if state.session_id.as_deref() != Some(candidate.as_str()) {
                break candidate;
            }
        };
        let replaced_session = state.session_id.take();
        let artifacts = invalidate_generation(&mut state);
        #[cfg(feature = "heic-thumbnail-preview")]
        {
            *self.heic_cache.lock().unwrap() = None;
        }
        if !artifacts.is_empty() {
            state.pending_cleanup = Some(PendingSessionCleanup {
                session_id: replaced_session,
                artifacts,
            });
            retry_pending_cleanup(&mut state, None, &mut remove)?;
        }
        state.session_id = Some(session_id.clone());
        Ok(session_id)
    }

    pub fn release_session(&self, session_id: &str) -> Result<(), GoopError> {
        self.release_session_with(session_id, |path| std::fs::remove_dir_all(path))
    }

    fn release_session_with(
        &self,
        session_id: &str,
        mut remove: impl FnMut(&Path) -> std::io::Result<()>,
    ) -> Result<(), GoopError> {
        if !is_canonical_preview_session_id(session_id) {
            return Err(invalid("Invalid preview session identity"));
        }
        let mut state = self.state.lock().unwrap();
        if state
            .pending_cleanup
            .as_ref()
            .is_some_and(|pending| pending.session_id.as_deref() == Some(session_id))
        {
            return retry_pending_cleanup(&mut state, Some(session_id), &mut remove);
        }
        if state.session_id.as_deref() == Some(session_id) {
            state.session_id = None;
            let artifacts = invalidate_generation(&mut state);
            #[cfg(feature = "heic-thumbnail-preview")]
            {
                *self.heic_cache.lock().unwrap() = None;
            }
            if !artifacts.is_empty() {
                state.pending_cleanup = Some(PendingSessionCleanup {
                    session_id: Some(session_id.to_owned()),
                    artifacts,
                });
                return retry_pending_cleanup(&mut state, Some(session_id), &mut remove);
            }
        }
        Ok(())
    }

    pub async fn generate(
        &self,
        resolver: &BinaryResolver,
        request: PreviewRequest,
    ) -> Result<PreviewResult, GoopError> {
        validate_request_identity(&request)?;
        validate_request_admission(&request)?;
        let requested_session = request.preview_session_id.as_deref();
        if requested_session.is_some_and(|id| !is_canonical_preview_session_id(id)) {
            return Err(invalid("Invalid preview session identity"));
        }
        let requested_epoch = {
            let state = self.state.lock().unwrap();
            let session_matches = match requested_session {
                Some(session_id) => state.session_id.as_deref() == Some(session_id),
                None => state.session_id.is_none(),
            };
            if !session_matches {
                return Err(GoopError::PreviewUnavailable(
                    "Preview session is no longer active.".into(),
                ));
            }
            state.epoch
        };
        let input = std::fs::canonicalize(goop_core::path::expand(&request.input_path))?;
        if !input.is_file() {
            return Err(invalid("Sample preview requires a file"));
        }
        let ext = input
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let family = preview_source_family(&request, &ext)?;
        let is_heic = matches!(ext.as_str(), "heic" | "heif");
        if is_heic {
            #[cfg(feature = "heic-thumbnail-preview")]
            {
                if requested_session.is_none() {
                    return Err(GoopError::PreviewUnavailable(
                        "Bounded HEIC preview requires a live preview session.".into(),
                    ));
                }
                if request
                    .pinned_jpeg_quality
                    .is_some_and(|quality| !(1..=100).contains(&quality))
                {
                    return Err(invalid("Pinned JPEG quality must be between 1 and 100"));
                }
            }
        }
        let is_image = matches!(
            family,
            PreviewSourceFamily::Raster | PreviewSourceFamily::Heic
        );
        let cancel = CancellationToken::new();
        let cached_heic = {
            let mut state = self.state.lock().unwrap();
            register_request(
                &mut state,
                request.request_id.clone(),
                requested_session,
                requested_epoch,
                cancel.clone(),
            )?;
            #[cfg(feature = "heic-thumbnail-preview")]
            {
                if is_heic {
                    self.heic_cache.lock().unwrap().clone()
                } else {
                    *self.heic_cache.lock().unwrap() = None;
                    None
                }
            }
            #[cfg(not(feature = "heic-thumbnail-preview"))]
            {
                None::<HeicCacheEntry>
            }
        };
        let deadline = Instant::now() + TIMEOUT;
        let permit = tokio::select! {
            permit=self.gate.clone().acquire_owned()=>permit.map_err(|_|invalid("Preview service closed"))?,
            _=cancel.cancelled()=>return Err(GoopError::Cancelled),
            _=tokio::time::sleep_until(tokio::time::Instant::from_std(deadline))=>return Err(invalid("Sample preview timed out")),
        };
        checkpoint(&cancel, deadline)?;
        let artifact_id = JobId::new().0.to_string();
        let directory = self.root.join(&artifact_id);
        let staging_directory = self.root.join(format!(".staging-{artifact_id}"));
        let mut scratch = Some(Scratch(Some(staging_directory.clone())));
        let original_video_metadata = if is_image {
            None
        } else {
            Some(std::fs::metadata(&input)?)
        };
        let result = if is_image {
            let req = request.clone();
            let path = input.clone();
            let dir = staging_directory.clone();
            let token = cancel.clone();
            let image_scratch = scratch.take().expect("preview scratch is armed");
            let worker_context = ImageWorkerContext {
                root: self.root.clone(),
                cached_heic,
                #[cfg(feature = "heic-thumbnail-preview")]
                heic_sampler: Arc::clone(&self.heic_sampler),
            };
            let mut worker = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                image_worker(
                    &path,
                    &dir,
                    &req,
                    &token,
                    deadline,
                    worker_context,
                    image_scratch,
                )
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
            video_sample(
                resolver,
                &input,
                &self.root,
                &staging_directory,
                &request,
                &cancel,
                deadline,
            )
            .await
            .map(|result| ImageWorkerOutput {
                result,
                #[cfg(feature = "heic-thumbnail-preview")]
                heic_cache: None,
            })
        };
        let worker_output = result?;
        let mut result = worker_output.result;
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
        if !publication_is_current(
            &state,
            &request.request_id,
            requested_session,
            requested_epoch,
        ) {
            return Err(GoopError::Cancelled);
        }
        let published = PublishedArtifacts {
            request_id: request.request_id.clone(),
            path: directory.clone(),
        };
        let mut remove = |path: &Path| std::fs::remove_dir_all(path);
        if requested_session.is_some() {
            remove_slot(&mut state.retired, &mut remove)?;
        } else {
            remove_slot(&mut state.retired, &mut remove)?;
            remove_slot(&mut state.completed, &mut remove)?;
        }
        relocate_result_paths(&mut result, &staging_directory, &directory)?;
        std::fs::rename(&staging_directory, &directory)?;
        #[cfg(feature = "heic-thumbnail-preview")]
        if let Some(cache) = worker_output.heic_cache {
            *self.heic_cache.lock().unwrap() = Some(cache);
        }
        if requested_session.is_some() {
            state.retired = state.completed.take();
            state.completed = Some(published);
        } else {
            state.completed = Some(published);
        }
        state.active = None;
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
        image_details: None,
    }
}

fn relocate_result_paths(
    result: &mut PreviewResult,
    staging_directory: &Path,
    published_directory: &Path,
) -> Result<(), GoopError> {
    let relocate = |path: &str| {
        let relative = Path::new(path)
            .strip_prefix(staging_directory)
            .map_err(|_| invalid("Preview artifact escaped its staging directory"))?;
        Ok::<_, GoopError>(
            published_directory
                .join(relative)
                .to_string_lossy()
                .into_owned(),
        )
    };
    if let Some(before) = result.before_path.as_mut() {
        *before = relocate(before)?;
    }
    result.after_path = relocate(&result.after_path)?;
    if let Some(details) = result.image_details.as_mut() {
        if let Some(pinned) = details.pinned_path.as_mut() {
            *pinned = relocate(pinned)?;
        }
    }
    Ok(())
}

fn image_worker(
    input: &Path,
    directory: &Path,
    request: &PreviewRequest,
    cancel: &CancellationToken,
    deadline: Instant,
    worker_context: ImageWorkerContext,
    scratch: Scratch,
) -> (Result<ImageWorkerOutput, GoopError>, Scratch) {
    let result = image_sample(input, directory, request, cancel, deadline, worker_context);
    (result, scratch)
}

struct ImageWorkerOutput {
    result: PreviewResult,
    #[cfg(feature = "heic-thumbnail-preview")]
    heic_cache: Option<HeicCacheEntry>,
}

fn image_sample(
    input: &Path,
    dir: &Path,
    request: &PreviewRequest,
    cancel: &CancellationToken,
    deadline: Instant,
    worker_context: ImageWorkerContext,
) -> Result<ImageWorkerOutput, GoopError> {
    let bytes = capture_image(input, MAX_INPUT_BYTES, cancel, deadline)?;
    #[cfg(feature = "heic-thumbnail-preview")]
    if input
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("heic") || extension.eq_ignore_ascii_case("heif")
        })
    {
        let (result, heic_cache) = heic_image_sample_bytes_with_prepare(
            bytes.clone(),
            (dir, || {
                prepare_preview_output(&worker_context.root, dir, cancel, deadline)
            }),
            request,
            cancel,
            deadline,
            worker_context.cached_heic,
            worker_context.heic_sampler.as_ref(),
        )?;
        verify_snapshot_unchanged(input, &bytes, cancel, deadline, true)?;
        return Ok(ImageWorkerOutput { result, heic_cache });
    }
    #[cfg(not(feature = "heic-thumbnail-preview"))]
    let _ = worker_context.cached_heic;
    let result = image_sample_bytes_with_prepare(
        bytes.clone(),
        (dir, || {
            prepare_preview_output(&worker_context.root, dir, cancel, deadline)
        }),
        request,
        cancel,
        deadline,
    )?;
    verify_snapshot_unchanged(input, &bytes, cancel, deadline, false)?;
    Ok(ImageWorkerOutput {
        result,
        #[cfg(feature = "heic-thumbnail-preview")]
        heic_cache: None,
    })
}

fn verify_snapshot_unchanged(
    input: &Path,
    snapshot: &[u8],
    cancel: &CancellationToken,
    deadline: Instant,
    preview_unavailable: bool,
) -> Result<(), GoopError> {
    let changed = || {
        if preview_unavailable {
            GoopError::PreviewUnavailable("Source changed while generating preview.".into())
        } else {
            invalid("Source changed while generating preview")
        }
    };
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

fn inspect_raster_source(
    input: &Path,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<PreviewSourceFacts, GoopError> {
    checkpoint(cancel, deadline)?;
    let metadata = std::fs::metadata(input)?;
    if metadata.len() > MAX_INPUT_BYTES {
        return Ok(PreviewSourceFacts::Unavailable(
            "Image preview source exceeds the 64 MiB input limit".into(),
        ));
    }
    let bytes = capture_image(input, MAX_INPUT_BYTES, cancel, deadline)?;
    let facts = raster_facts_from_bytes(bytes.clone())?;
    verify_snapshot_unchanged(input, &bytes, cancel, deadline, false)?;
    Ok(facts)
}

fn raster_facts_from_bytes(bytes: Bytes) -> Result<PreviewSourceFacts, GoopError> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let format = reader
        .format()
        .ok_or_else(|| invalid("Could not identify the image format during preview inspection"))?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let decoder = reader
        .into_decoder()
        .map_err(|error| invalid(format!("Could not inspect image preview: {error}")))?;
    let (width, height) = decoder.dimensions();
    let facts = PreviewSourceFacts::Raster {
        format,
        width,
        height,
        decoded_bytes: decoder.total_bytes(),
        has_alpha: decoder.color_type().has_alpha(),
    };
    Ok(facts)
}

#[cfg(feature = "heic-thumbnail-preview")]
fn capture_heic_admission(
    input: &Path,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<Option<(Bytes, [u8; 32])>, GoopError> {
    checkpoint(cancel, deadline)?;
    let metadata = std::fs::metadata(input)?;
    if !metadata.is_file() {
        return Err(invalid("Sample preview requires a file"));
    }
    if metadata.len() > MAX_INPUT_BYTES {
        return Ok(None);
    }
    let bytes = capture_image(input, MAX_INPUT_BYTES, cancel, deadline)?;
    let digest = Sha256::digest(bytes.as_ref()).into();
    Ok(Some((bytes, digest)))
}

#[cfg(feature = "heic-thumbnail-preview")]
fn inspect_heic_admission(
    input: &Path,
    bytes: Bytes,
    cancel: &CancellationToken,
    deadline: Instant,
    inspector: &HeicAdmissionInspector,
) -> Result<Option<String>, GoopError> {
    let result = inspector(bytes.as_ref(), cancel, deadline);
    checkpoint(cancel, deadline)?;
    let unavailable_reason = match result {
        Ok(()) => None,
        Err(SamplerError::NoAdmittedThumbnail) => {
            Some("This source has no bounded embedded thumbnail.".into())
        }
        Err(
            error @ (SamplerError::InvalidPrimaryDimensions { .. }
            | SamplerError::TooManyThumbnails { .. }
            | SamplerError::ContainerWorkLimitExceeded),
        ) => Some(format!("HEIC preview unavailable: {error}.")),
        Err(SamplerError::Interrupted { .. }) => {
            checkpoint(cancel, deadline)?;
            return Err(invalid("HEIC preview inspection was interrupted"));
        }
        Err(error) => {
            return Err(invalid(format!(
                "Could not inspect the bounded HEIC thumbnail: {error}"
            )))
        }
    };
    verify_snapshot_unchanged(input, &bytes, cancel, deadline, true)?;
    Ok(unavailable_reason)
}

async fn inspect_video_source(
    resolver: &BinaryResolver,
    input: &Path,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<PreviewSourceFacts, GoopError> {
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
    Ok(PreviewSourceFacts::Video {
        has_video: source.has_video,
        duration_ms: source.duration_ms,
        width: source.width,
        height: source.height,
    })
}

#[cfg(feature = "heic-thumbnail-preview")]
fn map_heic_sample_dimensions(
    primary: Dimensions,
    sample: Dimensions,
    planned: (u32, u32),
) -> Result<(u32, u32), GoopError> {
    let scale = |sample_axis: u32, planned_axis: u32, primary_axis: u32| {
        (u64::from(sample_axis) * u64::from(planned_axis) + u64::from(primary_axis) / 2)
            / u64::from(primary_axis)
    };
    let width = u32::try_from(scale(sample.width, planned.0, primary.width))
        .map_err(|_| invalid("HEIC sample width overflowed"))?
        .clamp(1, sample.width);
    let height = u32::try_from(scale(sample.height, planned.1, primary.height))
        .map_err(|_| invalid("HEIC sample height overflowed"))?
        .clamp(1, sample.height);
    Ok(bounded_dimensions(width, height, EDGE))
}

#[cfg(feature = "heic-thumbnail-preview")]
fn map_sampler_error(
    error: SamplerError,
    cancel: &CancellationToken,
    deadline: Instant,
) -> GoopError {
    if cancel.is_cancelled() {
        GoopError::Cancelled
    } else if Instant::now() >= deadline {
        invalid("Sample preview timed out")
    } else {
        GoopError::PreviewUnavailable(format!("HEIC preview unavailable: {error}."))
    }
}

#[cfg(feature = "heic-thumbnail-preview")]
fn normalize_heic_frame(
    mut frame: SampleFrame,
    cancel: &CancellationToken,
) -> Result<SampleFrame, GoopError> {
    let Some(profile) = frame.raw_icc_profile.take() else {
        return Ok(frame);
    };
    let pixels = image::RgbImage::from_raw(
        frame.admitted_dimensions.width,
        frame.admitted_dimensions.height,
        frame.rgb.as_ref().to_vec(),
    )
    .ok_or_else(|| {
        GoopError::PreviewUnavailable(
            "HEIC preview unavailable: decoded sample dimensions did not match its buffer.".into(),
        )
    })?;
    let _working_set = crate::color::acquire_working_set(cancel)?;
    let transformed = crate::color::transform_pixels(
        DynamicImage::ImageRgb8(pixels),
        Some(profile.as_ref().to_vec()),
        ImageColorPolicy::ConvertToSrgb,
        cancel,
    )
    .map_err(|error| match error {
        GoopError::Cancelled => GoopError::Cancelled,
        error => GoopError::PreviewUnavailable(format!(
            "HEIC preview unavailable: color normalization failed: {}.",
            error.user_message()
        )),
    })?;
    frame.rgb = transformed.pixels.into_raw().into();
    Ok(frame)
}

#[cfg(feature = "heic-thumbnail-preview")]
fn encode_heic_png(pixels: &image::RgbImage) -> Result<Vec<u8>, GoopError> {
    let mut encoded = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(pixels.clone())
        .write_to(&mut encoded, ImageFormat::Png)
        .map_err(|error| invalid(format!("Could not encode HEIC preview PNG: {error}")))?;
    Ok(encoded.into_inner())
}

#[cfg(feature = "heic-thumbnail-preview")]
fn encode_heic_jpeg_round_trip(
    pixels: &image::RgbImage,
    quality: u8,
    cancel: &CancellationToken,
) -> Result<(Vec<u8>, Vec<u8>), GoopError> {
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality)
        .encode_image(pixels)
        .map_err(|error| invalid(format!("Could not encode HEIC preview JPEG: {error}")))?;
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    let decoded = image::load_from_memory_with_format(&jpeg, ImageFormat::Jpeg)
        .map_err(|error| invalid(format!("Could not decode HEIC preview JPEG: {error}")))?
        .to_rgb8();
    if decoded.dimensions() != pixels.dimensions() {
        return Err(GoopError::PreviewUnavailable(
            "HEIC preview unavailable: JPEG round-trip dimensions changed.".into(),
        ));
    }
    Ok((jpeg, encode_heic_png(&decoded)?))
}

#[cfg(all(test, feature = "heic-thumbnail-preview"))]
fn heic_image_sample_bytes(
    bytes: Bytes,
    dir: &Path,
    request: &PreviewRequest,
    cancel: &CancellationToken,
    deadline: Instant,
    cached: Option<HeicCacheEntry>,
    sampler: &HeicSampler,
) -> Result<(PreviewResult, Option<HeicCacheEntry>), GoopError> {
    heic_image_sample_bytes_with_prepare(
        bytes,
        (dir, || Ok(())),
        request,
        cancel,
        deadline,
        cached,
        sampler,
    )
}

#[cfg(feature = "heic-thumbnail-preview")]
fn heic_image_sample_bytes_with_prepare(
    bytes: Bytes,
    output: (&Path, impl FnOnce() -> Result<(), GoopError>),
    request: &PreviewRequest,
    cancel: &CancellationToken,
    deadline: Instant,
    cached: Option<HeicCacheEntry>,
    sampler: &HeicSampler,
) -> Result<(PreviewResult, Option<HeicCacheEntry>), GoopError> {
    let (dir, prepare_output) = output;
    checkpoint(cancel, deadline)?;
    let session_id = request.preview_session_id.as_ref().ok_or_else(|| {
        GoopError::PreviewUnavailable(
            "Bounded HEIC preview requires a live preview session.".into(),
        )
    })?;
    let options = request.image_options.as_ref().ok_or_else(|| {
        invalid("Bounded HEIC preview requires explicit JPEG conversion settings")
    })?;
    if bytes.len() < 12 || bytes.get(4..8) != Some(b"ftyp") {
        return Err(GoopError::PreviewUnavailable(
            "HEIC preview unavailable: captured input has no HEIF file-type box.".into(),
        ));
    }
    let source_digest: [u8; 32] = Sha256::digest(bytes.as_ref()).into();
    let (frame, cache_update) = if let Some(entry) = cached
        .filter(|entry| entry.session_id == *session_id && entry.source_digest == source_digest)
    {
        (Arc::clone(&entry.frame), Some(entry))
    } else {
        let frame = sampler(bytes.as_ref(), cancel, deadline)
            .map_err(|error| map_sampler_error(error, cancel, deadline))?;
        let frame = Arc::new(normalize_heic_frame(frame, cancel)?);
        let cache = HeicCacheEntry {
            session_id: session_id.clone(),
            source_digest,
            frame: Arc::clone(&frame),
        };
        (frame, Some(cache))
    };
    checkpoint(cancel, deadline)?;

    let primary = (
        frame.primary_dimensions.width,
        frame.primary_dimensions.height,
    );
    let planned = crate::image_options::output_dimensions(primary, &options.resize)?;
    let comparison =
        map_heic_sample_dimensions(frame.primary_dimensions, frame.admitted_dimensions, planned)?;
    let source = image::RgbImage::from_raw(
        frame.admitted_dimensions.width,
        frame.admitted_dimensions.height,
        frame.rgb.as_ref().to_vec(),
    )
    .ok_or_else(|| {
        GoopError::PreviewUnavailable(
            "HEIC preview unavailable: decoded sample dimensions did not match its buffer.".into(),
        )
    })?;
    let sample = if source.dimensions() == comparison {
        source
    } else {
        image::imageops::resize(
            &source,
            comparison.0,
            comparison.1,
            image::imageops::FilterType::Lanczos3,
        )
    };
    checkpoint(cancel, deadline)?;

    let source_bytes = encode_heic_png(&sample)?;
    let (current_jpeg, current_bytes) =
        encode_heic_jpeg_round_trip(&sample, options.jpeg_quality, cancel)?;
    let pinned_round_trip = request
        .pinned_jpeg_quality
        .map(|quality| encode_heic_jpeg_round_trip(&sample, quality, cancel))
        .transpose()?;
    let mut aggregate = source_bytes
        .len()
        .checked_add(current_jpeg.len())
        .and_then(|total| total.checked_add(current_bytes.len()))
        .ok_or_else(|| invalid("Sample artifact size overflowed"))?;
    if let Some((jpeg, png)) = pinned_round_trip.as_ref() {
        aggregate = aggregate
            .checked_add(jpeg.len())
            .and_then(|total| total.checked_add(png.len()))
            .ok_or_else(|| invalid("Sample artifact size overflowed"))?;
    }
    if aggregate as u64 > BYTES {
        return Err(GoopError::PreviewUnavailable(
            "HEIC preview unavailable: sample artifacts exceed 16 MiB.".into(),
        ));
    }

    prepare_output()?;
    let source_path = dir.join("before.png");
    let current_jpeg_path = dir.join("after.tmp.jpg");
    let current_path = dir.join("after.png");
    std::fs::write(&source_path, &source_bytes)?;
    std::fs::write(&current_jpeg_path, &current_jpeg)?;
    std::fs::write(&current_path, &current_bytes)?;
    std::fs::remove_file(&current_jpeg_path)?;
    let pinned_path = if let Some((jpeg, png)) = pinned_round_trip {
        let jpeg_path = dir.join("pinned.tmp.jpg");
        let path = dir.join("pinned.png");
        std::fs::write(&jpeg_path, jpeg)?;
        std::fs::write(&path, png)?;
        std::fs::remove_file(jpeg_path)?;
        Some(path)
    } else {
        None
    };
    for encoded in [&source_bytes, &current_bytes] {
        let decoded = image::load_from_memory(encoded).map_err(|error| {
            GoopError::PreviewUnavailable(format!(
                "HEIC preview unavailable: generated artifact could not be verified: {error}."
            ))
        })?;
        if decoded.width() != comparison.0 || decoded.height() != comparison.1 {
            return Err(GoopError::PreviewUnavailable(
                "HEIC preview unavailable: generated artifact dimensions changed.".into(),
            ));
        }
    }
    checkpoint(cancel, deadline)?;

    let mut result = response(
        request,
        PreviewKind::Image,
        Some(source_path),
        current_path,
        comparison,
        current_jpeg.len() as u64,
        None,
    );
    result.image_details = Some(ImagePreviewDetails {
        sample_kind: ImageSampleKind::EmbeddedHeicThumbnail,
        admitted_sample_width: frame.admitted_dimensions.width,
        admitted_sample_height: frame.admitted_dimensions.height,
        comparison_frame_width: comparison.0,
        comparison_frame_height: comparison.1,
        planned_output_width: planned.0,
        planned_output_height: planned.1,
        current_jpeg_quality: options.jpeg_quality,
        pinned_jpeg_quality: request.pinned_jpeg_quality,
        pinned_path: pinned_path.map(|path| path.to_string_lossy().into_owned()),
    });
    Ok((result, cache_update))
}

#[cfg(test)]
fn image_sample_bytes(
    bytes: Bytes,
    dir: &Path,
    request: &PreviewRequest,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<PreviewResult, GoopError> {
    image_sample_bytes_with_prepare(bytes, (dir, || Ok(())), request, cancel, deadline)
}

fn image_sample_bytes_with_prepare(
    bytes: Bytes,
    output: (&Path, impl FnOnce() -> Result<(), GoopError>),
    request: &PreviewRequest,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<PreviewResult, GoopError> {
    let (dir, prepare_output) = output;
    checkpoint(cancel, deadline)?;
    let facts = raster_facts_from_bytes(bytes.clone())?;
    validate_source_facts(request, &facts)?;
    prepare_output()?;
    if request.image_color_policy.unwrap_or_default() != ImageColorPolicy::Preserve
        || request.image_alpha_policy.is_some()
    {
        return color_managed_image_sample(bytes, dir, request, cancel, deadline);
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| invalid(e.to_string()))?;
    let (width, height) = decoder.dimensions();
    if let Some(options) = &request.image_options {
        crate::image_options::output_dimensions((width, height), &options.resize)?;
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
    root: &Path,
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
    validate_source_facts(
        request,
        &PreviewSourceFacts::Video {
            has_video: source.has_video,
            duration_ms: source.duration_ms,
            width: source.width,
            height: source.height,
        },
    )?;
    prepare_preview_output(root, dir, cancel, deadline)?;
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
    use std::io;

    #[cfg(feature = "heic-thumbnail-preview")]
    struct BlockingHeicSampler {
        entered: tokio::sync::Notify,
        resumed: std::sync::Mutex<bool>,
        resume: std::sync::Condvar,
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    struct BlockingHeicInspector {
        entered: tokio::sync::Notify,
        calls: std::sync::atomic::AtomicUsize,
        resumed: std::sync::Mutex<bool>,
        resume: std::sync::Condvar,
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    impl BlockingHeicInspector {
        fn inspect(&self) -> Result<(), SamplerError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.entered.notify_one();
            let mut resumed = self.resumed.lock().unwrap();
            while !*resumed {
                resumed = self.resume.wait(resumed).unwrap();
            }
            Ok(())
        }

        fn unblock(&self) {
            *self.resumed.lock().unwrap() = true;
            self.resume.notify_all();
        }
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    struct UnblockInspectorOnDrop(Arc<BlockingHeicInspector>);

    #[cfg(feature = "heic-thumbnail-preview")]
    impl Drop for UnblockInspectorOnDrop {
        fn drop(&mut self) {
            self.0.unblock();
        }
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    impl BlockingHeicSampler {
        fn sample(&self) -> Result<SampleFrame, SamplerError> {
            self.entered.notify_one();
            let mut resumed = self.resumed.lock().unwrap();
            while !*resumed {
                resumed = self.resume.wait(resumed).unwrap();
            }
            Ok(SampleFrame {
                rgb: vec![96; 32 * 24 * 3].into(),
                raw_icc_profile: None,
                primary_dimensions: Dimensions {
                    width: 4_000,
                    height: 3_000,
                },
                admitted_dimensions: Dimensions {
                    width: 32,
                    height: 24,
                },
                provenance: crate::heic_preview_sampler::SampleProvenance::EmbeddedHeicThumbnail {
                    item_id: 1,
                },
            })
        }

        fn unblock(&self) {
            *self.resumed.lock().unwrap() = true;
            self.resume.notify_all();
        }
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    struct UnblockSamplerOnDrop(Arc<BlockingHeicSampler>);

    #[cfg(feature = "heic-thumbnail-preview")]
    impl Drop for UnblockSamplerOnDrop {
        fn drop(&mut self) {
            self.0.unblock();
        }
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    fn service_with_blocking_heic_sampler(
        root: PathBuf,
    ) -> (Arc<PreviewService>, Arc<BlockingHeicSampler>) {
        let blocker = Arc::new(BlockingHeicSampler {
            entered: tokio::sync::Notify::new(),
            resumed: std::sync::Mutex::new(false),
            resume: std::sync::Condvar::new(),
        });
        let sampler: Arc<HeicSampler> = {
            let blocker = Arc::clone(&blocker);
            Arc::new(move |_bytes, _cancel, _deadline| blocker.sample())
        };
        (
            Arc::new(PreviewService::new_with_heic_sampler(root, sampler)),
            blocker,
        )
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    fn assert_no_published_preview_directories(service: &PreviewService) {
        if !service.root.exists() {
            return;
        }
        assert!(std::fs::read_dir(&service.root).unwrap().all(|entry| !entry
            .unwrap()
            .file_type()
            .unwrap()
            .is_dir()));
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    fn heic_cache_entry(session_id: &str) -> HeicCacheEntry {
        HeicCacheEntry {
            session_id: session_id.into(),
            source_digest: [7; 32],
            frame: Arc::new(SampleFrame {
                rgb: vec![1, 2, 3].into(),
                raw_icc_profile: None,
                primary_dimensions: Dimensions {
                    width: 1,
                    height: 1,
                },
                admitted_dimensions: Dimensions {
                    width: 1,
                    height: 1,
                },
                provenance: crate::heic_preview_sampler::SampleProvenance::EmbeddedHeicThumbnail {
                    item_id: 1,
                },
            }),
        }
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[tokio::test]
    async fn release_during_heic_decode_cannot_publish_cache_or_artifacts() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.heic");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/heic-with-thumbnail.heic"
            ),
            &input,
        )
        .unwrap();
        let (service, blocker) = service_with_blocking_heic_sampler(tmp.path().join("previews"));
        let session = service.begin_session().unwrap();
        let mut request = explicit_request(&input);
        request.preview_session_id = Some(session.clone());
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));
        let worker_service = Arc::clone(&service);
        let worker = tokio::spawn(async move { worker_service.generate(&resolver, request).await });
        let _unblock_on_drop = UnblockSamplerOnDrop(Arc::clone(&blocker));

        tokio::time::timeout(Duration::from_secs(2), blocker.entered.notified())
            .await
            .expect("test sampler did not reach decode");
        let release = service.release_session(&session);
        let repeated_release = service.release_session(&session);
        blocker.unblock();
        release.unwrap();
        repeated_release.unwrap();

        assert!(matches!(worker.await.unwrap(), Err(GoopError::Cancelled)));
        assert!(service.heic_cache.lock().unwrap().is_none());
        assert_no_published_preview_directories(&service);
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[tokio::test]
    async fn new_session_during_heic_decode_cannot_publish_into_the_replacement() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.heic");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/heic-with-thumbnail.heic"
            ),
            &input,
        )
        .unwrap();
        let (service, blocker) = service_with_blocking_heic_sampler(tmp.path().join("previews"));
        let old_session = service.begin_session().unwrap();
        let mut request = explicit_request(&input);
        request.preview_session_id = Some(old_session.clone());
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));
        let worker_service = Arc::clone(&service);
        let worker = tokio::spawn(async move { worker_service.generate(&resolver, request).await });
        let _unblock_on_drop = UnblockSamplerOnDrop(Arc::clone(&blocker));

        tokio::time::timeout(Duration::from_secs(2), blocker.entered.notified())
            .await
            .expect("test sampler did not reach decode");
        let replacement = service.begin_session();
        blocker.unblock();
        let replacement = replacement.unwrap();

        assert!(matches!(worker.await.unwrap(), Err(GoopError::Cancelled)));
        service.release_session(&old_session).unwrap();
        assert_eq!(
            service.state.lock().unwrap().session_id.as_deref(),
            Some(replacement.as_str())
        );
        assert!(service.heic_cache.lock().unwrap().is_none());
        assert_no_published_preview_directories(&service);
    }

    #[test]
    fn legacy_request_captured_before_session_cannot_register_after_session_begins() {
        let tmp = tempfile::tempdir().unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let captured_epoch = service.state.lock().unwrap().epoch;

        let session = service.begin_session().unwrap();
        let mut state = service.state.lock().unwrap();
        let error = register_request(
            &mut state,
            "stale-legacy".into(),
            None,
            captured_epoch,
            CancellationToken::new(),
        )
        .unwrap_err();

        assert!(matches!(error, GoopError::PreviewUnavailable(_)));
        assert_eq!(state.session_id.as_deref(), Some(session.as_str()));
        assert!(state.active.is_none());
    }

    #[tokio::test]
    async fn legacy_request_blocked_before_work_cannot_cross_a_new_session_epoch() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.jpg");
        image::RgbImage::from_pixel(16, 8, image::Rgb([40, 80, 120]))
            .save(&input)
            .unwrap();
        let service = Arc::new(PreviewService::new(tmp.path().join("previews")));
        let held_permit = service.gate.clone().acquire_owned().await.unwrap();
        let resolver = BinaryResolver::new(tmp.path().into());
        let worker_service = service.clone();
        let worker = tokio::spawn(async move {
            worker_service
                .generate(&resolver, explicit_request(&input))
                .await
        });

        for _ in 0..100 {
            if service.state.lock().unwrap().active.is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(service.state.lock().unwrap().active.is_some());

        let session = service.begin_session().unwrap();
        let new_artifact = tmp.path().join("new-session-artifact");
        std::fs::create_dir(&new_artifact).unwrap();
        service.state.lock().unwrap().completed = Some(PublishedArtifacts {
            request_id: "new-session".into(),
            path: new_artifact.clone(),
        });
        drop(held_permit);

        assert!(matches!(worker.await.unwrap(), Err(GoopError::Cancelled)));
        let state = service.state.lock().unwrap();
        assert_eq!(state.session_id.as_deref(), Some(session.as_str()));
        assert_eq!(
            state
                .completed
                .as_ref()
                .map(|artifact| artifact.request_id.as_str()),
            Some("new-session")
        );
        assert!(new_artifact.exists());
    }

    #[test]
    fn failed_release_cleanup_is_retained_retried_and_never_releases_a_newer_session() {
        let tmp = tempfile::tempdir().unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let released = service.begin_session().unwrap();
        let artifact = tmp.path().join("locked-artifact");
        std::fs::create_dir(&artifact).unwrap();
        service.state.lock().unwrap().completed = Some(PublishedArtifacts {
            request_id: "old".into(),
            path: artifact.clone(),
        });
        #[cfg(feature = "heic-thumbnail-preview")]
        {
            *service.heic_cache.lock().unwrap() = Some(heic_cache_entry(&released));
        }

        let error = service
            .release_session_with(&released, |_| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "simulated Windows sharing violation",
                ))
            })
            .unwrap_err();
        assert!(matches!(error, GoopError::Io(_)));
        assert!(artifact.exists());
        assert!(service.state.lock().unwrap().session_id.is_none());
        #[cfg(feature = "heic-thumbnail-preview")]
        assert!(service.heic_cache.lock().unwrap().is_none());

        let retry_error = service
            .release_session_with(&released, |_| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "simulated repeated sharing violation",
                ))
            })
            .unwrap_err();
        assert!(matches!(retry_error, GoopError::Io(_)));
        assert!(artifact.exists());

        let begin_error = service
            .begin_session_with(
                || "123e4567-e89b-42d3-a456-426614174000".into(),
                |_| {
                    Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "simulated begin retry sharing violation",
                    ))
                },
            )
            .unwrap_err();
        assert!(matches!(begin_error, GoopError::Io(_)));
        assert!(service.state.lock().unwrap().session_id.is_none());
        assert!(artifact.exists());

        let newer = service
            .begin_session_with(
                || "123e4567-e89b-42d3-a456-426614174000".into(),
                |path| std::fs::remove_dir_all(path),
            )
            .unwrap();
        assert!(!artifact.exists());

        service
            .release_session_with(&released, |_| {
                panic!("a completed old cleanup must not touch the newer session")
            })
            .unwrap();
        assert_eq!(
            service.state.lock().unwrap().session_id.as_deref(),
            Some(newer.as_str())
        );
    }

    #[test]
    fn failed_cancel_cleanup_stays_retryable_by_session_release() {
        let tmp = tempfile::tempdir().unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let session = service.begin_session().unwrap();
        let artifact = tmp.path().join("locked-cancel-artifact");
        std::fs::create_dir(&artifact).unwrap();
        service.state.lock().unwrap().completed = Some(PublishedArtifacts {
            request_id: "cancelled".into(),
            path: artifact.clone(),
        });

        service.cancel_with("cancelled", |_| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "simulated Windows sharing violation",
            ))
        });

        assert!(service.state.lock().unwrap().completed.is_some());
        service.release_session(&session).unwrap();
        assert!(!artifact.exists());
        assert!(service.state.lock().unwrap().pending_cleanup.is_none());
    }

    #[test]
    fn publication_barrier_rejects_a_released_session_epoch() {
        let cancel = CancellationToken::new();
        let mut state = State {
            epoch: 7,
            session_id: Some("123e4567-e89b-42d3-a456-426614174000".into()),
            active: Some(ActiveRequest {
                request_id: "latest".into(),
                epoch: 7,
                cancel,
            }),
            ..State::default()
        };

        assert!(publication_is_current(
            &state,
            "latest",
            Some("123e4567-e89b-42d3-a456-426614174000"),
            7,
        ));

        state.epoch += 1;
        state.session_id = None;

        assert!(!publication_is_current(
            &state,
            "latest",
            Some("123e4567-e89b-42d3-a456-426614174000"),
            7,
        ));
    }

    #[test]
    fn a_colliding_session_token_is_retried_before_old_state_is_invalidated() {
        let tmp = tempfile::tempdir().unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let existing = service.begin_session().unwrap();
        let artifact = tmp.path().join("published");
        std::fs::create_dir(&artifact).unwrap();
        service.state.lock().unwrap().completed = Some(PublishedArtifacts {
            request_id: "old".into(),
            path: artifact.clone(),
        });
        let replacement = "123e4567-e89b-42d3-a456-426614174000".to_string();
        let mut calls = 0;

        let issued = service
            .begin_session_with(
                || {
                    calls += 1;
                    if calls == 1 {
                        existing.clone()
                    } else {
                        assert!(
                            artifact.exists(),
                            "collision must not invalidate the live session"
                        );
                        replacement.clone()
                    }
                },
                |path| std::fs::remove_dir_all(path),
            )
            .unwrap();

        assert_eq!(calls, 2);
        assert_eq!(issued, replacement);
        assert!(!artifact.exists());
    }

    fn explicit_request(input: &Path) -> PreviewRequest {
        serde_json::from_value(serde_json::json!({
            "request_id":"captured", "input_path":input, "source_revision":"1",
            "target":"jpeg", "metadata_policy":"preserve",
            "image_options":{"jpeg_quality":75,"resize":{"kind":"original"}}
        }))
        .unwrap()
    }

    fn automatic_request(input: &Path, target: TargetFormat) -> PreviewRequest {
        PreviewRequest {
            request_id: "eligibility".into(),
            preview_session_id: None,
            input_path: input.to_string_lossy().into_owned(),
            source_revision: "revision-1".into(),
            target,
            quality_preset: None,
            resolution_cap: None,
            compress_mode: None,
            metadata_policy: None,
            image_color_policy: None,
            image_alpha_policy: None,
            subtitle: None,
            gif_options: None,
            image_options: None,
            pinned_jpeg_quality: None,
            video_options: None,
        }
    }

    #[tokio::test]
    async fn eligibility_reports_static_matrix_without_creating_artifacts() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.jpg");
        image::RgbImage::from_pixel(16, 8, image::Rgb([40, 80, 120]))
            .save(&input)
            .unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));

        let available = service
            .eligibility(&resolver, automatic_request(&input, TargetFormat::Jpeg))
            .await
            .unwrap();
        assert!(available.available);

        let cases = [
            (
                Some(CompressMode::TargetSizeBytes(32_000)),
                TargetFormat::Jpeg,
                "target-size compression",
            ),
            (
                Some(CompressMode::LosslessReoptimize),
                TargetFormat::Jpeg,
                "Lossless JPEG",
            ),
            (None, TargetFormat::Avif, "this image target"),
        ];
        for (compress_mode, target, reason) in cases {
            let mut request = automatic_request(&input, target);
            request.compress_mode = compress_mode;
            let eligibility = service
                .eligibility(&resolver, request.clone())
                .await
                .unwrap();
            assert!(!eligibility.available);
            let eligibility_reason = eligibility.reason.unwrap();
            assert!(
                eligibility_reason.contains(reason),
                "expected reason containing {reason}"
            );
            assert_eq!(
                service
                    .generate(&resolver, request)
                    .await
                    .unwrap_err()
                    .user_message(),
                eligibility_reason
            );
        }

        let mut subtitle = automatic_request(&input, TargetFormat::Jpeg);
        subtitle.subtitle = Some(goop_core::SubtitleOptions {
            source_path: "captions.srt".into(),
            mode: goop_core::SubtitleMode::Soft,
        });
        let eligibility = service
            .eligibility(&resolver, subtitle.clone())
            .await
            .unwrap();
        assert!(!eligibility.available);
        let eligibility_reason = eligibility.reason.unwrap();
        assert!(eligibility_reason.contains("subtitles or GIF"));
        assert_eq!(
            service
                .generate(&resolver, subtitle)
                .await
                .unwrap_err()
                .user_message(),
            eligibility_reason
        );

        assert!(service.state.lock().unwrap().session_id.is_none());
        assert!(service.state.lock().unwrap().active.is_none());
        assert!(!service.root.exists());
    }

    #[tokio::test]
    async fn eligibility_rejects_request_only_options_before_path_inspection() {
        let tmp = tempfile::tempdir().unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));
        let request: PreviewRequest = serde_json::from_value(serde_json::json!({
            "request_id": "request-only-ordering",
            "source_revision": "revision-1",
            "input_path": tmp.path().join("missing-source.mp4"),
            "target": "mp4",
            "preview_session_id": "not-a-live-session",
            "video_options": { "kind": "copy" }
        }))
        .unwrap();

        let result = service.eligibility(&resolver, request).await.unwrap();

        assert!(!result.available);
        assert!(result.reason.unwrap().contains("Explicit video previews"));
        assert!(service.state.lock().unwrap().eligibility.is_none());
        assert!(!service.root.exists());
    }

    #[tokio::test]
    async fn eligibility_rejects_unbounded_image_sources_and_non_mp4_video_targets() {
        let tmp = tempfile::tempdir().unwrap();
        let raw = tmp.path().join("source.dng");
        std::fs::write(&raw, b"not decoded").unwrap();
        let video = tmp.path().join("source.mov");
        std::fs::write(&video, b"not probed").unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));

        let raw_request = automatic_request(&raw, TargetFormat::Jpeg);
        let raw_result = service
            .eligibility(&resolver, raw_request.clone())
            .await
            .unwrap();
        assert!(!raw_result.available);
        let raw_reason = raw_result.reason.unwrap();
        assert!(raw_reason.contains("bounded decoding is not supported"));
        assert_eq!(
            service
                .generate(&resolver, raw_request)
                .await
                .unwrap_err()
                .user_message(),
            raw_reason
        );

        let video_request = automatic_request(&video, TargetFormat::Webm);
        let video_result = service
            .eligibility(&resolver, video_request.clone())
            .await
            .unwrap();
        assert!(!video_result.available);
        let video_reason = video_result.reason.unwrap();
        assert!(video_reason.contains("MP4 only"));
        assert_eq!(
            service
                .generate(&resolver, video_request)
                .await
                .unwrap_err()
                .user_message(),
            video_reason
        );
    }

    #[tokio::test]
    async fn eligibility_distinguishes_retryable_inspection_failure_and_recovers() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.jpg");
        std::fs::write(&input, b"corrupt jpeg").unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));
        let request = automatic_request(&input, TargetFormat::Jpeg);

        assert!(service
            .eligibility(&resolver, request.clone())
            .await
            .is_err());

        image::RgbImage::from_pixel(16, 8, image::Rgb([40, 80, 120]))
            .save(&input)
            .unwrap();
        let recovered = service.eligibility(&resolver, request).await.unwrap();
        assert!(recovered.available);
    }

    #[tokio::test]
    async fn eligibility_reports_missing_and_oversized_sources_without_worker_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));
        let missing = tmp.path().join("missing.jpg");
        let missing = service
            .eligibility(&resolver, automatic_request(&missing, TargetFormat::Jpeg))
            .await
            .unwrap();
        assert!(!missing.available);
        assert!(missing.reason.unwrap().contains("existing file"));

        let directory = service
            .eligibility(&resolver, automatic_request(tmp.path(), TargetFormat::Jpeg))
            .await
            .unwrap();
        assert!(!directory.available);
        assert_eq!(
            directory.reason.as_deref(),
            Some("Sample preview requires a file")
        );

        let oversized = tmp.path().join("oversized.png");
        std::fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_INPUT_BYTES + 1)
            .unwrap();
        let oversized = service
            .eligibility(&resolver, automatic_request(&oversized, TargetFormat::Png))
            .await
            .unwrap();
        assert!(!oversized.available);
        assert!(oversized.reason.unwrap().contains("64 MiB"));
    }

    #[tokio::test]
    async fn cancelling_eligibility_while_waiting_for_the_shared_lane_is_retryable() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.jpg");
        image::RgbImage::from_pixel(16, 8, image::Rgb([40, 80, 120]))
            .save(&input)
            .unwrap();
        let service = Arc::new(PreviewService::new(tmp.path().join("previews")));
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));
        let held = service.gate.clone().acquire_owned().await.unwrap();
        let worker_service = Arc::clone(&service);
        let worker = tokio::spawn(async move {
            worker_service
                .eligibility(&resolver, automatic_request(&input, TargetFormat::Jpeg))
                .await
        });
        for _ in 0..100 {
            if service.state.lock().unwrap().eligibility.is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }

        service.cancel("eligibility");
        drop(held);

        assert!(matches!(worker.await.unwrap(), Err(GoopError::Cancelled)));
        assert!(service.state.lock().unwrap().eligibility.is_none());
        assert!(service.state.lock().unwrap().active.is_none());
        assert!(!service.root.exists());
    }

    #[tokio::test]
    async fn static_refusal_supersedes_and_cancels_a_blocked_eligibility_inspection() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.jpg");
        image::RgbImage::from_pixel(16, 8, image::Rgb([40, 80, 120]))
            .save(&input)
            .unwrap();
        let service = Arc::new(PreviewService::new(tmp.path().join("previews")));
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));
        let held = service.gate.clone().acquire_owned().await.unwrap();
        let worker_service = Arc::clone(&service);
        let worker_input = input.clone();
        let worker = tokio::spawn(async move {
            worker_service
                .eligibility(
                    &resolver,
                    automatic_request(&worker_input, TargetFormat::Jpeg),
                )
                .await
        });
        for _ in 0..100 {
            if service.state.lock().unwrap().eligibility.is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }

        let mut refusal = automatic_request(&input, TargetFormat::Jpeg);
        refusal.request_id = "static-refusal".into();
        refusal.compress_mode = Some(CompressMode::TargetSizeBytes(32_000));
        let result = service
            .eligibility(&BinaryResolver::new(tmp.path().join("sidecars")), refusal)
            .await
            .unwrap();
        assert!(!result.available);
        assert!(result.reason.unwrap().contains("target-size compression"));

        drop(held);
        assert!(matches!(worker.await.unwrap(), Err(GoopError::Cancelled)));
        assert!(service.state.lock().unwrap().eligibility.is_none());
        assert!(!service.root.exists());
    }

    #[test]
    fn stale_eligibility_completion_cannot_clear_a_newer_matching_request_id() {
        let mut state = State::default();
        let request_id = "same-request-id".to_string();
        let first = register_eligibility(&mut state, b"first".to_vec(), request_id.clone());
        let second = register_eligibility(&mut state, b"second".to_vec(), request_id);

        finish_eligibility(&mut state, first.flight_epoch);
        assert_eq!(
            state.eligibility.as_ref().map(|active| active.epoch),
            Some(second.flight_epoch)
        );

        finish_eligibility(&mut state, second.flight_epoch);
        assert!(state.eligibility.is_none());
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[tokio::test]
    async fn eligibility_admits_heic_without_a_session_but_requires_explicit_jpeg_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.heic");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/heic-with-thumbnail.heic"
            ),
            &input,
        )
        .unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));

        let automatic = service
            .eligibility(&resolver, automatic_request(&input, TargetFormat::Jpeg))
            .await
            .unwrap();
        assert!(!automatic.available);
        assert!(automatic.reason.unwrap().contains("explicit JPEG"));

        let mut explicit = explicit_request(&input);
        explicit.preview_session_id = Some("not-a-runtime-session".into());
        explicit.pinned_jpeg_quality = Some(101);
        let available = service.eligibility(&resolver, explicit).await.unwrap();
        assert!(available.available);
        assert!(service.state.lock().unwrap().session_id.is_none());
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[tokio::test]
    async fn eligibility_caches_only_heic_admission_facts_by_path_and_content_digest() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.heic");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/heic-with-thumbnail.heic"
            ),
            &input,
        )
        .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let inspector: Arc<HeicAdmissionInspector> = {
            let calls = Arc::clone(&calls);
            Arc::new(move |_bytes, _cancel, _deadline| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        };
        let service = PreviewService::new_with_heic_admission_inspector(
            tmp.path().join("previews"),
            inspector,
        );
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));
        let mut request = explicit_request(&input);

        assert!(
            service
                .eligibility(&resolver, request.clone())
                .await
                .unwrap()
                .available
        );
        request.request_id = "new-quality".into();
        request.image_options.as_mut().unwrap().jpeg_quality = 61;
        assert!(
            service
                .eligibility(&resolver, request.clone())
                .await
                .unwrap()
                .available
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        {
            let cached = service.heic_admission_cache.lock().unwrap();
            assert_eq!(
                cached.as_ref().unwrap().path,
                std::fs::canonicalize(&input).unwrap()
            );
        }

        std::fs::copy(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sample.heic"),
            &input,
        )
        .unwrap();
        request.request_id = "changed-source".into();
        assert!(
            service
                .eligibility(&resolver, request)
                .await
                .unwrap()
                .available
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[tokio::test]
    async fn identical_in_flight_eligibility_requests_share_one_heic_inspection() {
        use std::sync::atomic::Ordering;

        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.heic");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/heic-with-thumbnail.heic"
            ),
            &input,
        )
        .unwrap();
        let blocker = Arc::new(BlockingHeicInspector {
            entered: tokio::sync::Notify::new(),
            calls: std::sync::atomic::AtomicUsize::new(0),
            resumed: std::sync::Mutex::new(false),
            resume: std::sync::Condvar::new(),
        });
        let inspector: Arc<HeicAdmissionInspector> = {
            let blocker = Arc::clone(&blocker);
            Arc::new(move |_bytes, _cancel, _deadline| blocker.inspect())
        };
        let service = Arc::new(PreviewService::new_with_heic_admission_inspector(
            tmp.path().join("previews"),
            inspector,
        ));
        let _unblock_on_drop = UnblockInspectorOnDrop(Arc::clone(&blocker));

        let first_service = Arc::clone(&service);
        let first_input = input.clone();
        let first = tokio::spawn(async move {
            let resolver = BinaryResolver::new(first_input.parent().unwrap().join("sidecars"));
            first_service
                .eligibility(&resolver, explicit_request(&first_input))
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), blocker.entered.notified())
            .await
            .expect("first eligibility request did not enter HEIC inspection");

        let second_service = Arc::clone(&service);
        let second_input = input.clone();
        let second = tokio::spawn(async move {
            let resolver = BinaryResolver::new(second_input.parent().unwrap().join("sidecars"));
            let mut request = explicit_request(&second_input);
            request.request_id = "coalesced-second".into();
            second_service.eligibility(&resolver, request).await
        });
        for _ in 0..100 {
            if service
                .state
                .lock()
                .unwrap()
                .eligibility
                .as_ref()
                .is_some_and(|active| active.waiters.len() == 2)
            {
                break;
            }
            tokio::task::yield_now().await;
        }

        assert_eq!(blocker.calls.load(Ordering::SeqCst), 1);
        blocker.unblock();
        assert!(first.await.unwrap().unwrap().available);
        assert!(second.await.unwrap().unwrap().available);
        assert_eq!(blocker.calls.load(Ordering::SeqCst), 1);
        assert!(!service.root.exists());
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[tokio::test]
    async fn cancelling_one_coalesced_eligibility_caller_preserves_the_shared_inspection() {
        use std::sync::atomic::Ordering;

        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.heic");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/heic-with-thumbnail.heic"
            ),
            &input,
        )
        .unwrap();
        let blocker = Arc::new(BlockingHeicInspector {
            entered: tokio::sync::Notify::new(),
            calls: std::sync::atomic::AtomicUsize::new(0),
            resumed: std::sync::Mutex::new(false),
            resume: std::sync::Condvar::new(),
        });
        let inspector: Arc<HeicAdmissionInspector> = {
            let blocker = Arc::clone(&blocker);
            Arc::new(move |_bytes, _cancel, _deadline| blocker.inspect())
        };
        let service = Arc::new(PreviewService::new_with_heic_admission_inspector(
            tmp.path().join("previews"),
            inspector,
        ));
        let _unblock_on_drop = UnblockInspectorOnDrop(Arc::clone(&blocker));

        let first_service = Arc::clone(&service);
        let first_input = input.clone();
        let first = tokio::spawn(async move {
            let resolver = BinaryResolver::new(first_input.parent().unwrap().join("sidecars"));
            first_service
                .eligibility(&resolver, explicit_request(&first_input))
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), blocker.entered.notified())
            .await
            .expect("first eligibility request did not enter HEIC inspection");

        let second_service = Arc::clone(&service);
        let second_input = input.clone();
        let second = tokio::spawn(async move {
            let resolver = BinaryResolver::new(second_input.parent().unwrap().join("sidecars"));
            let mut request = explicit_request(&second_input);
            request.request_id = "coalesced-second".into();
            second_service.eligibility(&resolver, request).await
        });
        for _ in 0..100 {
            if service
                .state
                .lock()
                .unwrap()
                .eligibility
                .as_ref()
                .is_some_and(|active| active.waiters.len() == 2)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            service
                .state
                .lock()
                .unwrap()
                .eligibility
                .as_ref()
                .map(|active| active.waiters.len()),
            Some(2)
        );

        service.cancel("captured");
        assert_eq!(
            service
                .state
                .lock()
                .unwrap()
                .eligibility
                .as_ref()
                .map(|active| active.waiters.len()),
            Some(1)
        );
        blocker.unblock();

        assert!(matches!(first.await.unwrap(), Err(GoopError::Cancelled)));
        assert!(second.await.unwrap().unwrap().available);
        assert_eq!(blocker.calls.load(Ordering::SeqCst), 1);
        assert!(service.state.lock().unwrap().eligibility.is_none());
        assert!(!service.root.exists());
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[tokio::test]
    async fn rapid_same_source_eligibility_replacement_runs_one_heic_inspection() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.heic");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/heic-with-thumbnail.heic"
            ),
            &input,
        )
        .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let inspector: Arc<HeicAdmissionInspector> = {
            let calls = Arc::clone(&calls);
            Arc::new(move |_bytes, _cancel, _deadline| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        };
        let service = Arc::new(PreviewService::new_with_heic_admission_inspector(
            tmp.path().join("previews"),
            inspector,
        ));
        let held = service.gate.clone().acquire_owned().await.unwrap();

        let first_service = Arc::clone(&service);
        let first_input = input.clone();
        let first = tokio::spawn(async move {
            let resolver = BinaryResolver::new(first_input.parent().unwrap().join("sidecars"));
            first_service
                .eligibility(&resolver, explicit_request(&first_input))
                .await
        });
        for _ in 0..100 {
            if service.state.lock().unwrap().eligibility.is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }

        let second_service = Arc::clone(&service);
        let second_input = input.clone();
        let second = tokio::spawn(async move {
            let resolver = BinaryResolver::new(second_input.parent().unwrap().join("sidecars"));
            let mut request = explicit_request(&second_input);
            request.request_id = "replacement".into();
            request.image_options.as_mut().unwrap().jpeg_quality = 60;
            second_service.eligibility(&resolver, request).await
        });
        for _ in 0..100 {
            if service
                .state
                .lock()
                .unwrap()
                .eligibility
                .as_ref()
                .is_some_and(|active| {
                    active
                        .waiters
                        .iter()
                        .any(|waiter| waiter.request_id == "replacement")
                })
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        drop(held);

        assert!(matches!(first.await.unwrap(), Err(GoopError::Cancelled)));
        assert!(second.await.unwrap().unwrap().available);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[cfg(not(feature = "heic-thumbnail-preview"))]
    #[tokio::test]
    async fn eligibility_reports_feature_disabled_heic() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.heic");
        std::fs::write(&input, b"bounded input").unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));
        let result = service
            .eligibility(&resolver, explicit_request(&input))
            .await
            .unwrap();
        assert!(!result.available);
        assert!(result.reason.unwrap().contains("not enabled"));
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

    #[tokio::test]
    async fn rejected_raster_source_facts_do_not_create_preview_artifacts() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 255, 0]))
            .save(&input)
            .unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));

        let error = service
            .generate(&resolver, automatic_request(&input, TargetFormat::Jpeg))
            .await
            .unwrap_err();

        assert!(error.user_message().contains("background"));
        assert!(!service.root.exists());
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[tokio::test]
    async fn rejected_heic_source_facts_do_not_create_preview_artifacts() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.heic");
        std::fs::copy(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sample.heic"),
            &input,
        )
        .unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let session = service.begin_session().unwrap();
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));
        let mut request = explicit_request(&input);
        request.preview_session_id = Some(session);

        let error = service.generate(&resolver, request).await.unwrap_err();

        assert!(error.user_message().contains("HEIC preview unavailable"));
        assert!(!service.root.exists());
    }

    #[tokio::test]
    async fn failed_video_source_inspection_does_not_create_preview_artifacts() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.mp4");
        std::fs::write(&input, b"not a video").unwrap();
        let sidecars = tmp.path().join("sidecars");
        std::fs::create_dir(&sidecars).unwrap();
        std::fs::write(
            sidecars.join(if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            }),
            b"not executable",
        )
        .unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let resolver = BinaryResolver::new(sidecars);

        assert!(service
            .generate(&resolver, automatic_request(&input, TargetFormat::Mp4))
            .await
            .is_err());
        assert!(!service.root.exists());
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
            ImageWorkerContext {
                root: tmp.path().to_path_buf(),
                cached_heic: None,
                #[cfg(feature = "heic-thumbnail-preview")]
                heic_sampler: default_heic_sampler(),
            },
            Scratch(Some(output.clone())),
        );

        assert!(result.is_ok());
        assert!(output.exists());
        drop(scratch);
        assert!(!output.exists());
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[test]
    fn captured_heic_snapshot_reaches_the_bounded_sampler_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.heic");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/heic-with-thumbnail.heic"
            ),
            &input,
        )
        .unwrap();
        let bytes = capture_image(
            &input,
            MAX_INPUT_BYTES,
            &CancellationToken::new(),
            Instant::now() + TIMEOUT,
        )
        .unwrap();

        let frame = sample_heic_thumbnail(bytes.as_ref(), &|| Ok(())).unwrap();

        assert_eq!(
            (
                frame.admitted_dimensions.width,
                frame.admitted_dimensions.height
            ),
            (32, 24)
        );
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[tokio::test]
    async fn captured_heic_snapshot_decodes_on_the_preview_blocking_worker() {
        let bytes = include_bytes!("../tests/fixtures/heic-with-thumbnail.heic").to_vec();

        let frame = tokio::task::spawn_blocking(move || sample_heic_thumbnail(&bytes, &|| Ok(())))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            (
                frame.admitted_dimensions.width,
                frame.admitted_dimensions.height
            ),
            (32, 24)
        );
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[test]
    fn matching_session_and_source_digest_reuse_the_one_entry_heic_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first");
        let second = tmp.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let bytes: Bytes = include_bytes!("../tests/fixtures/heic-with-thumbnail.heic")
            .to_vec()
            .into();
        let request: PreviewRequest = serde_json::from_value(serde_json::json!({
            "request_id": "cache-first",
            "input_path": "unused.heic",
            "source_revision": "1",
            "target": "jpeg",
            "metadata_policy": "preserve",
            "preview_session_id": "123e4567-e89b-42d3-a456-426614174000",
            "image_options": {
                "jpeg_quality": 75,
                "resize": { "kind": "original" }
            }
        }))
        .unwrap();
        let cancel = CancellationToken::new();

        let (_, cache) = heic_image_sample_bytes(
            bytes.clone(),
            &first,
            &request,
            &cancel,
            Instant::now() + TIMEOUT,
            None,
            default_heic_sampler().as_ref(),
        )
        .unwrap();
        let cache = cache.expect("first decode must publish a cache candidate");
        assert!(cache.frame.raw_icc_profile.is_none());
        let cached_frame = Arc::clone(&cache.frame);

        let (_, cache_update) = heic_image_sample_bytes(
            bytes,
            &second,
            &PreviewRequest {
                request_id: "cache-second".into(),
                ..request
            },
            &cancel,
            Instant::now() + TIMEOUT,
            Some(cache),
            default_heic_sampler().as_ref(),
        )
        .unwrap();

        let cache_update = cache_update.expect("a matching cache hit retains the owned entry");
        assert!(Arc::ptr_eq(&cache_update.frame, &cached_frame));
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[tokio::test]
    async fn cancelled_waiting_refresh_does_not_discard_the_live_heic_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.heic");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/heic-with-thumbnail.heic"
            ),
            &input,
        )
        .unwrap();
        let service = Arc::new(PreviewService::new(tmp.path().join("previews")));
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));
        let session = service.begin_session().unwrap();
        let mut request = explicit_request(&input);
        request.preview_session_id = Some(session);
        service.generate(&resolver, request.clone()).await.unwrap();
        let cached_frame = Arc::clone(&service.heic_cache.lock().unwrap().as_ref().unwrap().frame);

        let held_permit = service.gate.clone().acquire_owned().await.unwrap();
        request.request_id = "waiting-refresh".into();
        let worker_service = Arc::clone(&service);
        let worker = tokio::spawn(async move { worker_service.generate(&resolver, request).await });
        for _ in 0..100 {
            if service
                .state
                .lock()
                .unwrap()
                .active
                .as_ref()
                .is_some_and(|active| active.request_id == "waiting-refresh")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        service.cancel("waiting-refresh");
        drop(held_permit);

        assert!(matches!(worker.await.unwrap(), Err(GoopError::Cancelled)));
        assert!(Arc::ptr_eq(
            &service.heic_cache.lock().unwrap().as_ref().unwrap().frame,
            &cached_frame
        ));
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[tokio::test]
    async fn changed_heic_source_cannot_reuse_the_previous_cache_when_resampling_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("source.heic");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/heic-with-thumbnail.heic"
            ),
            &input,
        )
        .unwrap();
        let service = PreviewService::new(tmp.path().join("previews"));
        let resolver = BinaryResolver::new(tmp.path().join("sidecars"));
        let session = service.begin_session().unwrap();
        let mut request = explicit_request(&input);
        request.preview_session_id = Some(session);

        service.generate(&resolver, request.clone()).await.unwrap();
        let old_digest = service
            .heic_cache
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .source_digest;

        std::fs::copy(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sample.heic"),
            &input,
        )
        .unwrap();
        request.request_id = "changed-source".into();
        assert!(matches!(
            service.generate(&resolver, request).await,
            Err(GoopError::PreviewUnavailable(_))
        ));
        assert_eq!(
            service
                .heic_cache
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .source_digest,
            old_digest
        );
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[test]
    fn heic_raw_icc_sample_is_normalized_once_before_cache_ownership() {
        let profile = wide_rgb_profile();
        let source = image::RgbImage::from_pixel(2, 1, image::Rgb([64, 180, 96]));
        let expected = crate::color::transform_pixels(
            DynamicImage::ImageRgb8(source.clone()),
            Some(profile.clone()),
            ImageColorPolicy::ConvertToSrgb,
            &CancellationToken::new(),
        )
        .unwrap()
        .pixels;
        assert_ne!(expected, source);
        let frame = SampleFrame {
            rgb: source.into_raw().into(),
            raw_icc_profile: Some(profile.into()),
            primary_dimensions: Dimensions {
                width: 20,
                height: 10,
            },
            admitted_dimensions: Dimensions {
                width: 2,
                height: 1,
            },
            provenance: crate::heic_preview_sampler::SampleProvenance::EmbeddedHeicThumbnail {
                item_id: 1,
            },
        };

        let normalized = normalize_heic_frame(frame, &CancellationToken::new()).unwrap();

        assert_eq!(normalized.rgb.as_ref(), expected.as_raw());
        assert!(normalized.raw_icc_profile.is_none());
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[test]
    fn real_heic_display_p3_thumbnail_completes_normalization() {
        let frame = sample_heic_thumbnail(
            include_bytes!("../tests/fixtures/heic-display-p3-thumbnail.heic"),
            &|| Ok(()),
        )
        .unwrap();
        let source_rgb = Arc::clone(&frame.rgb);

        let normalized = normalize_heic_frame(frame, &CancellationToken::new()).unwrap();

        assert_eq!(normalized.primary_dimensions.width, 192);
        assert_eq!(normalized.primary_dimensions.height, 144);
        assert_eq!(normalized.admitted_dimensions.width, 64);
        assert_eq!(normalized.admitted_dimensions.height, 48);
        assert!(normalized.raw_icc_profile.is_none());
        assert_ne!(normalized.rgb.as_ref(), source_rgb.as_ref());
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
            false,
        )
        .unwrap_err();
        assert!(error.to_string().contains("Source changed"));
    }
}
