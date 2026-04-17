use crate::state::AppState;
use goop_core::{HistoryCounts, HistoryFilter, IpcError, Job};
use tauri::State;

#[tauri::command]
pub async fn history_list(
    state: State<'_, AppState>,
    filter: HistoryFilter,
) -> Result<Vec<Job>, IpcError> {
    state.store.list_terminal(&filter).map_err(Into::into)
}

#[tauri::command]
pub async fn history_counts(state: State<'_, AppState>) -> Result<HistoryCounts, IpcError> {
    state.store.history_counts().map_err(Into::into)
}
