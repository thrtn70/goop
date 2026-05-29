//! Smart "Recognize text" orchestration (v0.2.7 — "PDF as Text").
//!
//! This is the auto-detect layer the `extract_text` module's header
//! comment promised. It wraps the three existing text primitives
//! (`extract_text`, `ocr`, `ocr_image`) and picks the right one so the
//! user never has to know whether their PDF has a real text layer or is
//! a scanned image:
//!
//!   - **PDF, text layer present** → fast `mutool` extraction.
//!   - **PDF, scanned (no text layer)** → tesseract OCR pipeline.
//!   - **Image input** → always tesseract OCR.
//!
//! Detection follows the "try mutool first, fall back to OCR" approach:
//! we run the cheap `extract_text` probe, then classify on the average
//! non-whitespace characters per page. A truly scanned PDF yields
//! near-zero extracted text and falls under the threshold.
//!
//! The explicit `PdfOperation::ExtractText` / `PdfOcr` / `ImageOcr` ops
//! stay available for callers (PDF Studio power users) who want to force
//! a specific path — this module is purely additive orchestration.

use crate::{extract_text, ocr, ocr_image, probe, PdfError};
use goop_core::{pdf::ImageOcrOutput, JobId, PidRegistry};
use goop_sidecar::BinaryResolver;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Minimum average non-whitespace characters per page for a PDF to be
/// treated as having a usable text layer. Below this, we assume the
/// pages are scanned images and route to OCR.
///
/// 16 chars/page is deliberately low: even a sparse text layer (page
/// numbers, running headers) clears it, while a genuinely scanned PDF —
/// where `mutool convert -F text` extracts essentially nothing — falls
/// well under. Tunable; see docs/mutool-ocr-support.md.
const MIN_TEXT_LAYER_CHARS_PER_PAGE: usize = 16;

/// Which path the orchestrator took for a given input. Internal: it is
/// surfaced in unit tests and `tracing`, not across the IPC boundary
/// (`JobResult` carries no field for it and v0.2.7 doesn't add one).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecognizeMethod {
    /// PDF had an embedded text layer; used the fast mutool extraction.
    TextLayer,
    /// Scanned PDF or image input; ran the tesseract OCR pipeline.
    Ocr,
}

/// Classify a PDF as text-layer vs scanned from its extracted text and
/// page count. A pure function so the threshold logic is unit-testable
/// without spawning mutool. `pages` is clamped to at least 1 to avoid
/// division by zero on a malformed probe.
fn classify(extracted_text: &str, pages: u32) -> RecognizeMethod {
    let non_ws = extracted_text
        .chars()
        .filter(|c| !c.is_whitespace())
        .count();
    let pages = (pages.max(1)) as usize;
    if non_ws / pages >= MIN_TEXT_LAYER_CHARS_PER_PAGE {
        RecognizeMethod::TextLayer
    } else {
        RecognizeMethod::Ocr
    }
}

/// True if `path` has a `.pdf` extension (case-insensitive). Everything
/// else is treated as an image input bound for OCR.
fn is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

/// Run smart text recognition over `input`, writing the result to
/// `output_path`. `output_kind` selects `.txt` vs searchable-PDF output
/// exactly like `ocr_image`. Returns the output path plus the
/// `RecognizeMethod` actually taken (for logging / tests).
#[allow(clippy::too_many_arguments)]
pub async fn recognize_text(
    resolver: &BinaryResolver,
    tessdata_search_dirs: &[&Path],
    input: &Path,
    output_path: &Path,
    output_kind: ImageOcrOutput,
    lang: &str,
    cancel: CancellationToken,
    pids: Option<Arc<dyn PidRegistry>>,
    job_id: Option<JobId>,
) -> Result<(PathBuf, RecognizeMethod), PdfError> {
    if is_pdf(input) {
        recognize_pdf(
            resolver,
            tessdata_search_dirs,
            input,
            output_path,
            output_kind,
            lang,
            cancel,
            pids,
            job_id,
        )
        .await
    } else {
        // Image input is already a raster — always OCR.
        ocr_image::ocr_image(
            resolver,
            tessdata_search_dirs,
            &[input],
            output_path,
            output_kind,
            lang,
            cancel,
            pids,
            job_id,
        )
        .await?;
        Ok((output_path.to_path_buf(), RecognizeMethod::Ocr))
    }
}

