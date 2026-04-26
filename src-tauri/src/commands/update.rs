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

/// Open a fixed external URL by name. Hardcoded allowlist so the
/// renderer can't smuggle arbitrary URLs through this command.
///
/// **Keep the match arms below in sync with the `AboutLinkTarget`
/// union in `src/ipc/commands.ts`** — they're the same allowlist
/// expressed twice (once for the Rust validator, once for the TS
/// caller's type narrowing). A new arm here without a corresponding
/// TS union member compiles but loses type-checking at the call site.
#[tauri::command]
pub async fn open_about_link(app: AppHandle, target: String) -> Result<(), IpcError> {
    let url = match target.as_str() {
        "repo" => "https://github.com/thrtn70/goop",
        "issues" => "https://github.com/thrtn70/goop/issues",
        "license" => "https://github.com/thrtn70/goop/blob/main/LICENSE",
        "yt-dlp" => "https://github.com/yt-dlp/yt-dlp",
        "ffmpeg" => "https://ffmpeg.org",
        "ghostscript" => "https://ghostscript.com",
        "tauri" => "https://tauri.app",
        _ => return Err(IpcError::Unknown(format!("unknown about target: {target}"))),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| IpcError::Unknown(format!("open url failed: {e}")))?;
    Ok(())
}
