//! OCR over one or more image inputs (PNG / JPEG). Output is either
//! a multi-page searchable PDF or a single concatenated `.txt`.
//!
//! Skips the mutool rasterization stage that `ocr.rs` uses for PDF
//! inputs — the user-supplied images are already rasters, so we pipe
//! them straight to tesseract.
//!
//! For `SearchablePdf` output: each image → per-image searchable PDF
//! via `tesseract <img> <stem> -c tessedit_create_pdf=1` → `pdf_merge`
//! combines them into the final output, one image per page.
//!
//! For `Text` output: each image → per-image `.txt` via plain
//! `tesseract <img> <stem>` → concatenate text files with a blank
//! line separator into the final output.
//!
//! Same tessdata search-dir resolution + pre-flight as `ocr.rs`.

use crate::{merge as pdf_merge, PdfError};
use goop_core::{pdf::ImageOcrOutput, JobId, PidGuard, PidRegistry};
use goop_sidecar::BinaryResolver;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

/// Run image OCR. `inputs` are image file paths, processed in order.
/// `output_kind` selects between text and searchable-PDF output.
#[allow(clippy::too_many_arguments)]
pub async fn ocr_image(
    resolver: &BinaryResolver,
    tessdata_search_dirs: &[&Path],
    inputs: &[&Path],
    output_path: &Path,
    output_kind: ImageOcrOutput,
    lang: &str,
    cancel: CancellationToken,
    pids: Option<Arc<dyn PidRegistry>>,
    job_id: Option<JobId>,
) -> Result<PathBuf, PdfError> {
    if inputs.is_empty() {
        return Err(PdfError::Range("no input images".into()));
    }
    let tessdata_dir = tessdata_search_dirs
        .iter()
        .find(|d| d.join(format!("{lang}.traineddata")).exists())
        .copied()
        .ok_or_else(|| PdfError::OcrMissingLang(lang.to_string()))?;
    let tesseract_bin = resolver
        .resolve("tesseract")
        .map_err(|e| PdfError::Tesseract(format!("tesseract missing: {e}")))?;

    let work_dir = tempfile::TempDir::new().map_err(PdfError::Io)?;
    let work = work_dir.path();

    let mut produced: Vec<PathBuf> = Vec::with_capacity(inputs.len());
    for (idx, image) in inputs.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(PdfError::Ocr("cancelled during ocr".into()));
        }
        let out_stem = work.join(format!("image-{}", idx + 1));
        let mut tess = Command::new(&tesseract_bin.path);
        tess.arg(image)
            .arg(&out_stem)
            .arg("--tessdata-dir")
            .arg(tessdata_dir)
            .arg("-l")
            .arg(lang);
        // tesseract writes <stem>.txt by default; pass tessedit_create_pdf=1
        // when we want <stem>.pdf instead. See ocr.rs for the rationale on
        // why `-c` is used over the `pdf` configfile shorthand.
        if matches!(output_kind, ImageOcrOutput::SearchablePdf) {
            tess.arg("-c").arg("tessedit_create_pdf=1");
        }
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
                        image.display()
                    )));
                }
            }
            _ = cancel.cancelled() => {
                let _ = tess_child.start_kill();
                let _ = tess_child.wait().await;
                return Err(PdfError::Ocr("cancelled during ocr".into()));
            }
        }
        let written = match output_kind {
            ImageOcrOutput::SearchablePdf => work.join(format!("image-{}.pdf", idx + 1)),
            ImageOcrOutput::Text => work.join(format!("image-{}.txt", idx + 1)),
        };
        if !written.exists() {
            return Err(PdfError::Tesseract(format!(
                "tesseract ran but {} was not written",
                written.display()
            )));
        }
        produced.push(written);
    }

    // Combine per-image outputs into the requested final form. Both the
    // lopdf merge and the per-file read/write loop are sync — offload to
    // the blocking pool so we don't stall the runtime thread.
    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(PdfError::Io)?;
    }
    let out_owned = output_path.to_path_buf();
    let produced_owned = produced.clone();
    tokio::task::spawn_blocking(move || -> Result<(), PdfError> {
        match output_kind {
            ImageOcrOutput::SearchablePdf => {
                let refs: Vec<&Path> = produced_owned.iter().map(|p| p.as_path()).collect();
                pdf_merge::merge(&refs, &out_owned)?;
            }
            ImageOcrOutput::Text => {
                let mut combined = String::new();
                for (i, txt) in produced_owned.iter().enumerate() {
                    if i > 0 {
                        combined.push_str("\n\n");
                    }
                    let body = std::fs::read_to_string(txt).map_err(PdfError::Io)?;
                    combined.push_str(body.trim_end_matches('\n'));
                }
                std::fs::write(&out_owned, combined).map_err(PdfError::Io)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| PdfError::Ocr(e.to_string()))??;

    Ok(output_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    /// 64x64 white image with the word "TEST" drawn — enough for
    /// tesseract to (sometimes) recognize. Local-only integration
    /// test; correctness of the OCR text is not asserted because
    /// tessdata_fast can be jittery on tiny synthetic inputs.
    fn write_white_png(path: &Path) {
        let img = image::RgbImage::from_fn(64, 64, |_, _| image::Rgb([255, 255, 255]));
        let file = std::fs::File::create(path).unwrap();
        let mut writer = std::io::BufWriter::new(file);
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut writer, image::ImageFormat::Png)
            .unwrap();
        writer.flush().unwrap();
    }

    #[tokio::test]
    async fn errors_on_empty_inputs() {
        let tmp = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(std::path::PathBuf::from("/nonexistent"));
        let err = ocr_image(
            &resolver,
            &[],
            &[],
            &tmp.path().join("out.txt"),
            ImageOcrOutput::Text,
            "eng",
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PdfError::Range(_)));
    }

    #[tokio::test]
    async fn missing_lang_pack_returns_specific_error() {
        let tmp = TempDir::new().unwrap();
        let img = tmp.path().join("white.png");
        write_white_png(&img);
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
        let err = ocr_image(
            &resolver,
            &[empty_tessdata.as_path()],
            &[img.as_path()],
            &tmp.path().join("out.txt"),
            ImageOcrOutput::Text,
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
    #[ignore = "requires tesseract + eng.traineddata bundled in src-tauri/bin"]
    async fn produces_text_output_for_single_image() {
        let tmp = TempDir::new().unwrap();
        let img = tmp.path().join("white.png");
        write_white_png(&img);
        let out = tmp.path().join("out.txt");
        let tessdata_dir = crate::test_fixture::bundled_tessdata_dir();
        let links = tmp.path().join("bin");
        std::fs::create_dir_all(&links).unwrap();
        let resolver = crate::test_fixture::bundled_resolver(&links);
        crate::test_fixture::require_bundled(&resolver, "tesseract");
        let result = ocr_image(
            &resolver,
            &[tessdata_dir.as_path()],
            &[img.as_path()],
            &out,
            ImageOcrOutput::Text,
            "eng",
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .expect("ocr must succeed");
        assert_eq!(result, out);
        assert!(out.exists());
    }
}
