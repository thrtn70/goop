use goop_config::Settings;
use goop_queue::{QueueStore, Scheduler};
use goop_sidecar::BinaryResolver;
use parking_lot::RwLock;
use std::path::PathBuf;
use std::sync::Arc;

pub struct AppState {
    pub resolver: Arc<BinaryResolver>,
    pub store: QueueStore,
    pub scheduler: Arc<Scheduler>,
    pub settings: RwLock<Settings>,
    pub settings_path: PathBuf,
}
