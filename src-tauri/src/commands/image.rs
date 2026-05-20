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
/// time; goop bundles the C libs and doesn't ask the user to
/// install anything, so these are read-only.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ImageDecoderStatus {
    /// libheif-rs / libheif-sys versions (the wrapper crate +
    /// bundled C lib version pinned via per-platform package
    /// manager in CI — apt-get on Ubuntu, brew on macOS, vcpkg
    /// on Windows).
    pub libheif_version: String,
    /// jpegxl-rs / libjxl versions (same pattern).
    pub libjxl_version: String,
    /// Bundled font for watermark rasterization.
    pub watermark_font: String,
    /// Per-format support rows.
    pub formats: Vec<ImageFormatSupport>,
}

#[tauri::command]
pub async fn image_decoders() -> Result<ImageDecoderStatus, IpcError> {
    // Pinned per Cargo.toml + the v0.2.5 Phase 0 format spike memo.
    // libheif is system-linked per platform (Ubuntu audit pins to
    // 1.17, macOS Homebrew + Windows vcpkg ship 1.21+) so we hedge
    // the displayed range rather than claim a specific build. libjxl
    // is vendored at 0.11 via jpegxl-rs's `vendored` feature so its
    // version is uniform across all release targets.
    Ok(ImageDecoderStatus {
        libheif_version: "libheif-rs 2.7 (libheif 1.17+, system-linked)".into(),
        libjxl_version: "jpegxl-rs 0.11 (libjxl 0.11, vendored)".into(),
        watermark_font: "Roboto Regular (Apache-2.0)".into(),
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
            ImageFormatSupport {
                label: "HEIC / HEIF".into(),
                extensions: vec!["heic".into(), "heif".into()],
                provenance: "libheif 1.21 (bundled via libheif-rs)".into(),
                capability: "Decode only".into(),
            },
            ImageFormatSupport {
                label: "JPEG-XL".into(),
                extensions: vec!["jxl".into()],
                provenance: "libjxl 0.11 (bundled via jpegxl-rs)".into(),
                capability: "Decode + encode".into(),
            },
        ],
    })
}
