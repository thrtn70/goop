use crate::state::AppState;
use goop_core::{IpcError, Job, JobId, JobKind};
use goop_extractor::ytdlp::{ExtractRequest, UrlProbe, YtDlp};
use tauri::State;

#[tauri::command]
pub async fn extract_probe(url: String, state: State<'_, AppState>) -> Result<UrlProbe, IpcError> {
    YtDlp::probe(&state.resolver, &url)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn extract_from_url(
    req: ExtractRequest,
    state: State<'_, AppState>,
) -> Result<JobId, IpcError> {
    let payload = serde_json::to_value(&req).map_err(|e| IpcError::Queue(e.to_string()))?;
    let job = Job::new(JobKind::Extract, payload);
    state.store.insert(&job).map_err(IpcError::from)?;
    Ok(job.id)
}
