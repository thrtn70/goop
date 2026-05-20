use crate::state::AppState;
use goop_core::{ImageOperation, IpcError, Job, JobId, JobKind};
use serde::Serialize;
use tauri::State;
use ts_rs::TS;

/// Enqueue an `ImageOperation` as a `JobKind::Image` job. Returns the new
/// job id. Mirrors `commands::pdf::pdf_run` — payload is the JSON
/// serialization of `ImageOperation`, and the image worker (in
/// `src-tauri/src/lib.rs`) deserializes and dispatches per `kind`.
#[tauri::command]
pub async fn image_run(state: State<'_, AppState>, op: ImageOperation) -> Result<JobId, IpcError> {
    let payload = serde_json::to_value(&op).map_err(|e| IpcError::Unknown(e.to_string()))?;
    let job = Job::new(JobKind::Image, payload);
    let id = job.id;
    state.store.insert(&job)?;
    Ok(id)
}

/// Read-only support row for the Image Formats Settings section.
/// Mirrors the v0.2.4 `LanguagePack` shape so the section can reuse
/// the OcrLanguagesSection visual layout.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ImageFormatSupport {
    /// Human label (e.g. "HEIC / HEIF", "JPEG-XL").
    pub label: String,
    /// File extensions this row covers (e.g. `["heic", "heif"]`).
    pub extensions: Vec<String>,
    /// Free-form provenance string (e.g. "libheif 1.21", "image crate
    /// 0.25 feature: avif"). Surfaced as a small caption under the
    /// label so the user can confirm the format is bundled.
    pub provenance: String,
    /// Whether this row covers decode, encode, or both.
    pub capability: String,
}

/// Decoder status summary surfaced in Settings → Image Formats. The
/// version strings reflect the pinned dependency versions at build
/// time; goop bundles all decoders statically and doesn't ask the
/// user to install anything, so these are read-only.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ImageDecoderStatus {
    /// Bundled font for watermark rasterization.
    pub watermark_font: String,
    /// Per-format support rows.
    pub formats: Vec<ImageFormatSupport>,
    /// Free-form line about formats that are coming but not yet
    /// shipped. Surfaced below the table in the Settings UI.
    pub coming_soon: String,
}

#[tauri::command]
pub async fn image_decoders() -> Result<ImageDecoderStatus, IpcError> {
    // Pinned per Cargo.toml + the v0.2.5 Phase 0 format spike memo.
    // HEIC + JPEG-XL are deferred to v0.2.5.1 while the per-platform
    // CI bundling story is finished (apt-get / brew / vcpkg setup +
    // post-build dylib/DLL rewriting). The codepath surfaces a
    // friendly "not bundled in v0.2.5" error in the meantime.
    Ok(ImageDecoderStatus {
        watermark_font: "Roboto Regular (Apache-2.0)".into(),
        coming_soon: "HEIC, JPEG-XL, and camera RAW arrive in v0.2.5.1.".into(),
        formats: vec![
            ImageFormatSupport {
                label: "PNG".into(),
                extensions: vec!["png".into()],
                provenance: "image crate 0.25 (built-in)".into(),
                capability: "Decode + encode".into(),
            },
            ImageFormatSupport {
                label: "JPEG".into(),
                extensions: vec!["jpg".into(), "jpeg".into()],
                provenance: "image crate 0.25 (built-in)".into(),
                capability: "Decode + encode (DCTDecode in PDFs)".into(),
            },
            ImageFormatSupport {
                label: "WebP".into(),
                extensions: vec!["webp".into()],
                provenance: "image crate 0.25 (built-in)".into(),
                capability: "Decode + encode (lossless)".into(),
            },
            ImageFormatSupport {
                label: "BMP / GIF / TIFF".into(),
                extensions: vec!["bmp".into(), "gif".into(), "tiff".into(), "tif".into()],
                provenance: "image crate 0.25 (built-in)".into(),
                capability: "Decode + encode".into(),
            },
            ImageFormatSupport {
                label: "AVIF".into(),
                extensions: vec!["avif".into()],
                provenance: "image crate 0.25 + ravif (bundled)".into(),
                capability: "Decode + encode".into(),
            },
        ],
    })
}
