//! Shared test fixture for the per-op test modules. Each new op module
//! needs a minimal multi-page PDF on disk to exercise its lopdf path;
//! rather than duplicate the fixture builder in every `#[cfg(test)] mod`,
//! it lives here gated behind `#[cfg(test)]`.
#![cfg(test)]

use lopdf::{Dictionary, Document, Object};
use std::path::Path;

/// Write a minimal valid PDF with `page_count` blank Letter-sized pages
/// to `path`. Each page has a MediaBox of 612×792 points (8.5×11 inches
/// at 72 dpi) and no Contents stream — enough for `lopdf::Document::load`
/// to round-trip page counts and for downstream tests to verify
/// per-page operations.
pub fn write_blank_pdf(path: &Path, page_count: u32) {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let mut page_ids = Vec::with_capacity(page_count as usize);
    for _ in 0..page_count {
        let page_id = doc.new_object_id();
        let mut page = Dictionary::new();
        page.set("Type", "Page");
        page.set("Parent", pages_id);
        page.set(
            "MediaBox",
            Object::Array(vec![0.into(), 0.into(), 612.into(), 792.into()]),
        );
        doc.objects.insert(page_id, Object::Dictionary(page));
        page_ids.push(Object::Reference(page_id));
    }
    let mut pages = Dictionary::new();
    pages.set("Type", "Pages");
    pages.set("Kids", Object::Array(page_ids));
    pages.set("Count", page_count as i64);
    doc.objects.insert(pages_id, Object::Dictionary(pages));
    let catalog_id = doc.new_object_id();
    let mut catalog = Dictionary::new();
    catalog.set("Type", "Catalog");
    catalog.set("Pages", pages_id);
    doc.objects.insert(catalog_id, Object::Dictionary(catalog));
    doc.trailer.set("Root", catalog_id);
    doc.save(path).expect("write fixture PDF");
}
