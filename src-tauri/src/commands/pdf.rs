use crate::state::AppState;
use goop_core::{IpcError, Job, JobId, JobKind, PdfOperation, PdfProbeResult};
use goop_pdf::probe;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn pdf_probe(path: String) -> Result<PdfProbeResult, IpcError> {
    let p = PathBuf::from(&path);
    tokio::task::spawn_blocking(move || probe::probe(&p))
        .await
        .map_err(|e| IpcError::Unknown(e.to_string()))?
        .map_err(|e| IpcError::Unknown(e.to_string()))
}

#[tauri::command]
pub async fn pdf_run(state: State<'_, AppState>, op: PdfOperation) -> Result<JobId, IpcError> {
    let payload = serde_json::to_value(&op).map_err(|e| IpcError::Unknown(e.to_string()))?;
    let job = Job::new(JobKind::Pdf, payload);
    let id = job.id;
    state.store.insert(&job)?;
    Ok(id)
}
