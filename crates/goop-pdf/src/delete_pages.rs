use crate::PdfError;
use lopdf::Document;
use std::path::Path;

/// Drop the listed 1-indexed pages and save the rest. Equivalent to
/// `extract_pages` with the complementary ranges, but spelled to match
/// user mental model ("remove these pages").
///
/// Validates each page is within `1..=N`. Duplicates in `pages` are
/// tolerated. Deleting all pages errors with `EmptyOutput`.
///
/// Blocking — run on `spawn_blocking`.
pub fn delete_pages(input: &Path, pages: &[u32], output_path: &Path) -> Result<(), PdfError> {
    if pages.is_empty() {
        return Err(PdfError::Range("no pages provided".into()));
    }
    let mut doc = Document::load(input).map_err(|e| PdfError::Parse(e.to_string()))?;
    let total = doc.get_pages().len() as u32;
    for p in pages {
        if *p < 1 || *p > total {
            return Err(PdfError::Range(format!(
                "page {p} out of range 1..={total}"
            )));
        }
    }
    let unique: std::collections::BTreeSet<u32> = pages.iter().copied().collect();
    if unique.len() as u32 == total {
        return Err(PdfError::EmptyOutput);
    }
    let drop_ids: Vec<u32> = unique.into_iter().collect();
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
    fn delete_two_pages_from_five_keeps_three() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("five.pdf");
        write_blank_pdf(&input, 5);

        let out = tmp.path().join("out.pdf");
        delete_pages(&input, &[2, 4], &out).unwrap();
        let loaded = Document::load(&out).unwrap();
        assert_eq!(loaded.get_pages().len(), 3);
    }

    #[test]
    fn delete_duplicates_tolerated() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("four.pdf");
        write_blank_pdf(&input, 4);

        let out = tmp.path().join("out.pdf");
        delete_pages(&input, &[2, 2, 2], &out).unwrap();
        let loaded = Document::load(&out).unwrap();
        assert_eq!(loaded.get_pages().len(), 3);
    }

    #[test]
    fn delete_out_of_range_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("x.pdf");
        write_blank_pdf(&input, 3);
        let out = tmp.path().join("out.pdf");
        assert!(delete_pages(&input, &[5], &out).is_err());
        assert!(delete_pages(&input, &[0], &out).is_err());
    }

    #[test]
    fn delete_all_pages_errors_with_empty_output() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("x.pdf");
        write_blank_pdf(&input, 2);
        let out = tmp.path().join("out.pdf");
        let err = delete_pages(&input, &[1, 2], &out).unwrap_err();
        assert!(matches!(err, PdfError::EmptyOutput));
    }
}
