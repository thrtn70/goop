use crate::state::AppState;
use goop_converter::preview::PreviewService;
use goop_core::{IpcError, PreviewRequest, PreviewResult};
use tauri::State;

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
