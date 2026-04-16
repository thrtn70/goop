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
    let path = presets_path();
    let current = presets::load_or_seed(&path)?;
    let next = presets::upsert(current, preset.clone());
    presets::save(&path, &next)?;
    Ok(preset)
}

#[tauri::command]
pub async fn preset_delete(id: String) -> Result<(), IpcError> {
    let path = presets_path();
    let current = presets::load_or_seed(&path)?;
    let next = presets::remove(current, &id);
    presets::save(&path, &next)?;
    Ok(())
}
