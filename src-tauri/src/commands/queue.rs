use crate::state::AppState;
use goop_core::{IpcError, Job, JobId, JobKind, JobState};
use goop_queue::SchedulerError;
use tauri::State;

fn map_scheduler_err(e: SchedulerError) -> IpcError {
    match e {
        // The race window between state→Running and the worker registering
        // its PID. The frontend retries briefly when it sees this.
        SchedulerError::JobNotRunning => IpcError::Queue("job_not_running".into()),
        SchedulerError::JobNotPaused => IpcError::Queue("job_not_paused".into()),
        SchedulerError::JobNotPausable => IpcError::Queue("job_not_pausable".into()),
        SchedulerError::JobNotRetryable => IpcError::Queue("job_not_retryable".into()),
        SchedulerError::ProcessControl(inner) => IpcError::Unknown(inner.to_string()),
        SchedulerError::Store(inner) => inner.into(),
    }
}

#[tauri::command]
pub fn queue_list(state: State<'_, AppState>) -> Result<Vec<Job>, IpcError> {
    state.store.list().map_err(Into::into)
}

/// Cancel a job in any non-terminal state: running jobs get their stop
/// token fired, queued and paused jobs are finalized directly. Cancelling
/// a paused download also removes its partial files — pause is the
/// keep-partial verb, cancel means done — which happens best-effort off
/// the IPC thread since the paused job has no live worker to clean up.
#[tauri::command]
pub fn queue_cancel(job_id: JobId, state: State<'_, AppState>) -> Result<(), IpcError> {
    let paused_extract_req = paused_extract_request(&state, job_id);
    state.scheduler.cancel(job_id).map_err(map_scheduler_err)?;
    if let Some(req) = paused_extract_req {
        spawn_paused_partial_cleanup(&state, job_id, req);
    }
    Ok(())
}

/// Run `cleanup_partials_for` off-thread — but only after re-checking
/// that the row actually finalized as Cancelled. The pre-cancel "was it
/// a paused extract job" read can go stale: if a concurrent resume won
/// the race, the job is queued/running again and its worker owns the
/// partials (unlinking them here could rip a fresh in-flight `.part`
/// out from under the resumed download). Cancelled is terminal, so a
/// row that passes this check can't come back to life afterwards.
fn spawn_paused_partial_cleanup(
    state: &State<'_, AppState>,
    job_id: JobId,
    req: goop_extractor::ytdlp::ExtractRequest,
) {
    let finalized = state
        .store
        .get_by_id(job_id)
        .ok()
        .flatten()
        .is_some_and(|j| j.state == JobState::Cancelled);
    if finalized {
        tauri::async_runtime::spawn_blocking(move || {
            goop_extractor::cleanup_partials_for(&req);
        });
    }
}

/// The parsed `ExtractRequest` of `job_id` IF it is a paused extract job,
/// read before the cancel flips its state. `None` for everything else —
/// running downloads clean up in their own cancel branch.
fn paused_extract_request(
    state: &State<'_, AppState>,
    job_id: JobId,
) -> Option<goop_extractor::ytdlp::ExtractRequest> {
    let job = state.store.get_by_id(job_id).ok().flatten()?;
    if job.kind != JobKind::Extract || job.state != JobState::Paused {
        return None;
    }
    serde_json::from_value(job.payload).ok()
}

/// Pause the job identified by `job_id`. Jobs with a registered child
/// PID (ffmpeg conversions, Ghostscript PDF compress, and other external
/// PDF tools) are suspended in place — SIGSTOP on Unix, NtSuspendProcess
/// on Windows. Download jobs stop gracefully instead: the worker keeps
/// its partial files on disk and the row flips to `paused` via a queue
/// event once the worker yields, shortly after this command returns Ok.
/// Running jobs with neither mechanism return `job_not_pausable`; jobs
/// that aren't running return `job_not_running`.
#[tauri::command]
pub fn queue_pause(job_id: JobId, state: State<'_, AppState>) -> Result<(), IpcError> {
    state.scheduler.pause(job_id).map_err(map_scheduler_err)
}

/// Resume a paused job. PID-suspended children continue in place
/// (SIGCONT / NtResumeProcess). Paused download jobs are re-queued at the
/// front instead; the partial files on disk make the re-run a resume.
/// Works across app restarts for download jobs.
#[tauri::command]
pub fn queue_resume(job_id: JobId, state: State<'_, AppState>) -> Result<(), IpcError> {
    state.scheduler.resume(job_id).map_err(map_scheduler_err)
}

/// Re-queue a failed job on the same row: state flips back to `queued`,
/// `attempts` is incremented, and the result/timestamps are cleared. Any
/// kind in an error state qualifies (including jobs interrupted by an app
/// crash); for download jobs, partial files on disk make the re-run a
/// resume. Jobs not in an error state return `job_not_retryable`.
#[tauri::command]
pub fn queue_retry(job_id: JobId, state: State<'_, AppState>) -> Result<(), IpcError> {
    state.scheduler.retry(job_id).map_err(map_scheduler_err)
}

#[tauri::command]
pub fn queue_cancel_many(
    job_ids: Vec<JobId>,
    state: State<'_, AppState>,
) -> Result<usize, IpcError> {
    let mut cancelled = 0usize;
    for id in &job_ids {
        let paused_extract_req = paused_extract_request(&state, *id);
        match state.scheduler.cancel(*id) {
            Ok(()) => {
                cancelled += 1;
                if let Some(req) = paused_extract_req {
                    spawn_paused_partial_cleanup(&state, *id, req);
                }
            }
            // Best-effort batch: keep going, report how many took.
            Err(e) => tracing::warn!(job_id = ?id, error = %e, "cancel failed in batch"),
        }
    }
    Ok(cancelled)
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
