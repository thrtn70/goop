use crate::thumbnail::ThumbnailService;
use goop_config::Settings;
use goop_converter::DetectedEncoders;
use goop_extractor::debrid::{HosterMatcher, TorBoxClient, TORBOX_API_BASE};
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
    /// Shared with the extract worker closure (`src-tauri/src/lib.rs`) so
    /// debrid dispatch reads the live TorBox key instead of a boot-time
    /// copy — same pattern as `hw_enabled`.
    pub settings: Arc<RwLock<Settings>>,
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
    /// Session cache of TorBox's supported-hoster domains, used by the
    /// probe fallback to decide whether an unrecognised link can route
    /// through the debrid service. Filled on first use.
    pub torbox_hosters: tokio::sync::OnceCell<HosterMatcher>,
}

impl AppState {
    /// TorBox supported-hoster matcher, fetched once per app session.
    /// `None` when no API key is configured or the fetch failed (the
    /// probe then simply skips the debrid fallback).
    pub async fn torbox_hosters(&self) -> Option<HosterMatcher> {
        let key = self.settings.read().torbox_api_key.clone()?;
        self.torbox_hosters
            .get_or_try_init(|| async { TorBoxClient::new(TORBOX_API_BASE, key).hosters().await })
            .await
            .ok()
            .cloned()
    }
}
