//! PDF operations for Goop. Merge and split are pure-Rust via `lopdf`;
//! compress shells out to a bundled Ghostscript sidecar. All functions are
//! sync + blocking — callers run them on `spawn_blocking`.

pub mod compress;
pub mod merge;
pub mod probe;
pub mod range_parser;
pub mod split;

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
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl From<PdfError> for GoopError {
    fn from(e: PdfError) -> Self {
        GoopError::Queue(e.to_string())
    }
}
