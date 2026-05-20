use crate::state::AppState;
use goop_core::{ImageOperation, IpcError, Job, JobId, JobKind};
use tauri::State;

/// Enqueue an `ImageOperation` as a `JobKind::Image` job. Returns the new
/// job id. Mirrors `commands::pdf::pdf_run` — payload is the JSON
/// serialization of `ImageOperation`, and the image worker (in
/// `src-tauri/src/lib.rs`) deserializes and dispatches per `kind`.
#[tauri::command]
pub async fn image_run(state: State<'_, AppState>, op: ImageOperation) -> Result<JobId, IpcError> {
    let payload = serde_json::to_value(&op).map_err(|e| IpcError::Unknown(e.to_string()))?;
    let job = Job::new(JobKind::Image, payload);
    let id = job.id;
    state.store.insert(&job)?;
    Ok(id)
}
