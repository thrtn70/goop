use crate::state::AppState;
use goop_config::{apply_patch, save, Settings, SettingsPatch};
use goop_core::IpcError;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::State;

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Result<Settings, IpcError> {
    Ok(state.settings.read().clone())
}

#[tauri::command]
pub fn settings_set(
    mut patch: SettingsPatch,
    state: State<'_, AppState>,
) -> Result<Settings, IpcError> {
    if let Some(output_dir) = patch.output_dir.as_deref() {
        patch.output_dir = Some(canonical_dir(output_dir)?);
    }
    let mut w = state.settings.write();
    *w = apply_patch(&w, patch);
    save(&state.settings_path, &w).map_err(IpcError::from)?;
    // Mirror the HW toggle into the atomic the convert worker reads — it
    // doesn't take a settings snapshot, so we have to push updates.
    state
        .hw_enabled
        .store(w.hw_acceleration_enabled, Ordering::Relaxed);
    Ok(w.clone())
}

/// Reveal the rolling log folder in the OS file manager.
///
/// The point of writing logs is being able to hand them over, and "open your
/// application support directory" is not an instruction most people should
/// have to follow. Creates the directory first: the log file for today may
/// not exist yet on a fresh install, and opening a path that isn't there
/// fails with an error about the path rather than about logging.
#[tauri::command]
pub fn open_logs_folder(app: tauri::AppHandle) -> Result<(), IpcError> {
    use tauri_plugin_opener::OpenerExt;
    let dir = crate::logging::log_dir(&goop_core::path::data_dir());
    std::fs::create_dir_all(&dir).map_err(|e| {
        IpcError::Config(format!("log folder unavailable: {} ({e})", dir.display()))
    })?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| IpcError::Unknown(e.to_string()))
}

fn canonical_dir(raw: &str) -> Result<String, IpcError> {
    let expanded = goop_core::path::expand(raw);
    let dir = std::fs::canonicalize(&expanded).map_err(|e| {
        IpcError::Config(format!(
            "output folder is not available: {} ({e})",
            expanded.display()
        ))
    })?;
    if !dir.is_dir() {
        return Err(IpcError::Config(format!(
            "output path is not a folder: {}",
            expanded.display()
        )));
    }
    Ok(path_to_string(dir))
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}
