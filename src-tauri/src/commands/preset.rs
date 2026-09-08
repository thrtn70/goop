use goop_config::presets;
use goop_core::{path as gpath, IpcError, Preset};

fn presets_path() -> std::path::PathBuf {
    gpath::presets_file()
}

#[tauri::command]
pub async fn preset_list() -> Result<Vec<Preset>, IpcError> {
    let path = presets_path();
    presets::load_or_seed(&path).map_err(Into::into)
}

#[tauri::command]
pub async fn preset_save(preset: Preset) -> Result<Preset, IpcError> {
    presets::save_one(&presets_path(), preset).map_err(Into::into)
}

#[tauri::command]
pub async fn preset_import(presets: Vec<Preset>) -> Result<Vec<Preset>, IpcError> {
    presets::import(&presets_path(), presets).map_err(Into::into)
}

#[tauri::command]
pub async fn preset_delete(id: String) -> Result<(), IpcError> {
    presets::delete(&presets_path(), &id).map_err(Into::into)
}
