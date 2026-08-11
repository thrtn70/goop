//! PDF OCR pipeline. Produces a multi-page searchable PDF from a
//! (typically scanned) input PDF.
//!
//! The bundled mutool ships without `HAVE_TESSERACT`, so this is a
//! three-stage pipeline rather than a single `mutool ocr` call:
//!
//!   1. `mutool draw -F png -o <tmp>/page-%d.png -r <dpi> -- <in.pdf>`
//!      rasterizes each page to a PNG at the chosen DPI. (mutool's
//!      pre-built binaries don't expose TIFF output, so PNG is the
//!      standard intermediate; tesseract accepts both equally.)
//!   2. For each PNG, `tesseract <page.png> <stem> -l <lang>
//!      --tessdata-dir <dir> pdf` produces a single-page searchable
//!      `<stem>.pdf`.
//!   3. `pdf_merge::merge` (reused from v0.2.3) combines per-page PDFs
//!      into the final output.
//!
//! Cancellation kills the in-flight subprocess and the temp dir drops
//! on the way out (RAII via `tempfile::TempDir`).
//!
//! Language pack resolution: caller passes the ordered tessdata search
//! dirs (user data dir first, bundled resource dir second). If the
//! requested `<lang>.traineddata` isn't found in either, the function
//! returns `PdfError::OcrMissingLang(lang)` before spawning anything.
//! That maps to a frontend toast steering the user to Settings →
//! OCR Languages.

use crate::{merge as pdf_merge, PdfError};
use goop_core::{JobId, PidGuard, PidRegistry};
use goop_sidecar::BinaryResolver;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

/// DPI for the TIFF rasterization stage. 300 is the standard OCR
/// resolution — high enough that tesseract's accuracy doesn't suffer,
/// low enough that 50-page PDFs don't fill the temp dir with GB of
/// intermediate TIFFs.
const OCR_RASTER_DPI: u32 = 300;

