use crate::state::AppState;
use goop_core::IpcError;
use goop_sidecar::updater::{UpdateChecker, UpdateStatus};
use serde::Serialize;
use tauri::State;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct SidecarStatus {
    pub ffmpeg_path: Option<String>,
    pub yt_dlp_path: Option<String>,
    pub yt_dlp_version: Option<String>,
    pub gallery_dl_path: Option<String>,
    pub gallery_dl_version: Option<String>,
}

#[tauri::command]
pub async fn sidecar_status(state: State<'_, AppState>) -> Result<SidecarStatus, IpcError> {
    let ff = state
        .resolver
        .resolve("ffmpeg")
        .ok()
        .map(|r| r.path.to_string_lossy().into_owned());
    let yt = state
        .resolver
        .resolve("yt-dlp")
        .ok()
        .map(|r| r.path.to_string_lossy().into_owned());
    let yt_version = if yt.is_some() {
        UpdateChecker::for_yt_dlp(&state.resolver)
            .current_version()
            .await
            .ok()
    } else {
        None
    };
    let gd = state
        .resolver
        .resolve("gallery-dl")
        .ok()
        .map(|r| r.path.to_string_lossy().into_owned());
    let gd_version = if gd.is_some() {
        UpdateChecker::for_gallery_dl(&state.resolver)
            .current_version()
            .await
            .ok()
    } else {
        None
    };
    Ok(SidecarStatus {
        ffmpeg_path: ff,
        yt_dlp_path: yt,
        yt_dlp_version: yt_version,
        gallery_dl_path: gd,
        gallery_dl_version: gd_version,
    })
}

#[tauri::command]
pub async fn sidecar_update_yt_dlp(state: State<'_, AppState>) -> Result<UpdateStatus, IpcError> {
    let checker = UpdateChecker::for_yt_dlp(&state.resolver);
    checker.update_in_place().await.map_err(Into::into)
}

#[tauri::command]
pub async fn sidecar_update_gallery_dl(
    state: State<'_, AppState>,
) -> Result<UpdateStatus, IpcError> {
    let checker = UpdateChecker::for_gallery_dl(&state.resolver);
    checker.update_in_place().await.map_err(Into::into)
}

/// Run `yt-dlp --version` and return the trimmed stdout. Used by the
/// Settings → About section; cheap enough to call on demand.
#[tauri::command]
pub async fn sidecar_yt_dlp_version(state: State<'_, AppState>) -> Result<String, IpcError> {
    let checker = UpdateChecker::for_yt_dlp(&state.resolver);
    checker.current_version().await.map_err(Into::into)
}

/// Run `gallery-dl --version` and return the trimmed stdout. Used by
/// the Settings → About section.
#[tauri::command]
pub async fn sidecar_gallery_dl_version(state: State<'_, AppState>) -> Result<String, IpcError> {
    let checker = UpdateChecker::for_gallery_dl(&state.resolver);
    checker.current_version().await.map_err(Into::into)
}

/// Run `ffmpeg -version` and return the first line (contains the version).
#[tauri::command]
pub async fn sidecar_ffmpeg_version(state: State<'_, AppState>) -> Result<String, IpcError> {
    let bin = state
        .resolver
        .resolve("ffmpeg")
        .map_err(goop_core::IpcError::from)?;
    let out = tokio::process::Command::new(&bin.path)
        .arg("-version")
        .output()
        .await
        .map_err(|e| goop_core::IpcError::Unknown(format!("ffmpeg -version: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(stdout.lines().next().unwrap_or_default().trim().to_string())
}
