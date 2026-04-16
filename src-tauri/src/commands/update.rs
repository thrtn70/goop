use crate::app_update;
use goop_core::{IpcError, UpdateInfo};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use ts_rs::TS;

/// Progress tick emitted to the UI while a download is in flight.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: u64,
}

/// Resolve the current running version from the compiled workspace version.
/// Using `CARGO_PKG_VERSION` rather than `tauri::getVersion()` keeps the value
/// consistent with cargo tooling and avoids a JS round-trip from Rust.
fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
pub async fn check_for_update() -> Result<Option<UpdateInfo>, IpcError> {
    app_update::check(current_version())
        .await
        .map_err(|e| IpcError::Unknown(format!("update check failed: {e}")))
}

#[tauri::command]
pub async fn download_update(app: AppHandle, url: String) -> Result<(), IpcError> {
    let app_for_progress = app.clone();
    let path = app_update::download(&url, current_version(), move |downloaded, total| {
        let _ = app_for_progress.emit(
            "goop://update/progress",
            UpdateProgress { downloaded, total },
        );
    })
    .await
    .map_err(|e| IpcError::Unknown(format!("download failed: {e}")))?;

    let path_str = path.to_string_lossy().into_owned();
    app.opener()
        .open_path(path_str.clone(), None::<&str>)
        .map_err(|e| IpcError::Unknown(format!("open installer failed: {e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn open_releases_page(app: AppHandle) -> Result<(), IpcError> {
    app.opener()
        .open_url(app_update::releases_page_url(), None::<&str>)
        .map_err(|e| IpcError::Unknown(format!("open releases page failed: {e}")))?;
    Ok(())
}
