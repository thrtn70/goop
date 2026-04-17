use crate::state::AppState;
use goop_core::{ConvertRequest, IpcError, JobId, SourceKind};
use std::path::PathBuf;
use tauri::State;

/// Lazy thumbnail fetch. The frontend calls this with a `JobId`; the service
/// returns the disk path to a cached PNG (generating it on first call).
///
/// We derive the `SourceKind` from the job payload where possible, falling
/// back to a file-extension guess so the service knows which generator to
/// dispatch.
#[tauri::command]
pub async fn thumbnail_get(state: State<'_, AppState>, job_id: JobId) -> Result<String, IpcError> {
    let Some(job) = state.store.get_by_id(job_id)? else {
        return Err(IpcError::Unknown("unknown job id".into()));
    };
    let Some(result) = &job.result else {
        return Err(IpcError::Unknown("job has no output".into()));
    };
    let Some(output_path) = &result.output_path else {
        return Err(IpcError::Unknown("job has no output path".into()));
    };
    let path = PathBuf::from(output_path);

    let source_kind = infer_source_kind(&job.payload, &path);

    let resolver = state.resolver.as_ref();
    let thumb_path = state
        .thumbs
        .get(resolver, job_id, source_kind, &path)
        .await
        .map_err(|e| IpcError::Unknown(e.to_string()))?;
    Ok(thumb_path.to_string_lossy().into_owned())
}

fn infer_source_kind(payload: &serde_json::Value, output_path: &std::path::Path) -> SourceKind {
    // Convert jobs embed a ConvertRequest with an explicit target; the target
    // tells us image-vs-video clearly. PDF jobs always have PDF output. For
    // Extract jobs the file extension is the best signal.
    if let Ok(req) = serde_json::from_value::<ConvertRequest>(payload.clone()) {
        if req.target.is_image() {
            return SourceKind::Image;
        }
    }
    let ext = output_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "pdf" => SourceKind::Pdf,
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" => SourceKind::Image,
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "opus" => SourceKind::Audio,
        _ => SourceKind::Video,
    }
}
