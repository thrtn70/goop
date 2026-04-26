use crate::state::AppState;
use goop_core::{IpcError, Job, JobId, JobState};
use goop_queue::SchedulerError;
use tauri::State;

fn map_scheduler_err(e: SchedulerError) -> IpcError {
    match e {
        // The race window between state→Running and the worker registering
        // its PID. The frontend retries briefly when it sees this.
        SchedulerError::JobNotRunning => IpcError::Queue("job_not_running".into()),
        SchedulerError::JobNotPaused => IpcError::Queue("job_not_paused".into()),
        SchedulerError::ProcessControl(inner) => IpcError::Unknown(inner.to_string()),
        SchedulerError::Store(inner) => inner.into(),
    }
}

#[tauri::command]
pub fn queue_list(state: State<'_, AppState>) -> Result<Vec<Job>, IpcError> {
    state.store.list().map_err(Into::into)
}

#[tauri::command]
pub fn queue_cancel(job_id: JobId, state: State<'_, AppState>) -> Result<(), IpcError> {
    state.scheduler.cancel(job_id);
    Ok(())
}

/// Suspend the running child process for `job_id` (Phase G — v0.2.0).
/// Maps to SIGSTOP on Unix, NtSuspendProcess on Windows. Only ffmpeg
/// conversions and Ghostscript PDF compress jobs register PIDs; image
/// conversions and yt-dlp downloads return a `job_not_running` queue error.
#[tauri::command]
pub fn queue_pause(job_id: JobId, state: State<'_, AppState>) -> Result<(), IpcError> {
    state.scheduler.pause(job_id).map_err(map_scheduler_err)
}

/// Resume a previously-paused child process. Maps to SIGCONT on Unix,
/// NtResumeProcess on Windows.
#[tauri::command]
pub fn queue_resume(job_id: JobId, state: State<'_, AppState>) -> Result<(), IpcError> {
    state.scheduler.resume(job_id).map_err(map_scheduler_err)
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
