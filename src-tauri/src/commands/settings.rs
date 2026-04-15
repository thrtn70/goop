use crate::state::AppState;
use goop_config::{apply_patch, save, Settings, SettingsPatch};
use goop_core::IpcError;
use tauri::State;

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Result<Settings, IpcError> {
    Ok(state.settings.read().clone())
}

#[tauri::command]
pub fn settings_set(
    patch: SettingsPatch,
    state: State<'_, AppState>,
) -> Result<Settings, IpcError> {
    let mut w = state.settings.write();
    *w = apply_patch(&w, patch);
    save(&state.settings_path, &w).map_err(IpcError::from)?;
    Ok(w.clone())
}
