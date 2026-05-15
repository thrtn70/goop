use crate::PdfError;
use goop_core::PageRange;
use lopdf::Document;
use std::path::Path;

/// Extract the pages covered by `ranges` (union) into a single PDF. Unlike
/// `split` which produces one file per range, this collapses to one output.
///
/// Ranges may overlap or be unsorted — they're deduplicated into a single
/// keep-set before pages outside it are dropped. All ranges are inclusive
/// and 1-indexed; the parser elsewhere enforces `end >= start`.
///
/// Blocking — run on `spawn_blocking`.
pub fn extract_pages(
    input: &Path,
    ranges: &[PageRange],
    output_path: &Path,
) -> Result<(), PdfError> {
    if ranges.is_empty() {
        return Err(PdfError::Range("no ranges provided".into()));
    }
    let mut doc = Document::load(input).map_err(|e| PdfError::Parse(e.to_string()))?;
    let pages = doc.get_pages();
    let total = pages.len() as u32;

    let keep: std::collections::BTreeSet<u32> = ranges
        .iter()
        .flat_map(|r| r.start..=r.end)
        .filter(|p| (1..=total).contains(p))
        .collect();
    if keep.is_empty() {
        return Err(PdfError::Range(
            "ranges select no pages within the document".into(),
        ));
    }

    let drop_ids: Vec<u32> = pages
        .into_iter()
        .filter(|(num, _)| !keep.contains(num))
        .map(|(num, _)| num)
        .collect();
    if drop_ids.len() as u32 == total {
        return Err(PdfError::EmptyOutput);
    }
    doc.delete_pages(&drop_ids);
    doc.compress();

    doc.save(output_path)
        .map_err(|e| PdfError::Write(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixture::write_blank_pdf;

    #[test]
    fn extract_two_disjoint_ranges_produces_four_page_output() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("five.pdf");
        write_blank_pdf(&input, 5);

        let out = tmp.path().join("out.pdf");
        extract_pages(
            &input,
            &[
                PageRange { start: 1, end: 2 },
                PageRange { start: 4, end: 5 },
            ],
            &out,
        )
        .unwrap();

        let loaded = Document::load(&out).unwrap();
        assert_eq!(loaded.get_pages().len(), 4);
    }

    #[test]
    fn extract_overlapping_ranges_deduplicates_into_union() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("ten.pdf");
        write_blank_pdf(&input, 10);

        let out = tmp.path().join("out.pdf");
        extract_pages(
            &input,
            &[
                PageRange { start: 1, end: 5 },
                PageRange { start: 4, end: 7 },
            ],
            &out,
        )
        .unwrap();

        let loaded = Document::load(&out).unwrap();
        assert_eq!(loaded.get_pages().len(), 7, "1..=7 deduplicated, 7 pages");
    }

    #[test]
    fn extract_empty_ranges_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("x.pdf");
        write_blank_pdf(&input, 3);
        let out = tmp.path().join("out.pdf");
        assert!(extract_pages(&input, &[], &out).is_err());
    }

    #[test]
    fn extract_out_of_range_only_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("x.pdf");
        write_blank_pdf(&input, 3);
        let out = tmp.path().join("out.pdf");
        assert!(extract_pages(
            &input,
            &[PageRange {
                start: 99,
                end: 100
            }],
            &out
        )
        .is_err());
    }
}
