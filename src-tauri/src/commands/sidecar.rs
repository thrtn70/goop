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
    let version = if yt.is_some() {
        let checker = UpdateChecker::new(&state.resolver);
        checker.current_version().await.ok()
    } else {
        None
    };
    Ok(SidecarStatus {
        ffmpeg_path: ff,
        yt_dlp_path: yt,
        yt_dlp_version: version,
    })
}

#[tauri::command]
pub async fn sidecar_update_yt_dlp(state: State<'_, AppState>) -> Result<UpdateStatus, IpcError> {
    let checker = UpdateChecker::new(&state.resolver);
    checker.update_in_place().await.map_err(Into::into)
}
