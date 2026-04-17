use crate::PdfError;
use lopdf::{Document, Object, ObjectId};
use std::path::Path;

/// Concatenate multiple PDFs in order. Blocking — run on `spawn_blocking`.
///
/// Loads each input, renumbers its object IDs so they don't collide, then
/// copies every object into a fresh `combined` document. New Catalog and
/// Pages root objects are placed at IDs beyond the max id from the source
/// docs so they never overlap. Forms and annotations are preserved
/// best-effort but not guaranteed (out of scope for v0.1.8).
pub fn merge(inputs: &[&Path], output: &Path) -> Result<(), PdfError> {
    if inputs.is_empty() {
        return Err(PdfError::Parse("merge requires at least one input".into()));
    }

    let mut combined = Document::with_version("1.5");
    let mut max_id: u32 = 1;
    let mut page_refs: Vec<Object> = Vec::new();

    for path in inputs {
        let mut doc = Document::load(path).map_err(|e| PdfError::Parse(e.to_string()))?;
        doc.renumber_objects_with(max_id);

        for (_, page_id) in doc.get_pages() {
            page_refs.push(Object::Reference(page_id));
        }

        max_id = doc.max_id + 1;
        combined.objects.extend(doc.objects);
    }

    // Allocate catalog + pages root at fresh IDs beyond everything we just
    // imported so they can't collide with a copied-in object.
    let pages_id: ObjectId = (max_id, 0);
    let catalog_id: ObjectId = (max_id + 1, 0);
    combined.max_id = max_id + 1;

    // Re-parent each imported page to the new Pages root.
    for page_ref in &page_refs {
        if let Object::Reference(id) = page_ref {
            if let Some(Object::Dictionary(ref mut d)) = combined.objects.get_mut(id) {
                d.set("Parent", pages_id);
            }
        }
    }

    let page_count = page_refs.len() as i64;
    let mut pages_dict = lopdf::Dictionary::new();
    pages_dict.set("Type", "Pages");
    pages_dict.set("Kids", Object::Array(page_refs));
    pages_dict.set("Count", page_count);
    combined
        .objects
        .insert(pages_id, Object::Dictionary(pages_dict));

    let mut catalog_dict = lopdf::Dictionary::new();
    catalog_dict.set("Type", "Catalog");
    catalog_dict.set("Pages", pages_id);
    combined
        .objects
        .insert(catalog_id, Object::Dictionary(catalog_dict));

    combined.trailer.set("Root", catalog_id);
    combined.compress();

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    combined
        .save(output)
        .map_err(|e| PdfError::Write(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn merge_two_pdfs_combined_page_count() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.pdf");
        let b = tmp.path().join("b.pdf");
        let out = tmp.path().join("merged.pdf");
        fixture(&a, 2);
        fixture(&b, 3);

        merge(&[&a, &b], &out).unwrap();

        let loaded = Document::load(&out).unwrap();
        assert_eq!(loaded.get_pages().len(), 5);
    }

    #[test]
    fn merge_single_pdf_preserves_pages() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.pdf");
        let out = tmp.path().join("merged.pdf");
        fixture(&a, 4);

        merge(&[&a], &out).unwrap();

        let loaded = Document::load(&out).unwrap();
        assert_eq!(loaded.get_pages().len(), 4);
    }

    #[test]
    fn merge_empty_inputs_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("out.pdf");
        let result = merge(&[], &out);
        assert!(result.is_err());
    }
}
