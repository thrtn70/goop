use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Describes a newer release of Goop available on GitHub. Produced by the
/// `check_for_update` IPC command when the latest GitHub release is strictly
/// newer than the running app's version. `download_url` points at the asset
/// matching the current platform (macOS aarch64/x64 `.dmg`, Windows `.msi`
/// or `.exe`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub download_url: String,
    pub asset_size: u64,
    pub release_notes: String,
    pub published_at: String,
}
