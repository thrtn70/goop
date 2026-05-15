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

/// Clockwise rotation applied to a PDF page. The PDF spec stores `/Rotate`
/// in 90-degree increments; only these three are useful (0 is no-op).
/// The backend composes the new rotation with any existing `/Rotate` value
/// modulo 360, so a single rotation that lands a page back at 0 is fine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum RotationDegrees {
    Cw90,
    Cw180,
    Cw270,
}

/// Per-page rotation override. `page` is 1-indexed. Pages not listed in a
/// `PdfOperation::Rotate.rotations` vector are left untouched — so a
/// "rotate all 90°" UI affordance expands to `(1..=N).map(|p| PageRotation
/// { page: p, rotation: Cw90 })`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct PageRotation {
    pub page: u32,
    pub rotation: RotationDegrees,
}

/// Subset of PDF `/Info` dictionary fields exposed to the UI. `None` for a
/// field means "leave existing value untouched"; `Some("")` clears it.
/// PDF creation/modification date timestamps are managed by the writer and
/// not user-editable here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct PdfMetadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
}

/// What to do with a PDF. The original three ops (Merge, Split, Compress)
/// retain their wire shape — adding variants is additive only.
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
    /// Keep only the pages covered by `ranges` (union), output one PDF.
    /// Compared to Split which produces N files, ExtractPages produces 1.
    ExtractPages {
        input: String,
        ranges: Vec<PageRange>,
        output_path: String,
    },
    /// Per-page clockwise rotation. Pages not in `rotations` keep their
    /// existing `/Rotate` value.
    Rotate {
        input: String,
        rotations: Vec<PageRotation>,
        output_path: String,
    },
    /// New page order. `order` is a 1-indexed permutation of `1..=N` where
    /// `N` is the input's page count. The backend validates the permutation
    /// before reordering.
    Reorder {
        input: String,
        order: Vec<u32>,
        output_path: String,
    },
    /// Drop the listed 1-indexed pages. Equivalent to ExtractPages with the
    /// complementary ranges, but spelled to match user mental model.
    DeletePages {
        input: String,
        pages: Vec<u32>,
        output_path: String,
    },
    /// Insert blank pages at each 1-indexed position (positions interpreted
    /// against the original document; the backend applies them in
    /// descending order so earlier insertions don't shift later ones).
    InsertBlank {
        input: String,
        positions: Vec<u32>,
        output_path: String,
    },
    /// Replace selected fields of the PDF's `/Info` dictionary. Fields set
    /// to `None` are left alone; fields set to `Some("")` clear the value.
    SetMetadata {
        input: String,
        metadata: PdfMetadata,
        output_path: String,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn roundtrip(op: &PdfOperation) -> PdfOperation {
        let v = serde_json::to_value(op).expect("serialize");
        serde_json::from_value(v).expect("deserialize")
    }

    #[test]
    fn extract_pages_serializes_with_snake_case_kind() {
        let op = PdfOperation::ExtractPages {
            input: "/in.pdf".into(),
            ranges: vec![PageRange { start: 1, end: 3 }],
            output_path: "/out.pdf".into(),
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["kind"], json!("extract_pages"));
        assert_eq!(op, roundtrip(&op));
    }

    #[test]
    fn rotate_serializes_with_snake_case_kind_and_rotation_variants() {
        let op = PdfOperation::Rotate {
            input: "/in.pdf".into(),
            rotations: vec![
                PageRotation {
                    page: 1,
                    rotation: RotationDegrees::Cw90,
                },
                PageRotation {
                    page: 2,
                    rotation: RotationDegrees::Cw180,
                },
                PageRotation {
                    page: 3,
                    rotation: RotationDegrees::Cw270,
                },
            ],
            output_path: "/out.pdf".into(),
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["kind"], json!("rotate"));
        assert_eq!(v["rotations"][0]["rotation"], json!("cw90"));
        assert_eq!(v["rotations"][1]["rotation"], json!("cw180"));
        assert_eq!(v["rotations"][2]["rotation"], json!("cw270"));
        assert_eq!(op, roundtrip(&op));
    }

    #[test]
    fn reorder_carries_permutation_vector() {
        let op = PdfOperation::Reorder {
            input: "/in.pdf".into(),
            order: vec![3, 1, 2],
            output_path: "/out.pdf".into(),
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["kind"], json!("reorder"));
        assert_eq!(v["order"], json!([3, 1, 2]));
        assert_eq!(op, roundtrip(&op));
    }

    #[test]
    fn delete_pages_serializes_with_snake_case_kind() {
        let op = PdfOperation::DeletePages {
            input: "/in.pdf".into(),
            pages: vec![2, 4],
            output_path: "/out.pdf".into(),
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["kind"], json!("delete_pages"));
        assert_eq!(op, roundtrip(&op));
    }

    #[test]
    fn insert_blank_serializes_with_snake_case_kind() {
        let op = PdfOperation::InsertBlank {
            input: "/in.pdf".into(),
            positions: vec![1, 4],
            output_path: "/out.pdf".into(),
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["kind"], json!("insert_blank"));
        assert_eq!(op, roundtrip(&op));
    }

    #[test]
    fn set_metadata_carries_subset_of_info_fields() {
        let op = PdfOperation::SetMetadata {
            input: "/in.pdf".into(),
            metadata: PdfMetadata {
                title: Some("Hello".into()),
                author: None,
                subject: Some("".into()),
                keywords: None,
            },
            output_path: "/out.pdf".into(),
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["kind"], json!("set_metadata"));
        assert_eq!(v["metadata"]["title"], json!("Hello"));
        assert_eq!(v["metadata"]["author"], json!(null));
        assert_eq!(v["metadata"]["subject"], json!(""));
        assert_eq!(op, roundtrip(&op));
    }

    #[test]
    fn existing_variants_still_serialize_with_original_wire_shape() {
        // Lock the original three op kinds against accidental discriminator
        // drift when adding new variants.
        let merge = PdfOperation::Merge {
            inputs: vec!["/a.pdf".into(), "/b.pdf".into()],
            output_path: "/out.pdf".into(),
        };
        assert_eq!(
            serde_json::to_value(&merge).unwrap()["kind"],
            json!("merge")
        );

        let split = PdfOperation::Split {
            input: "/in.pdf".into(),
            ranges: vec![PageRange { start: 1, end: 5 }],
            output_dir: "/out".into(),
        };
        assert_eq!(
            serde_json::to_value(&split).unwrap()["kind"],
            json!("split")
        );

        let compress = PdfOperation::Compress {
            input: "/in.pdf".into(),
            output_path: "/out.pdf".into(),
            quality: PdfQuality::Ebook,
        };
        assert_eq!(
            serde_json::to_value(&compress).unwrap()["kind"],
            json!("compress")
        );
    }
}