/// PDF branch: probe the text layer, classify, then route to the right
/// primitive for the requested `output_kind`.
#[allow(clippy::too_many_arguments)]
async fn recognize_pdf(
    resolver: &BinaryResolver,
    tessdata_search_dirs: &[&Path],
    input: &Path,
    output_path: &Path,
    output_kind: ImageOcrOutput,
    lang: &str,
    cancel: CancellationToken,
    pids: Option<Arc<dyn PidRegistry>>,
    job_id: Option<JobId>,
) -> Result<(PathBuf, RecognizeMethod), PdfError> {
    // Page count via the lopdf probe (sync; run on the blocking pool).
    let input_owned = input.to_path_buf();
    let probe_res = tokio::task::spawn_blocking(move || probe::probe(&input_owned))
        .await
        // A JoinError here means the lopdf probe task panicked — surface it
        // as a parse failure (closest fit) rather than an OCR error.
        .map_err(|e| PdfError::Parse(e.to_string()))??;

    // Probe the text layer with the cheap mutool extraction.
    let work = tempfile::TempDir::new().map_err(PdfError::Io)?;
    let probe_txt = work.path().join("probe.txt");
    extract_text::extract_text(
        resolver,
        input,
        &probe_txt,
        cancel.clone(),
        pids.clone(),
        job_id,
    )
    .await?;
    let extracted = tokio::fs::read_to_string(&probe_txt)
        .await
        .map_err(PdfError::Io)?;
    let method = classify(&extracted, probe_res.pages);

    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(PdfError::Io)?;
    }

    match (method, output_kind) {
        // Text layer present, plain-text wanted: we already extracted it.
        (RecognizeMethod::TextLayer, ImageOcrOutput::Text) => {
            tokio::fs::write(output_path, extracted.as_bytes())
                .await
                .map_err(PdfError::Io)?;
        }
        // Text layer present, searchable PDF wanted: the input already
        // has a text layer, so it is already searchable — copy it to the
        // requested output location rather than re-OCRing it. Skip the
        // copy if the caller pointed output at the input itself (the UI
        // always picks a distinct dest, but guard against the self-copy
        // truncation hazard regardless).
        (RecognizeMethod::TextLayer, ImageOcrOutput::SearchablePdf) => {
            if input != output_path {
                tokio::fs::copy(input, output_path)
                    .await
                    .map_err(PdfError::Io)?;
            }
        }
        // Scanned, searchable PDF wanted: straight OCR pipeline.
        (RecognizeMethod::Ocr, ImageOcrOutput::SearchablePdf) => {
            ocr::ocr(
                resolver,
                tessdata_search_dirs,
                input,
                output_path,
                lang,
                cancel,
                pids,
                job_id,
            )
            .await?;
        }
        // Scanned, plain text wanted: OCR to a temp searchable PDF, then
        // extract its freshly-added text layer to the output .txt.
        (RecognizeMethod::Ocr, ImageOcrOutput::Text) => {
            let tmp_pdf = work.path().join("ocr.pdf");
            ocr::ocr(
                resolver,
                tessdata_search_dirs,
                input,
                &tmp_pdf,
                lang,
                cancel.clone(),
                pids.clone(),
                job_id,
            )
            .await?;
            extract_text::extract_text(resolver, &tmp_pdf, output_path, cancel, pids, job_id)
                .await?;
        }
    }

    Ok((output_path.to_path_buf(), method))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_text_rich_pdf_as_text_layer() {
        let text = "Lorem ipsum dolor sit amet consectetur ".repeat(20);
        assert_eq!(classify(&text, 2), RecognizeMethod::TextLayer);
    }

    #[test]
    fn classify_empty_extraction_as_ocr() {
        assert_eq!(classify("", 5), RecognizeMethod::Ocr);
        assert_eq!(classify("   \n  \t \n", 5), RecognizeMethod::Ocr);
    }

    #[test]
    fn classify_respects_per_page_threshold() {
        // Exactly the threshold on a single page → text layer.
        let exactly = "a".repeat(MIN_TEXT_LAYER_CHARS_PER_PAGE);
        assert_eq!(classify(&exactly, 1), RecognizeMethod::TextLayer);
        // One char below → OCR.
        let below = "a".repeat(MIN_TEXT_LAYER_CHARS_PER_PAGE - 1);
        assert_eq!(classify(&below, 1), RecognizeMethod::Ocr);
        // The same sparse text spread thin over many pages → OCR.
        let sparse = "a".repeat(MIN_TEXT_LAYER_CHARS_PER_PAGE);
        assert_eq!(classify(&sparse, 100), RecognizeMethod::Ocr);
    }

    #[test]
    fn classify_clamps_zero_pages_to_one() {
        // A malformed 0-page probe must not divide by zero.
        let text = "a".repeat(MIN_TEXT_LAYER_CHARS_PER_PAGE);
        assert_eq!(classify(&text, 0), RecognizeMethod::TextLayer);
    }

    #[test]
    fn is_pdf_is_case_insensitive() {
        assert!(is_pdf(Path::new("/x/doc.pdf")));
        assert!(is_pdf(Path::new("/x/DOC.PDF")));
        assert!(!is_pdf(Path::new("/x/photo.png")));
        assert!(!is_pdf(Path::new("/x/noext")));
    }

    #[tokio::test]
    async fn image_input_with_missing_lang_returns_specific_error() {
        // Image inputs route to ocr_image, which pre-flights the language
        // pack before touching tesseract — so an empty tessdata dir yields
        // OcrMissingLang without needing tesseract on the test machine.
        let tmp = tempfile::tempdir().unwrap();
        let img = tmp.path().join("white.png");
        let pixels = image::RgbImage::from_pixel(16, 16, image::Rgb([255, 255, 255]));
        image::DynamicImage::ImageRgb8(pixels).save(&img).unwrap();
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
        let err = recognize_text(
            &resolver,
            &[empty_tessdata.as_path()],
            &img,
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
}
