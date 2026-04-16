use crate::state::AppState;
use goop_converter::Ffmpeg;
use goop_core::{ConvertRequest, IpcError, Job, JobId, JobKind, ProbeResult};
use std::path::Path;
use tauri::State;

#[tauri::command]
pub async fn convert_probe(
    path: String,
    state: State<'_, AppState>,
) -> Result<ProbeResult, IpcError> {
    Ffmpeg::probe(&state.resolver, Path::new(&path))
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn convert_from_file(
    req: ConvertRequest,
    state: State<'_, AppState>,
) -> Result<JobId, IpcError> {
    let payload = serde_json::to_value(&req).map_err(|e| IpcError::Queue(e.to_string()))?;
    let job = Job::new(JobKind::Convert, payload);
    state.store.insert(&job).map_err(IpcError::from)?;
    Ok(job.id)
}
