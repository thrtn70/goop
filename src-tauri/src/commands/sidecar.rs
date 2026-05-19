use crate::state::AppState;
use goop_core::IpcError;
use goop_sidecar::tessdata::{self, LanguagePack};
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
    pub ghostscript_path: Option<String>,
    pub ghostscript_version: Option<String>,
    pub mutool_path: Option<String>,
    pub mutool_version: Option<String>,
    pub tesseract_path: Option<String>,
    pub tesseract_version: Option<String>,
    /// Number of `.traineddata` files visible across the search dirs.
    /// Drives the Settings → OCR Languages section summary.
    pub tessdata_installed_count: u32,
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
    let gs = state
        .resolver
        .resolve("gs")
        .ok()
        .map(|r| r.path.to_string_lossy().into_owned());
    let gs_version = if gs.is_some() {
        UpdateChecker::for_ghostscript(&state.resolver)
            .current_version()
            .await
            .ok()
    } else {
        None
    };
    let mt = state
        .resolver
        .resolve("mutool")
        .ok()
        .map(|r| r.path.to_string_lossy().into_owned());
    let mt_version = if mt.is_some() {
        UpdateChecker::for_mutool(&state.resolver)
            .current_version()
            .await
            .ok()
    } else {
        None
    };
    let ts = state
        .resolver
        .resolve("tesseract")
        .ok()
        .map(|r| r.path.to_string_lossy().into_owned());
    let ts_version = if ts.is_some() {
        UpdateChecker::for_tesseract(&state.resolver)
            .current_version()
            .await
            .ok()
    } else {
        None
    };
    // `installed_languages` calls sync `std::fs::read_dir`; move it to
    // the blocking pool so we don't stall the Tokio reactor on (admittedly
    // tiny) directory scans. The clone-into-PathBufs is required so the
    // closure can own its inputs across the await.
    let tessdata_dirs: Vec<std::path::PathBuf> = std::iter::once(state.tessdata_user_dir.clone())
        .chain(state.tessdata_bundled_dir.clone())
        .collect();
    let tessdata_count = tokio::task::spawn_blocking(move || {
        let refs: Vec<&std::path::Path> = tessdata_dirs.iter().map(|p| p.as_path()).collect();
        tessdata::installed_languages(&refs).map(|v| v.len() as u32)
    })
    .await
    .ok()
    .and_then(Result::ok)
    .unwrap_or(0);
    Ok(SidecarStatus {
        ffmpeg_path: ff,
        yt_dlp_path: yt,
        yt_dlp_version: yt_version,
        gallery_dl_path: gd,
        gallery_dl_version: gd_version,
        ghostscript_path: gs,
        ghostscript_version: gs_version,
        mutool_path: mt,
        mutool_version: mt_version,
        tesseract_path: ts,
        tesseract_version: ts_version,
        tessdata_installed_count: tessdata_count,
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

/// Run `gs --version` and return the normalized semver. Used by the
/// Settings → About section.
#[tauri::command]
pub async fn sidecar_ghostscript_version(state: State<'_, AppState>) -> Result<String, IpcError> {
    let checker = UpdateChecker::for_ghostscript(&state.resolver);
    checker.current_version().await.map_err(Into::into)
}

/// Run `mutool -v` and return the normalized semver. Used by the
/// Settings → About section.
#[tauri::command]
pub async fn sidecar_mutool_version(state: State<'_, AppState>) -> Result<String, IpcError> {
    let checker = UpdateChecker::for_mutool(&state.resolver);
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

/// Run `tesseract --version` and return the normalized semver. Used by
/// Settings → About and the OCR Languages section header.
#[tauri::command]
pub async fn sidecar_tesseract_version(state: State<'_, AppState>) -> Result<String, IpcError> {
    let checker = UpdateChecker::for_tesseract(&state.resolver);
    checker.current_version().await.map_err(Into::into)
}

/// List Tesseract language packs installed across the search dirs. Used
/// by the OCR flow language pickers and the Settings → OCR Languages
/// section. User-downloaded packs (in the writable user dir) appear
/// before bundled packs when codes collide.
#[tauri::command]
pub async fn sidecar_tessdata_installed(
    state: State<'_, AppState>,
) -> Result<Vec<LanguagePack>, IpcError> {
    // Move the sync directory scan to the blocking pool so we don't
    // stall the Tokio reactor — matches the pattern in `sidecar_status`.
    let dirs: Vec<std::path::PathBuf> = std::iter::once(state.tessdata_user_dir.clone())
        .chain(state.tessdata_bundled_dir.clone())
        .collect();
    tokio::task::spawn_blocking(move || {
        let refs: Vec<&std::path::Path> = dirs.iter().map(|p| p.as_path()).collect();
        tessdata::installed_languages(&refs)
    })
    .await
    .map_err(|e| IpcError::Unknown(e.to_string()))?
    .map_err(Into::into)
}

/// List Tesseract language packs available for download from tessdata_fast.
/// Merged with installed state on the frontend so the picker can show
/// "Add language…" entries with sizes + a checkmark for already-installed
/// languages.
#[tauri::command]
pub async fn sidecar_tessdata_available() -> Result<Vec<LanguagePack>, IpcError> {
    Ok(tessdata::available_languages())
}

/// Download `<code>.traineddata` from tessdata_fast into the user data
/// dir. Returns `UpdateStatus` shape so the frontend can reuse the same
/// loading-state UX used for yt-dlp / gallery-dl updates.
#[tauri::command]
pub async fn sidecar_tessdata_download(
    state: State<'_, AppState>,
    code: String,
) -> Result<UpdateStatus, IpcError> {
    let dest_dir = state.tessdata_user_dir.clone();
    match tessdata::download_language(&code, &dest_dir).await {
        Ok(path) => Ok(UpdateStatus {
            attempted: true,
            previous_version: None,
            new_version: Some(code.clone()),
            message: format!("Downloaded {code} to {}", path.to_string_lossy()),
        }),
        Err(e) => Err(goop_core::IpcError::Unknown(e.to_string())),
    }
}

/// Remove `<code>.traineddata` from the user data dir. Bundled packs
/// (currently just `eng`) can be "removed" with no effect — the bundled
/// copy in the resource dir remains, but a user-downloaded override (if
/// any) is deleted. Frontend disables the Remove button on bundled rows
/// with no user override to avoid confusing UX.
#[tauri::command]
pub async fn sidecar_tessdata_remove(
    state: State<'_, AppState>,
    code: String,
) -> Result<(), IpcError> {
    tessdata::remove_language(&code, &state.tessdata_user_dir).map_err(Into::into)
}
