use crate::state::AppState;
use goop_converter::preview::PreviewService;
use goop_core::{IpcError, PreviewRequest, PreviewResult};
use tauri::State;

#[tauri::command]
pub fn begin_preview_session(previews: State<'_, PreviewService>) -> Result<String, IpcError> {
    previews.begin_session().map_err(Into::into)
}

#[tauri::command]
pub fn release_preview_session(
    previews: State<'_, PreviewService>,
    preview_session_id: String,
) -> Result<(), IpcError> {
    previews
        .release_session(&preview_session_id)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn generate_preview(
    state: State<'_, AppState>,
    previews: State<'_, PreviewService>,
    request: PreviewRequest,
) -> Result<PreviewResult, IpcError> {
    previews
        .generate(&state.resolver, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn cancel_preview(previews: State<'_, PreviewService>, request_id: String) {
    previews.cancel(&request_id);
}
