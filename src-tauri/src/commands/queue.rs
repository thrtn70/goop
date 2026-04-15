use crate::state::AppState;
use goop_core::{IpcError, Job, JobId};
use tauri::State;

#[tauri::command]
pub fn queue_list(state: State<'_, AppState>) -> Result<Vec<Job>, IpcError> {
    state.store.list().map_err(Into::into)
}

#[tauri::command]
pub fn queue_cancel(job_id: JobId, state: State<'_, AppState>) -> Result<(), IpcError> {
    state.scheduler.cancel(job_id);
    Ok(())
}

#[tauri::command]
pub fn queue_clear_completed(state: State<'_, AppState>) -> Result<usize, IpcError> {
    state.store.clear_completed().map_err(Into::into)
}

#[tauri::command]
pub fn queue_reveal(path: String, app: tauri::AppHandle) -> Result<(), IpcError> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| IpcError::Unknown(e.to_string()))
}
