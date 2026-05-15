use crate::PdfError;
use goop_core::{PageRotation, RotationDegrees};
use lopdf::{Document, Object};
use std::path::Path;

/// Apply per-page clockwise rotations to the document. Each entry in
/// `rotations` targets a 1-indexed page; pages not listed retain their
/// existing `/Rotate` value. Per PDF spec a page's effective rotation
/// is the sum of its `/Rotate` and its parent Pages node's inherited
/// `/Rotate`; this implementation reads & sets the page-level value
/// only — Pages-tree inheritance is preserved untouched.
///
/// "Rotate all 90°" is expressed by the caller as a `Vec<PageRotation>`
/// of length N covering every page; the backend doesn't have a separate
/// "all" code path.
///
/// Blocking — run on `spawn_blocking`.
pub fn rotate(
    input: &Path,
    rotations: &[PageRotation],
    output_path: &Path,
) -> Result<(), PdfError> {
    if rotations.is_empty() {
        return Err(PdfError::Range("no rotations provided".into()));
    }
    let mut doc = Document::load(input).map_err(|e| PdfError::Parse(e.to_string()))?;
    let pages = doc.get_pages();
    let total = pages.len() as u32;
    for r in rotations {
        if r.page < 1 || r.page > total {
            return Err(PdfError::Range(format!(
                "page {} out of range 1..={total}",
                r.page
            )));
        }
    }
    // Apply in input order. A later entry on the same page composes onto
    // the earlier — e.g. [{page:1, Cw90}, {page:1, Cw90}] yields 180°.
    for r in rotations {
        let page_id = *pages.get(&r.page).expect("validated above");
        let existing = read_rotate(&doc, page_id).unwrap_or(0);
        let next = merge_rotation(existing, r.rotation);
        write_rotate(&mut doc, page_id, next)?;
    }

    doc.save(output_path)
        .map_err(|e| PdfError::Write(e.to_string()))?;
    Ok(())
}

fn read_rotate(doc: &Document, page_id: lopdf::ObjectId) -> Option<i64> {
    let page = doc.get_object(page_id).ok()?.as_dict().ok()?;
    page.get(b"Rotate").ok()?.as_i64().ok()
}

fn write_rotate(doc: &mut Document, page_id: lopdf::ObjectId, value: i64) -> Result<(), PdfError> {
    let page = doc
        .get_object_mut(page_id)
        .and_then(Object::as_dict_mut)
        .map_err(|e| PdfError::Write(format!("open page dict: {e}")))?;
    if value == 0 {
        // Remove the key rather than write 0 — PDF spec treats absent
        // /Rotate as 0, so this is the cleaner round-trip.
        page.remove(b"Rotate");
    } else {
        page.set("Rotate", value);
    }
    Ok(())
}

/// Compose `existing` (a /Rotate value, expected in 0/90/180/270) with a
/// new clockwise rotation. Result is normalized into the same set.
/// Negative or off-axis `existing` values are first normalized into the
/// canonical set so older or hand-edited PDFs don't poison the math.
pub(crate) fn merge_rotation(existing_deg: i64, additional: RotationDegrees) -> i64 {
    let delta = match additional {
        RotationDegrees::Cw90 => 90,
        RotationDegrees::Cw180 => 180,
        RotationDegrees::Cw270 => 270,
    };
    let raw = existing_deg + delta;
    raw.rem_euclid(360)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixture::write_blank_pdf;
    use goop_core::PageRotation;

    fn rotate_value(doc: &Document, page_num: u32) -> i64 {
        let page_id = *doc.get_pages().get(&page_num).expect("page exists");
        read_rotate(doc, page_id).unwrap_or(0)
    }

    #[test]
    fn rotate_single_page_only_touches_that_page() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("three.pdf");
        write_blank_pdf(&input, 3);
        let out = tmp.path().join("out.pdf");
        rotate(
            &input,
            &[PageRotation {
                page: 2,
                rotation: RotationDegrees::Cw90,
            }],
            &out,
        )
        .unwrap();
        let loaded = Document::load(&out).unwrap();
        assert_eq!(rotate_value(&loaded, 1), 0);
        assert_eq!(rotate_value(&loaded, 2), 90);
        assert_eq!(rotate_value(&loaded, 3), 0);
    }

    #[test]
    fn rotate_all_pages_90_via_per_page_vector() {
        // "Rotate all 90°" is just N entries — no separate code path.
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("four.pdf");
        write_blank_pdf(&input, 4);
        let out = tmp.path().join("out.pdf");
        let rotations: Vec<PageRotation> = (1..=4)
            .map(|p| PageRotation {
                page: p,
                rotation: RotationDegrees::Cw90,
            })
            .collect();
        rotate(&input, &rotations, &out).unwrap();
        let loaded = Document::load(&out).unwrap();
        for p in 1..=4 {
            assert_eq!(rotate_value(&loaded, p), 90);
        }
    }

    #[test]
    fn merge_rotation_composes_modulo_360() {
        assert_eq!(merge_rotation(0, RotationDegrees::Cw90), 90);
        assert_eq!(merge_rotation(90, RotationDegrees::Cw270), 0);
        assert_eq!(merge_rotation(180, RotationDegrees::Cw180), 0);
        assert_eq!(merge_rotation(270, RotationDegrees::Cw90), 0);
        assert_eq!(merge_rotation(90, RotationDegrees::Cw90), 180);
    }

    #[test]
    fn merge_rotation_normalizes_unusual_existing_values() {
        // A document with /Rotate -90 should land at 0 after Cw90,
        // not at -360 — rem_euclid handles negatives correctly.
        assert_eq!(merge_rotation(-90, RotationDegrees::Cw90), 0);
        // Values outside 0..360 (extraction artifacts) also normalize.
        assert_eq!(merge_rotation(450, RotationDegrees::Cw90), 180);
    }

    #[test]
    fn four_rotations_of_90_round_trip_to_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("two.pdf");
        write_blank_pdf(&input, 2);
        let step = tmp.path().join("step.pdf");

        let mut current = input.clone();
        for _ in 0..4 {
            let out = tmp
                .path()
                .join(format!("rot-{:?}.pdf", std::time::SystemTime::now()));
            rotate(
                &current,
                &[PageRotation {
                    page: 1,
                    rotation: RotationDegrees::Cw90,
                }],
                &out,
            )
            .unwrap();
            std::fs::copy(&out, &step).unwrap();
            current = step.clone();
        }
        let loaded = Document::load(&step).unwrap();
        assert_eq!(rotate_value(&loaded, 1), 0, "four 90° rotations = identity");
    }

    #[test]
    fn rotate_empty_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("x.pdf");
        write_blank_pdf(&input, 2);
        let out = tmp.path().join("out.pdf");
        assert!(rotate(&input, &[], &out).is_err());
    }

    #[test]
    fn rotate_out_of_range_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("x.pdf");
        write_blank_pdf(&input, 2);
        let out = tmp.path().join("out.pdf");
        assert!(rotate(
            &input,
            &[PageRotation {
                page: 99,
                rotation: RotationDegrees::Cw90,
            }],
            &out
        )
        .is_err());
    }
}
