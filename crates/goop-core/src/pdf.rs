use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Inclusive page range for `PdfOperation::Split`. `start` and `end` are
/// 1-indexed and `end >= start`. The range parser enforces this invariant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct PageRange {
    pub start: u32,
    pub end: u32,
}

/// Ghostscript preset for PDF compression. Maps to `-dPDFSETTINGS=/<name>`:
/// Screen = smallest/lowest quality (~72 dpi images), Ebook = medium
/// (~150 dpi), Printer = highest (~300 dpi).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum PdfQuality {
    Screen,
    Ebook,
    Printer,
}

/// What to do with a PDF. Merge takes multiple inputs and produces one
/// output; Split takes one input and produces one file per `PageRange`;
/// Compress re-encodes a single input via Ghostscript at the chosen quality.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PdfOperation {
    Merge {
        inputs: Vec<String>,
        output_path: String,
    },
    Split {
        input: String,
        ranges: Vec<PageRange>,
        output_dir: String,
    },
    Compress {
        input: String,
        output_path: String,
        quality: PdfQuality,
    },
}

/// Result of `pdf_probe` — used by the UI before it picks an operation so
/// range inputs know the page count bounds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct PdfProbeResult {
    pub pages: u32,
    pub bytes: u64,
}
