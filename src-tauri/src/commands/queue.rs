use crate::state::AppState;
use goop_core::{IpcError, Job, JobId, JobState};
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
pub fn queue_cancel_many(
    job_ids: Vec<JobId>,
    state: State<'_, AppState>,
) -> Result<usize, IpcError> {
    for id in &job_ids {
        state.scheduler.cancel(*id);
    }
    Ok(job_ids.len())
}

/// Reassign queue priorities so the supplied IDs are scheduled in the given
/// order. Running jobs and IDs not in queued state are silently skipped.
#[tauri::command]
pub fn queue_reorder(
    ordered_ids: Vec<JobId>,
    state: State<'_, AppState>,
) -> Result<usize, IpcError> {
    state.store.reorder_queued(&ordered_ids).map_err(Into::into)
}

/// Promote `job_id` to the top of the queued list. Other queued jobs keep
/// their relative order.
#[tauri::command]
pub fn queue_move_to_top(job_id: JobId, state: State<'_, AppState>) -> Result<usize, IpcError> {
    let jobs = state.store.list()?;
    let mut order: Vec<JobId> = jobs
        .into_iter()
        .filter(|j| matches!(j.state, JobState::Queued))
        .map(|j| j.id)
        .filter(|id| *id != job_id)
        .collect();
    order.insert(0, job_id);
    state.store.reorder_queued(&order).map_err(Into::into)
}

#[tauri::command]
pub fn queue_clear_completed(state: State<'_, AppState>) -> Result<usize, IpcError> {
    state.store.clear_completed().map_err(Into::into)
}

/// Count jobs that finished today (since `since_ms`, expected to be midnight
/// in the user's local timezone). The frontend computes midnight so we don't
/// have to thread chrono into the workspace.
#[tauri::command]
pub fn queue_completed_since(since_ms: i64, state: State<'_, AppState>) -> Result<u32, IpcError> {
    state.store.completed_since(since_ms).map_err(Into::into)
}

#[tauri::command]
pub fn queue_reveal(path: String, app: tauri::AppHandle) -> Result<(), IpcError> {
    use tauri_plugin_opener::OpenerExt;
    let expanded = goop_core::path::expand(&path);
    let canonical = std::fs::canonicalize(&expanded).map_err(|e| {
        IpcError::Config(format!(
            "file is not available: {} ({e})",
            expanded.display()
        ))
    })?;
    app.opener()
        .reveal_item_in_dir(canonical)
        .map_err(|e| IpcError::Unknown(e.to_string()))
}
