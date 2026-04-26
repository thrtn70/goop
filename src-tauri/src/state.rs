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
    pub scheduler: Arc<Scheduler>,
    pub settings: RwLock<Settings>,
    pub settings_path: PathBuf,
    pub thumbs: ThumbnailService,
    /// HW encoders the bundled ffmpeg supports. Detected once at startup.
    pub encoders: Arc<DetectedEncoders>,
    /// Live "use HW acceleration" toggle. Workers read this each convert
    /// so toggling the setting takes effect without restarting jobs.
    pub hw_enabled: Arc<AtomicBool>,
}
