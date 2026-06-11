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
    /// Human label (e.g. "JPEG-XL", "AVIF").
    pub label: String,
    /// File extensions this row covers (e.g. `["jpg", "jpeg"]`).
    pub extensions: Vec<String>,
    /// Free-form provenance string (e.g. "libjxl 0.11", "image crate
    /// 0.25 feature: avif"). Surfaced as a small caption under the
    /// label so the user can confirm the format is bundled.
    pub provenance: String,
    /// Whether this row covers decode, encode, or both.
    pub capability: String,
}

/// Decoder status summary surfaced in Settings → Image Formats. The
/// version strings reflect the pinned dependency versions at build
/// time; goop statically links the C libs and doesn't ask the user to
/// install anything, so these are read-only.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ImageDecoderStatus {
    /// libheif + libde265 versions (v0.2.8: statically linked,
    /// decode-only). macOS/Linux pin exact versions via
    /// scripts/build-static-heif-deps.sh; Windows builds from vcpkg's
    /// current libheif port, so the string hedges there.
    pub libheif_version: String,
    /// jpegxl-rs / libjxl versions (libjxl 0.11 built from vendored
    /// source via jpegxl-rs's `vendored` feature — statically linked
    /// into goop's binary, identical across all release targets).
    pub libjxl_version: String,
    /// Bundled font for watermark rasterization.
    pub watermark_font: String,
    /// Per-format support rows.
    pub formats: Vec<ImageFormatSupport>,
}

#[tauri::command]
pub async fn image_decoders() -> Result<ImageDecoderStatus, IpcError> {
    // Pinned per Cargo.toml + scripts/build-static-heif-deps.sh.
    // libjxl is vendored at 0.11 via jpegxl-rs's `vendored` feature;
    // libheif + libde265 are statically linked (decode-only, v0.2.8).
    // Windows resolves libheif via vcpkg's port, which tracks its own
    // version — hedge the displayed string there.
    Ok(ImageDecoderStatus {
        libheif_version: if cfg!(windows) {
            "libheif (vcpkg, static, decode-only)".into()
        } else {
            "libheif 1.23.0 + libde265 1.1.1 (static, decode-only)".into()
        },
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
                provenance: "libheif + libde265 (statically linked)".into(),
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
