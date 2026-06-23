use crate::state::AppState;
use goop_core::{IpcError, Job, JobId, JobKind, MetadataOperation, MetadataView};
use tauri::State;

/// Read metadata for a set of paths. Synchronous-feeling (no job queued):
/// audio/image/pdf reads run on blocking threads, video shells out to the
/// bundled ffprobe. Never errors per file — a failed read yields a
/// `MetadataView` carrying an `Error` raw tag (see `goop_metadata::read`).
#[tauri::command]
pub async fn metadata_read(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<MetadataView>, IpcError> {
    Ok(goop_metadata::read(&state.resolver, &paths).await)
}

/// Enqueue a `MetadataOperation` as a `JobKind::Metadata` job. A batch
/// "Apply" is one job carrying every selected file; the metadata worker (in
/// `src-tauri/src/lib.rs`) writes each in turn and emits N/total progress.
/// Mirrors `commands::image::image_run` / `commands::pdf::pdf_run`.
#[tauri::command]
pub async fn metadata_run(
    state: State<'_, AppState>,
    op: MetadataOperation,
) -> Result<JobId, IpcError> {
    let payload = serde_json::to_value(&op).map_err(|e| IpcError::Unknown(e.to_string()))?;
    let job = Job::new(JobKind::Metadata, payload);
    let id = job.id;
    state.store.insert(&job)?;
    Ok(id)
}
