use crate::PdfError;
use lopdf::{Document, Object};
use std::path::Path;

/// Reorder a PDF's pages according to `order`. The `order` slice must be
/// a permutation of `1..=N` where `N` is the input's page count — i.e.
/// every original page appears exactly once, in the desired new sequence.
///
/// The implementation rebuilds the Pages tree's Kids array in the new
/// order; page content streams and per-page resource references are not
/// touched, so the visual content of each page is preserved exactly.
///
/// Blocking — run on `spawn_blocking`.
pub fn reorder(input: &Path, order: &[u32], output_path: &Path) -> Result<(), PdfError> {
    if order.is_empty() {
        return Err(PdfError::Range("no order provided".into()));
    }
    let mut doc = Document::load(input).map_err(|e| PdfError::Parse(e.to_string()))?;
    let pages = doc.get_pages();
    let total = pages.len() as u32;
    validate_permutation(order, total)?;

    let pages_root_id = doc
        .catalog()
        .and_then(|cat| cat.get(b"Pages"))
        .and_then(|p| p.as_reference())
        .map_err(|e| PdfError::Parse(format!("locate /Pages root: {e}")))?;

    // Translate the 1-indexed permutation into the new ordering of
    // lopdf ObjectId references for the Kids array.
    let new_kids: Vec<Object> = order
        .iter()
        .map(|&p| Object::Reference(*pages.get(&p).expect("validated above")))
        .collect();

    {
        let pages_root = doc
            .get_object_mut(pages_root_id)
            .and_then(Object::as_dict_mut)
            .map_err(|e| PdfError::Write(format!("open /Pages root: {e}")))?;
        pages_root.set("Kids", Object::Array(new_kids));
        pages_root.set("Count", total as i64);
    }

    doc.compress();
    doc.save(output_path)
        .map_err(|e| PdfError::Write(e.to_string()))?;
    Ok(())
}

fn validate_permutation(order: &[u32], total: u32) -> Result<(), PdfError> {
    if order.len() as u32 != total {
        return Err(PdfError::Range(format!(
            "order length {} does not match page count {total}",
            order.len()
        )));
    }
    let mut seen = vec![false; total as usize];
    for &p in order {
        if p < 1 || p > total {
            return Err(PdfError::Range(format!(
                "page {p} out of range 1..={total}"
            )));
        }
        let idx = (p - 1) as usize;
        if seen[idx] {
            return Err(PdfError::Range(format!("page {p} appears twice in order")));
        }
        seen[idx] = true;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixture::write_blank_pdf;

    #[test]
    fn identity_permutation_preserves_page_count() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("five.pdf");
        write_blank_pdf(&input, 5);
        let out = tmp.path().join("out.pdf");
        reorder(&input, &[1, 2, 3, 4, 5], &out).unwrap();
        let loaded = Document::load(&out).unwrap();
        assert_eq!(loaded.get_pages().len(), 5);
    }

    #[test]
    fn reverse_permutation_swaps_first_and_last() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("five.pdf");
        write_blank_pdf(&input, 5);
        let out = tmp.path().join("out.pdf");
        reorder(&input, &[5, 4, 3, 2, 1], &out).unwrap();
        let loaded = Document::load(&out).unwrap();
        assert_eq!(loaded.get_pages().len(), 5);
    }

    #[test]
    fn rejects_duplicate_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("three.pdf");
        write_blank_pdf(&input, 3);
        let out = tmp.path().join("out.pdf");
        let err = reorder(&input, &[1, 2, 2], &out).unwrap_err();
        assert!(matches!(err, PdfError::Range(_)));
        let msg = err.to_string();
        assert!(msg.contains("twice"), "{msg}");
    }

    #[test]
    fn rejects_wrong_length() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("three.pdf");
        write_blank_pdf(&input, 3);
        let out = tmp.path().join("out.pdf");
        assert!(reorder(&input, &[1, 2], &out).is_err());
        assert!(reorder(&input, &[1, 2, 3, 4], &out).is_err());
    }

    #[test]
    fn rejects_out_of_range_page() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("three.pdf");
        write_blank_pdf(&input, 3);
        let out = tmp.path().join("out.pdf");
        assert!(reorder(&input, &[1, 2, 99], &out).is_err());
        assert!(reorder(&input, &[0, 1, 2], &out).is_err());
    }

    #[test]
    fn rejects_empty_order() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("x.pdf");
        write_blank_pdf(&input, 2);
        let out = tmp.path().join("out.pdf");
        assert!(reorder(&input, &[], &out).is_err());
    }
}
