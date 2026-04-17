use crate::state::AppState;
use goop_core::{HistoryFilter, IpcError, JobId};
use tauri::State;

/// Move a file to the OS trash. Validates that `path` matches a known job's
/// output path before doing anything destructive so arbitrary paths from the
/// frontend can't be trashed by this command.
#[tauri::command]
pub async fn file_move_to_trash(state: State<'_, AppState>, path: String) -> Result<(), IpcError> {
    let jobs = state
        .store
        .list_terminal(&HistoryFilter::default())
        .map_err(IpcError::from)?;
    let known = jobs.iter().any(|j| {
        j.result
            .as_ref()
            .and_then(|r| r.output_path.as_deref())
            .is_some_and(|p| p == path)
    });
    if !known {
        return Err(IpcError::Unknown(
            "refusing to trash a path that isn't a known job output".into(),
        ));
    }
    trash::delete(&path).map_err(|e| IpcError::Unknown(format!("trash failed: {e}")))?;
    Ok(())
}

/// Delete a single job row from the queue DB and evict its cached thumbnail.
#[tauri::command]
pub async fn job_forget(state: State<'_, AppState>, job_id: JobId) -> Result<(), IpcError> {
    state.store.forget(job_id)?;
    state.thumbs.evict(&job_id);
    Ok(())
}

/// Delete multiple job rows atomically; evict their thumbnails too.
#[tauri::command]
pub async fn job_forget_many(state: State<'_, AppState>, ids: Vec<JobId>) -> Result<u32, IpcError> {
    let n = state.store.forget_many(&ids)? as u32;
    for id in &ids {
        state.thumbs.evict(id);
    }
    Ok(n)
}
