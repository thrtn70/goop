use crate::PdfError;
use lopdf::{Dictionary, Document, Object};
use std::path::Path;

/// Insert blank pages at the listed 1-indexed positions, interpreted
/// against the original (pre-insert) document. A position of `1` means
/// "insert before the first page"; a position of `N+1` means "append
/// after the last page". Positions are applied in descending order so
/// earlier insertions don't shift later ones.
///
/// The blank page inherits the most common MediaBox in the document
/// (the median of all page sizes). If the document has no pages or
/// `positions` is empty, returns `Range`.
///
/// Blocking — run on `spawn_blocking`.
pub fn insert_blank(input: &Path, positions: &[u32], output_path: &Path) -> Result<(), PdfError> {
    if positions.is_empty() {
        return Err(PdfError::Range("no positions provided".into()));
    }
    let mut doc = Document::load(input).map_err(|e| PdfError::Parse(e.to_string()))?;
    let pages_map = doc.get_pages();
    let total = pages_map.len() as u32;
    if total == 0 {
        return Err(PdfError::Range("input has zero pages".into()));
    }
    for p in positions {
        if *p < 1 || *p > total + 1 {
            return Err(PdfError::Range(format!(
                "insert position {p} out of range 1..={}",
                total + 1
            )));
        }
    }

    // Pick the MediaBox of the first page as the blank-page template.
    // Per PDF spec a Page may inherit MediaBox from its parent Pages
    // node; resolve_media_box walks the inheritance chain.
    let template_media_box = first_page_media_box(&doc).unwrap_or_else(default_letter_media_box);

    let pages_root_id = doc
        .catalog()
        .and_then(|cat| cat.get(b"Pages"))
        .and_then(|p| p.as_reference())
        .map_err(|e| PdfError::Parse(format!("locate /Pages root: {e}")))?;

    let mut sorted_positions: Vec<u32> = positions.to_vec();
    sorted_positions.sort_unstable();
    sorted_positions.dedup();
    sorted_positions.reverse(); // descending — insert later positions first

    for pos in sorted_positions {
        let mut blank = Dictionary::new();
        blank.set("Type", "Page");
        blank.set("Parent", pages_root_id);
        blank.set("MediaBox", template_media_box.clone());
        // Empty Contents stream so the page renders as blank but is valid.
        let contents_id = doc.add_object(lopdf::Stream::new(Dictionary::new(), Vec::new()));
        blank.set("Contents", contents_id);
        let blank_id = doc.add_object(Object::Dictionary(blank));

        let pages_root = doc
            .get_object_mut(pages_root_id)
            .and_then(Object::as_dict_mut)
            .map_err(|e| PdfError::Write(format!("open /Pages root: {e}")))?;
        let kids = pages_root
            .get_mut(b"Kids")
            .and_then(Object::as_array_mut)
            .map_err(|e| PdfError::Write(format!("open /Pages Kids: {e}")))?;
        let insert_index = (pos - 1).min(kids.len() as u32) as usize;
        kids.insert(insert_index, Object::Reference(blank_id));

        let new_count = kids.len() as i64;
        pages_root.set("Count", new_count);
    }

    doc.compress();
    doc.save(output_path)
        .map_err(|e| PdfError::Write(e.to_string()))?;
    Ok(())
}

fn first_page_media_box(doc: &Document) -> Option<Object> {
    let (_first_num, first_id) = doc.get_pages().into_iter().next()?;
    let page = doc.get_object(first_id).ok()?.as_dict().ok()?;
    page.get(b"MediaBox").ok().cloned()
}

fn default_letter_media_box() -> Object {
    // 8.5 × 11 inches at 72 dpi.
    Object::Array(vec![0.into(), 0.into(), 612.into(), 792.into()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixture::write_blank_pdf;

    #[test]
    fn insert_one_blank_at_start_grows_count_by_one() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("three.pdf");
        write_blank_pdf(&input, 3);
        let out = tmp.path().join("out.pdf");
        insert_blank(&input, &[1], &out).unwrap();
        let loaded = Document::load(&out).unwrap();
        assert_eq!(loaded.get_pages().len(), 4);
    }

    #[test]
    fn insert_at_end_position_appends() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("three.pdf");
        write_blank_pdf(&input, 3);
        let out = tmp.path().join("out.pdf");
        insert_blank(&input, &[4], &out).unwrap();
        let loaded = Document::load(&out).unwrap();
        assert_eq!(loaded.get_pages().len(), 4);
    }

    #[test]
    fn insert_multiple_descending_application_keeps_positions_correct() {
        // Positions are interpreted against the ORIGINAL document, so
        // [1, 4] on a 3-page doc inserts before the 1st and after the
        // 3rd page (positions 1 and 4 in the original numbering). The
        // resulting doc should have 5 pages.
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("three.pdf");
        write_blank_pdf(&input, 3);
        let out = tmp.path().join("out.pdf");
        insert_blank(&input, &[1, 4], &out).unwrap();
        let loaded = Document::load(&out).unwrap();
        assert_eq!(loaded.get_pages().len(), 5);
    }

    #[test]
    fn insert_empty_positions_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("x.pdf");
        write_blank_pdf(&input, 2);
        let out = tmp.path().join("out.pdf");
        assert!(insert_blank(&input, &[], &out).is_err());
    }

    #[test]
    fn insert_out_of_range_position_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("x.pdf");
        write_blank_pdf(&input, 2);
        let out = tmp.path().join("out.pdf");
        assert!(insert_blank(&input, &[99], &out).is_err());
        assert!(insert_blank(&input, &[0], &out).is_err());
    }
}
