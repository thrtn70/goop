//! PDF operations for Goop. Merge and split are pure-Rust via `lopdf`;
//! compress shells out to a bundled Ghostscript sidecar. All functions are
//! sync + blocking — callers run them on `spawn_blocking`.

pub mod compress;
pub mod delete_pages;
pub mod extract_images;
pub mod extract_pages;
pub mod extract_text;
pub mod images_to_pdf;
pub mod insert_blank;
pub mod merge;
pub mod metadata;
pub mod ocr;
pub mod ocr_image;
pub mod page_thumbs;
pub mod probe;
pub mod range_parser;
pub mod recognize;
pub mod reorder;
pub mod rotate;
pub mod split;

#[cfg(test)]
pub(crate) mod test_fixture;

use goop_core::GoopError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PdfError {
    #[error("pdf parse error: {0}")]
    Parse(String),
    #[error("pdf write error: {0}")]
    Write(String),
    #[error("invalid page range: {0}")]
    Range(String),
    #[error("no pages in output (all ranges excluded the document)")]
    EmptyOutput,
    #[error("ghostscript failed: {0}")]
    Ghostscript(String),
    #[error("mutool failed: {0}")]
    Mutool(String),
    #[error("mutool missing: {0}")]
    MutoolMissing(String),
    #[error("tesseract failed: {0}")]
    Tesseract(String),
    #[error("ocr pipeline error: {0}")]
    Ocr(String),
    /// The wrapped `String` is the requested language code (e.g. `"fra"`),
    /// not an OS error message. Raised when none of the configured tessdata
    /// search directories contain `<lang>.traineddata`.
    #[error("ocr language pack '{0}' not installed")]
    OcrMissingLang(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl From<PdfError> for GoopError {
    fn from(e: PdfError) -> Self {
        GoopError::Queue(e.to_string())
    }
}
