use crate::state::AppState;
use goop_core::{IpcError, Job, JobId, JobKind};
use goop_extractor::ytdlp::{ExtractRequest, UrlProbe, YtDlp};
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn extract_probe(url: String, state: State<'_, AppState>) -> Result<UrlProbe, IpcError> {
    let cookies = state.settings.read().cookies_from_browser.clone();
    YtDlp::probe(&state.resolver, &url, cookies.as_deref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn extract_from_url(
    mut req: ExtractRequest,
    state: State<'_, AppState>,
) -> Result<JobId, IpcError> {
    // Bake the user's current cookies-from-browser preference into the
    // request so the worker uses what was active when the job was queued.
    // Mirrors the pattern used for HW acceleration and keeps in-flight
    // jobs unaffected by later toggles.
    req.cookies_from_browser = state.settings.read().cookies_from_browser.clone();
    req.output_dir = canonical_dir(&req.output_dir)?;
    let payload = serde_json::to_value(&req).map_err(|e| IpcError::Queue(e.to_string()))?;
    let job = Job::new(JobKind::Extract, payload);
    state.store.insert(&job).map_err(IpcError::from)?;
    Ok(job.id)
}

fn canonical_dir(raw: &str) -> Result<String, IpcError> {
    let expanded = goop_core::path::expand(raw);
    let dir = std::fs::canonicalize(&expanded).map_err(|e| {
        IpcError::Config(format!(
            "output folder is not available: {} ({e})",
            expanded.display()
        ))
    })?;
    if !dir.is_dir() {
        return Err(IpcError::Config(format!(
            "output path is not a folder: {}",
            expanded.display()
        )));
    }
    Ok(path_to_string(dir))
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}
