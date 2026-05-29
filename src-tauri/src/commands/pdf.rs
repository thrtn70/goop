use crate::state::AppState;
use goop_core::{path as gpath, IpcError, Job, JobId, JobKind, PdfOperation, PdfProbeResult};
use goop_pdf::{
    extract_text,
    page_thumbs::{cache_key, generate_page_thumbnails, PageThumbnailRequest},
    probe,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
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

/// Upper bound on characters returned to the Recognize page preview.
/// The pane is a glanceable preview, not a full document reader — a
/// multi-megabyte OCR result shouldn't be serialized across the IPC
/// boundary or rendered in one DOM node.
const RECOGNIZE_PREVIEW_CHAR_CAP: usize = 100_000;

/// Read-only text preview for the v0.2.7 "Recognize text" result pane.
///
/// For a `.txt` output it returns the file contents directly. For a
/// searchable-PDF output it extracts the freshly-added text layer via
/// the bundled mutool (instant — the layer is already there). The result
/// is capped at `RECOGNIZE_PREVIEW_CHAR_CAP` characters; callers that
/// need the full text should open the saved output file.
///
/// This does not run OCR and does not enqueue a job — it's a cheap,
/// synchronous-feeling read used to populate the preview after a
/// recognize job completes.
#[tauri::command]
pub async fn recognize_peek_text(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, IpcError> {
    let p = PathBuf::from(&path);
    let is_pdf = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);

    let text = if is_pdf {
        // Extract the text layer to a per-call unique temp file under the
        // OS temp dir (which the platform reclaims), read it back, then
        // best-effort delete. A unique name per invocation means two
        // concurrent peeks of the same source PDF never race on a shared
        // path, and we don't create the file ourselves (mutool does), so
        // there's no open-handle-vs-writer conflict on Windows.
        static PEEK_SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = PEEK_SEQ.fetch_add(1, Ordering::Relaxed);
        let out =
            std::env::temp_dir().join(format!("goop-recognize-{}-{}.txt", std::process::id(), seq));
        extract_text::extract_text(
            &state.resolver,
            &p,
            &out,
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .map_err(|e| IpcError::Unknown(e.to_string()))?;
        let body = tokio::fs::read_to_string(&out)
            .await
            .map_err(|e| IpcError::Unknown(e.to_string()))?;
        let _ = tokio::fs::remove_file(&out).await;
        body
    } else {
        tokio::fs::read_to_string(&p)
            .await
            .map_err(|e| IpcError::Unknown(e.to_string()))?
    };

    // Cap to the preview budget in a single pass, on a char boundary.
    Ok(match text.char_indices().nth(RECOGNIZE_PREVIEW_CHAR_CAP) {
        Some((byte_idx, _)) => text[..byte_idx].to_owned(),
        None => text,
    })
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
