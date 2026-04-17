use crate::PdfError;
use goop_core::PdfProbeResult;
use lopdf::Document;
use std::path::Path;

/// Read a PDF file's page count and on-disk byte size. Used by the UI to
/// validate range inputs and display context for merge/split/compress.
pub fn probe(path: &Path) -> Result<PdfProbeResult, PdfError> {
    let bytes = std::fs::metadata(path)?.len();
    let doc = Document::load(path).map_err(|e| PdfError::Parse(e.to_string()))?;
    let pages = doc.get_pages().len() as u32;
    Ok(PdfProbeResult { pages, bytes })
}
