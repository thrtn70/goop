use crate::PdfError;
use goop_core::PdfMetadata;
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::path::Path;

/// Replace selected fields of the PDF's `/Info` dictionary. Fields left
/// as `None` are untouched; `Some("")` clears the entry. Fields not in
/// the request retain their existing value. Creates the `/Info` dict if
/// the document doesn't already have one.
///
/// Blocking — run on `spawn_blocking`.
pub fn set_metadata(
    input: &Path,
    metadata: &PdfMetadata,
    output_path: &Path,
) -> Result<(), PdfError> {
    let mut doc = Document::load(input).map_err(|e| PdfError::Parse(e.to_string()))?;

    let info_id = ensure_info_dict(&mut doc)?;
    {
        let info = doc
            .get_object_mut(info_id)
            .and_then(Object::as_dict_mut)
            .map_err(|e| PdfError::Write(format!("open /Info: {e}")))?;
        apply_field(info, "Title", metadata.title.as_deref());
        apply_field(info, "Author", metadata.author.as_deref());
        apply_field(info, "Subject", metadata.subject.as_deref());
        apply_field(info, "Keywords", metadata.keywords.as_deref());
    }

    doc.save(output_path)
        .map_err(|e| PdfError::Write(e.to_string()))?;
    Ok(())
}

/// Read the document's `/Info` string fields plus the page count, for the
/// read-only metadata viewer. Returns `(field, value)` pairs in a stable
/// order; missing fields are simply omitted. Blocking — run on `spawn_blocking`.
pub fn read_info(input: &Path) -> Result<Vec<(String, String)>, PdfError> {
    let doc = Document::load(input).map_err(|e| PdfError::Parse(e.to_string()))?;
    let mut out = Vec::new();

    out.push(("Pages".to_string(), doc.get_pages().len().to_string()));

    if let Ok(info_id) = doc.trailer.get(b"Info").and_then(Object::as_reference) {
        if let Ok(info) = doc.get_object(info_id).and_then(Object::as_dict) {
            for key in [
                "Title",
                "Author",
                "Subject",
                "Keywords",
                "Creator",
                "Producer",
                "CreationDate",
                "ModDate",
            ] {
                if let Ok(obj) = info.get(key.as_bytes()) {
                    if let Ok(bytes) = obj.as_str() {
                        let value = String::from_utf8_lossy(bytes).into_owned();
                        if !value.is_empty() {
                            out.push((key.to_string(), value));
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

fn ensure_info_dict(doc: &mut Document) -> Result<ObjectId, PdfError> {
    if let Ok(existing) = doc.trailer.get(b"Info").and_then(Object::as_reference) {
        return Ok(existing);
    }
    let info_id = doc.add_object(Object::Dictionary(Dictionary::new()));
    doc.trailer.set("Info", Object::Reference(info_id));
    Ok(info_id)
}

fn apply_field(info: &mut Dictionary, key: &str, value: Option<&str>) {
    match value {
        None => {} // leave alone
        Some("") => {
            info.remove(key.as_bytes());
        }
        Some(s) => {
            // PDF text strings are wrapped in a String object; lopdf picks
            // the encoding (UTF-16BE or PDFDocEncoding) automatically.
            info.set(
                key,
                Object::String(s.as_bytes().to_vec(), lopdf::StringFormat::Literal),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixture::write_blank_pdf;

    fn read_info_string(doc: &Document, key: &str) -> Option<String> {
        let info_id = doc.trailer.get(b"Info").ok()?.as_reference().ok()?;
        let info = doc.get_object(info_id).ok()?.as_dict().ok()?;
        let obj = info.get(key.as_bytes()).ok()?;
        match obj {
            Object::String(bytes, _) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        }
    }

    #[test]
    fn set_title_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("in.pdf");
        write_blank_pdf(&input, 1);
        let out = tmp.path().join("out.pdf");
        set_metadata(
            &input,
            &PdfMetadata {
                title: Some("Hello".into()),
                author: None,
                subject: None,
                keywords: None,
            },
            &out,
        )
        .unwrap();
        let loaded = Document::load(&out).unwrap();
        assert_eq!(read_info_string(&loaded, "Title"), Some("Hello".into()));
    }

    #[test]
    fn empty_string_clears_existing_field() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("in.pdf");
        write_blank_pdf(&input, 1);
        let step1 = tmp.path().join("step1.pdf");
        let step2 = tmp.path().join("step2.pdf");

        // First set Author, then clear it via empty string.
        set_metadata(
            &input,
            &PdfMetadata {
                title: None,
                author: Some("Goop".into()),
                subject: None,
                keywords: None,
            },
            &step1,
        )
        .unwrap();
        assert_eq!(
            read_info_string(&Document::load(&step1).unwrap(), "Author"),
            Some("Goop".into())
        );

        set_metadata(
            &step1,
            &PdfMetadata {
                title: None,
                author: Some("".into()),
                subject: None,
                keywords: None,
            },
            &step2,
        )
        .unwrap();
        assert!(read_info_string(&Document::load(&step2).unwrap(), "Author").is_none());
    }

    #[test]
    fn none_fields_leave_existing_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("in.pdf");
        write_blank_pdf(&input, 1);
        let step1 = tmp.path().join("step1.pdf");
        let step2 = tmp.path().join("step2.pdf");

        set_metadata(
            &input,
            &PdfMetadata {
                title: Some("First".into()),
                author: Some("Alice".into()),
                subject: None,
                keywords: None,
            },
            &step1,
        )
        .unwrap();

        // None for title means "leave existing alone"; author update only.
        set_metadata(
            &step1,
            &PdfMetadata {
                title: None,
                author: Some("Bob".into()),
                subject: None,
                keywords: None,
            },
            &step2,
        )
        .unwrap();
        let loaded = Document::load(&step2).unwrap();
        assert_eq!(read_info_string(&loaded, "Title"), Some("First".into()));
        assert_eq!(read_info_string(&loaded, "Author"), Some("Bob".into()));
    }

    #[test]
    fn creates_info_dict_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("in.pdf");
        write_blank_pdf(&input, 1); // fixture has no /Info
        let out = tmp.path().join("out.pdf");
        set_metadata(
            &input,
            &PdfMetadata {
                title: Some("Created".into()),
                author: None,
                subject: None,
                keywords: None,
            },
            &out,
        )
        .unwrap();
        let loaded = Document::load(&out).unwrap();
        assert_eq!(read_info_string(&loaded, "Title"), Some("Created".into()));
    }
}
