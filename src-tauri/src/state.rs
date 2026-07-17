use crate::thumbnail::ThumbnailService;
use goop_config::Settings;
use goop_converter::DetectedEncoders;
use goop_queue::{QueueStore, Scheduler};
use goop_sidecar::BinaryResolver;
use parking_lot::RwLock;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub struct AppState {
    pub resolver: Arc<BinaryResolver>,
    pub store: QueueStore,
    /// Exclusive lock proving this process owns the shared queue. Held for the
    /// whole process lifetime; dropping it (on exit) releases the lock so a
    /// later instance can take over. Never read directly — presence is the point.
    #[allow(dead_code)]
    pub instance_guard: goop_core::InstanceGuard,
    pub scheduler: Arc<Scheduler>,
    pub settings: RwLock<Settings>,
    pub settings_path: PathBuf,
    pub thumbs: ThumbnailService,
    /// HW encoders the bundled ffmpeg supports. Detected once at startup.
    pub encoders: Arc<DetectedEncoders>,
    /// Live "use HW acceleration" toggle. Workers read this each convert
    /// so toggling the setting takes effect without restarting jobs.
    pub hw_enabled: Arc<AtomicBool>,
    /// Writable user dir for downloaded Tesseract language packs.
    /// Located under the OS-specific app-data dir; first dir searched
    /// when resolving `<lang>.traineddata` so user downloads override
    /// the bundled English file.
    pub tessdata_user_dir: PathBuf,
    /// Read-only bundled tessdata dir shipped with the installer.
    /// `Some` when `eng.traineddata` is co-located with the app's
    /// resources; `None` in dev builds (when the tessdata file hasn't
    /// been fetched into the dev `src-tauri/bin/` tree).
    pub tessdata_bundled_dir: Option<PathBuf>,
}
