use crate::PdfError;
use goop_core::PageRange;
use lopdf::Document;
use std::path::{Path, PathBuf};

/// Split a PDF into one file per range. Output files are named
/// `<source-stem>-<start>-<end>.pdf` in `output_dir`.
///
/// Blocking — run on `spawn_blocking`. Each extracted range produces a new
/// `Document` with only the pages in that range.
pub fn split(
    input: &Path,
    ranges: &[PageRange],
    output_dir: &Path,
) -> Result<Vec<PathBuf>, PdfError> {
    if ranges.is_empty() {
        return Err(PdfError::Range("no ranges provided".into()));
    }
    std::fs::create_dir_all(output_dir)?;
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("pdf")
        .to_string();

    let mut outputs = Vec::with_capacity(ranges.len());
    for range in ranges {
        let mut doc = Document::load(input).map_err(|e| PdfError::Parse(e.to_string()))?;
        let pages = doc.get_pages();
        let keep: std::collections::BTreeSet<u32> = (range.start..=range.end).collect();
        let drop_ids: Vec<u32> = pages
            .into_iter()
            .filter(|(num, _)| !keep.contains(num))
            .map(|(num, _)| num)
            .collect();
        if drop_ids.len() as i64 == doc.get_pages().len() as i64 {
            return Err(PdfError::EmptyOutput);
        }
        doc.delete_pages(&drop_ids);
        doc.compress();

        let out_path = output_dir.join(format!("{stem}-{}-{}.pdf", range.start, range.end));
        doc.save(&out_path)
            .map_err(|e| PdfError::Write(e.to_string()))?;
        outputs.push(out_path);
    }
    Ok(outputs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merge;

    fn fixture(path: &Path, page_count: u32) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut page_ids = Vec::new();
        for _ in 0..page_count {
            let page_id = doc.new_object_id();
            let mut page = lopdf::Dictionary::new();
            page.set("Type", "Page");
            page.set("Parent", pages_id);
            page.set(
                "MediaBox",
                lopdf::Object::Array(vec![0.into(), 0.into(), 612.into(), 792.into()]),
            );
            doc.objects.insert(page_id, lopdf::Object::Dictionary(page));
            page_ids.push(lopdf::Object::Reference(page_id));
        }
        let mut pages = lopdf::Dictionary::new();
        pages.set("Type", "Pages");
        pages.set("Kids", lopdf::Object::Array(page_ids));
        pages.set("Count", page_count as i64);
        doc.objects
            .insert(pages_id, lopdf::Object::Dictionary(pages));
        let catalog_id = doc.new_object_id();
        let mut catalog = lopdf::Dictionary::new();
        catalog.set("Type", "Catalog");
        catalog.set("Pages", pages_id);
        doc.objects
            .insert(catalog_id, lopdf::Object::Dictionary(catalog));
        doc.trailer.set("Root", catalog_id);
        doc.save(path).unwrap();
    }

    #[test]
    fn split_five_pages_into_two_ranges() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("five.pdf");
        fixture(&input, 5);

        let outputs = split(
            &input,
            &[
                PageRange { start: 1, end: 2 },
                PageRange { start: 4, end: 5 },
            ],
            tmp.path(),
        )
        .unwrap();
        assert_eq!(outputs.len(), 2);

        let a = Document::load(&outputs[0]).unwrap();
        let b = Document::load(&outputs[1]).unwrap();
        assert_eq!(a.get_pages().len(), 2);
        assert_eq!(b.get_pages().len(), 2);
    }

    #[test]
    fn split_then_merge_round_trips_page_count() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("three.pdf");
        fixture(&input, 3);

        let outputs = split(
            &input,
            &[
                PageRange { start: 1, end: 1 },
                PageRange { start: 2, end: 2 },
                PageRange { start: 3, end: 3 },
            ],
            tmp.path(),
        )
        .unwrap();
        let out_paths: Vec<&Path> = outputs.iter().map(|p| p.as_path()).collect();
        let merged = tmp.path().join("merged.pdf");
        merge::merge(&out_paths, &merged).unwrap();
        let loaded = Document::load(&merged).unwrap();
        assert_eq!(loaded.get_pages().len(), 3);
    }

    #[test]
    fn split_empty_ranges_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("x.pdf");
        fixture(&input, 5);
        assert!(split(&input, &[], tmp.path()).is_err());
    }
}
