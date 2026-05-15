use crate::state::AppState;
use goop_core::{path as gpath, IpcError, Job, JobId, JobKind, PdfOperation, PdfProbeResult};
use goop_pdf::{
    page_thumbs::{cache_key, generate_page_thumbnails, PageThumbnailRequest},
    probe,
};
use std::path::PathBuf;
use tauri::State;
use tokio_util::sync::CancellationToken;

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

/// Render one PNG thumbnail per page of the input PDF via the bundled
/// mutool sidecar. Cached on a sha256-free SipHash of
/// `(canonical_path, mtime_nanos)` under
/// `<data_dir>/page-thumbs/<cache_key>/page-N.png`; a cache hit returns
/// the existing paths without re-spawning mutool.
///
/// Used by the v0.2.3 page-grid UI for reorder/delete/rotate/insert
/// flows. Resolves to file:// paths the WebView loads via the
/// `assetProtocol` (scope extended in tauri.conf.json).
#[tauri::command]
pub async fn pdf_page_thumbs(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<String>, IpcError> {
    let input = PathBuf::from(&path);
    let probed = {
        let p = input.clone();
        tokio::task::spawn_blocking(move || probe::probe(&p))
            .await
            .map_err(|e| IpcError::Unknown(e.to_string()))?
            .map_err(|e| IpcError::Unknown(e.to_string()))?
    };
    let key = cache_key(&input);
    let output_dir = gpath::data_dir().join("page-thumbs").join(&key);

    // Cache hit: every page-N.png already on disk for the expected
    // page count. Skip the mutool spawn entirely.
    if (1..=probed.pages).all(|n| output_dir.join(format!("page-{n}.png")).is_file()) {
        return Ok((1..=probed.pages)
            .map(|n| {
                output_dir
                    .join(format!("page-{n}.png"))
                    .to_string_lossy()
                    .into_owned()
            })
            .collect());
    }

    let req = PageThumbnailRequest {
        input,
        pages: probed.pages,
        output_dir: output_dir.clone(),
        dpi: 50,
    };
    let out = generate_page_thumbnails(&state.resolver, req, CancellationToken::new(), None, None)
        .await
        .map_err(|e| IpcError::Unknown(e.to_string()))?;
    Ok(out
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}