/// Run the OCR pipeline. Returns the path of the assembled searchable
/// PDF on success.
#[allow(clippy::too_many_arguments)]
pub async fn ocr(
    resolver: &BinaryResolver,
    tessdata_search_dirs: &[&Path],
    input: &Path,
    output_path: &Path,
    lang: &str,
    cancel: CancellationToken,
    pids: Option<Arc<dyn PidRegistry>>,
    job_id: Option<JobId>,
) -> Result<PathBuf, PdfError> {
    // Pre-flight: confirm the language pack exists in one of the search
    // dirs. Bail before spawning mutool so the user sees a clear
    // "language not installed" error rather than a tesseract failure
    // mid-pipeline.
    let tessdata_dir = tessdata_search_dirs
        .iter()
        .find(|d| d.join(format!("{lang}.traineddata")).exists())
        .copied()
        .ok_or_else(|| PdfError::OcrMissingLang(lang.to_string()))?;

    let mutool_bin = resolver
        .resolve("mutool")
        .map_err(|e| PdfError::MutoolMissing(format!("mutool: {e}")))?;
    let tesseract_bin = resolver
        .resolve("tesseract")
        .map_err(|e| PdfError::Tesseract(format!("tesseract missing: {e}")))?;

    let work_dir = tempfile::TempDir::new().map_err(PdfError::Io)?;
    let work = work_dir.path();

    // Stage 1: mutool draw -F png (mutool's pre-built binaries don't
    // expose TIFF output; PNG is the universal intermediate tesseract
    // accepts.)
    if cancel.is_cancelled() {
        return Err(PdfError::Ocr("cancelled before raster".into()));
    }
    let raster_template = work.join("page-%d.png");
    let mut draw = Command::new(&mutool_bin.path);
    draw.arg("draw")
        .arg("-F")
        .arg("png")
        .arg("-o")
        .arg(&raster_template)
        .arg("-r")
        .arg(OCR_RASTER_DPI.to_string())
        .arg("--")
        .arg(input);
    let mut draw_child = draw.spawn().map_err(PdfError::Io)?;
    let _draw_guard = match (pids.as_ref(), job_id, draw_child.id()) {
        (Some(reg), Some(id), Some(pid)) => Some(PidGuard::new(reg.clone(), id, pid)),
        _ => None,
    };
    tokio::select! {
        wait = draw_child.wait() => {
            let status = wait.map_err(PdfError::Io)?;
            if !status.success() {
                return Err(PdfError::Mutool(format!(
                    "mutool draw (OCR raster stage) exited with status {status}"
                )));
            }
        }
        _ = cancel.cancelled() => {
            let _ = draw_child.start_kill();
            let _ = draw_child.wait().await;
            return Err(PdfError::Ocr("cancelled during raster".into()));
        }
    }
    drop(_draw_guard);

    // Collect rasters in page order. Walk the temp dir on the blocking
    // pool — read_dir + per-entry stat are sync syscalls and we're
    // inside an async fn that lives on the Tokio executor.
    let work_owned = work.to_path_buf();
    let rasters: Vec<PathBuf> = tokio::task::spawn_blocking(move || {
        let mut paths: Vec<PathBuf> = std::fs::read_dir(&work_owned)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                name.starts_with("page-") && name.ends_with(".png")
            })
            .collect();
        paths.sort_by_key(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .and_then(|s| s.strip_prefix("page-"))
                .and_then(|s| s.split('.').next())
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(u32::MAX)
        });
        Ok::<_, std::io::Error>(paths)
    })
    .await
    .map_err(|e| PdfError::Ocr(e.to_string()))?
    .map_err(PdfError::Io)?;
    if rasters.is_empty() {
        return Err(PdfError::Ocr("mutool draw produced no rasters".into()));
    }

    // Stage 2: tesseract per page → per-page PDF.
    let mut page_pdfs: Vec<PathBuf> = Vec::with_capacity(rasters.len());
    for raster in &rasters {
        if cancel.is_cancelled() {
            return Err(PdfError::Ocr("cancelled during ocr".into()));
        }
        let stem = raster
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("page");
        let out_stem = work.join(format!("{stem}-ocr"));
        // tesseract writes <out_stem>.pdf when `tessedit_create_pdf=1`
        // is set. The shorthand `pdf` configfile arg only works when a
        // `pdf` configfile exists in the tessdata dir; tessdata_fast
        // doesn't bundle one, so we set the param directly via `-c`.
        // Pass --tessdata-dir and -l as separate argv tokens. tesseract
        // hand-rolls its argument parsing and never accepts the GNU
        // `--flag=value` form: given `--tessdata-dir=<path>` it takes the
        // whole token as the input filename and fails with "cannot read
        // input file". That holds on every platform, spaces or not.
        let mut tess = Command::new(&tesseract_bin.path);
        tess.arg(raster)
            .arg(&out_stem)
            .arg("--tessdata-dir")
            .arg(tessdata_dir)
            .arg("-l")
            .arg(lang)
            .arg("-c")
            .arg("tessedit_create_pdf=1");
        let mut tess_child = tess.spawn().map_err(PdfError::Io)?;
        let _tess_guard = match (pids.as_ref(), job_id, tess_child.id()) {
            (Some(reg), Some(id), Some(pid)) => Some(PidGuard::new(reg.clone(), id, pid)),
            _ => None,
        };
        tokio::select! {
            wait = tess_child.wait() => {
                let status = wait.map_err(PdfError::Io)?;
                if !status.success() {
                    return Err(PdfError::Tesseract(format!(
                        "tesseract exited with status {status} on {}",
                        raster.display()
                    )));
                }
            }
            _ = cancel.cancelled() => {
                let _ = tess_child.start_kill();
                let _ = tess_child.wait().await;
                return Err(PdfError::Ocr("cancelled during ocr".into()));
            }
        }
        let page_pdf = work.join(format!("{stem}-ocr.pdf"));
        if !page_pdf.exists() {
            return Err(PdfError::Tesseract(format!(
                "tesseract ran but {} was not written",
                page_pdf.display()
            )));
        }
        page_pdfs.push(page_pdf);
    }

    // Stage 3: merge per-page PDFs into the final output. lopdf merge
    // is sync — offload it (plus the dir-create) to the blocking pool.
    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(PdfError::Io)?;
    }
    let merge_pdfs = page_pdfs.clone();
    let merge_out = output_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let refs: Vec<&Path> = merge_pdfs.iter().map(|p| p.as_path()).collect();
        pdf_merge::merge(&refs, &merge_out)
    })
    .await
    .map_err(|e| PdfError::Ocr(e.to_string()))??;

    // work_dir drops here — temp TIFFs + per-page PDFs are cleaned up.
    Ok(output_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixture::write_blank_pdf;

    #[tokio::test]
    async fn missing_lang_pack_returns_specific_error() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("a.pdf");
        write_blank_pdf(&pdf, 1);
        let out = tmp.path().join("a-ocr.pdf");
        let empty_tessdata = tmp.path().join("empty-tessdata");
        std::fs::create_dir_all(&empty_tessdata).unwrap();
        let resolver = BinaryResolver::new(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("src-tauri/bin"),
        );
        let err = ocr(
            &resolver,
            &[empty_tessdata.as_path()],
            &pdf,
            &out,
            "xyz",
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PdfError::OcrMissingLang(l) if l == "xyz"));
    }

    #[tokio::test]
    #[ignore = "requires mutool + tesseract + eng.traineddata bundled in src-tauri/bin"]
    async fn ocrs_blank_pdf_to_searchable_pdf() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("blank.pdf");
        write_blank_pdf(&pdf, 1);
        let out = tmp.path().join("blank-ocr.pdf");
        let bin_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("src-tauri/bin");
        let tessdata_dir = bin_dir.join("tesseract-data");
        let resolver = BinaryResolver::new(bin_dir);
        let result = ocr(
            &resolver,
            &[tessdata_dir.as_path()],
            &pdf,
            &out,
            "eng",
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .expect("ocr must succeed");
        assert_eq!(result, out);
        // Reload the output and confirm it's a valid 1-page PDF.
        let doc = lopdf::Document::load(&out).expect("reload");
        assert_eq!(doc.get_pages().len(), 1);
    }
}
