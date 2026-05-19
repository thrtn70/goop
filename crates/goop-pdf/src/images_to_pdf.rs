//! Combine N images into a single PDF, one image per page, in the
//! order supplied. Pure-Rust via `lopdf` + the `image` crate for
//! decoding. No sidecar dependency.
//!
//! v0.2.4 supports PNG and JPEG inputs only. Each image is decoded to
//! RGB8 and embedded as a FlateDecode XObject — JPEGs are re-encoded
//! as raw pixels rather than embedded as DCTDecode bytes, which keeps
//! the code path uniform at the cost of larger output PDFs for
//! photo-heavy inputs. The DCTDecode optimization is tracked as a
//! v0.2.5 follow-up alongside the broader Image Workshop work.
//!
//! Page MediaBox uses image dimensions in points (1pt = 1px). This is
//! simple and predictable; viewers will scale on print. A future
//! revision can pick more reasonable physical sizes once we know more
//! about user expectations.

use crate::PdfError;
use image::ImageReader;
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};
use std::path::Path;

/// Assemble `inputs` into a multi-page PDF written to `output`. Page
/// order matches input order. The output file is overwritten if it
/// already exists.
pub fn images_to_pdf(inputs: &[&Path], output: &Path) -> Result<(), PdfError> {
    if inputs.is_empty() {
        return Err(PdfError::Range("no input images".into()));
    }

    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let mut page_refs: Vec<Object> = Vec::with_capacity(inputs.len());

    for input in inputs {
        let (image_id, width_px, height_px) = embed_image(&mut doc, input)?;

        // Resources dict: name `Im0` references the just-added image.
        let resources = dictionary! {
            "XObject" => dictionary! { "Im0" => image_id },
        };
        let resources_id = doc.add_object(resources);

        // Content stream: scale the unit-square XObject up to MediaBox
        // dimensions (cm operator: width 0 0 height 0 0) then `Do /Im0`.
        // PDF's coordinate system origin is bottom-left; the y-axis
        // points up, which matches "stretch from origin to (W,H)".
        let content = Content {
            operations: vec![
                Operation::new("q", vec![]),
                Operation::new(
                    "cm",
                    vec![
                        Object::Real(width_px as f32),
                        0.into(),
                        0.into(),
                        Object::Real(height_px as f32),
                        0.into(),
                        0.into(),
                    ],
                ),
                Operation::new("Do", vec!["Im0".into()]),
                Operation::new("Q", vec![]),
            ],
        };
        let content_bytes = content
            .encode()
            .map_err(|e| PdfError::Write(format!("content stream encode: {e}")))?;
        let content_id = doc.add_object(Stream::new(dictionary! {}, content_bytes));

        let page = dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![
                0.into(),
                0.into(),
                Object::Real(width_px as f32),
                Object::Real(height_px as f32),
            ],
            "Contents" => content_id,
            "Resources" => resources_id,
        };
        let page_id = doc.add_object(page);
        page_refs.push(page_id.into());
    }

    let pages_dict = dictionary! {
        "Type" => "Pages",
        "Count" => page_refs.len() as i64,
        "Kids" => page_refs,
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages_dict));

    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);
    doc.compress();

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(PdfError::Io)?;
    }
    doc.save(output)
        .map_err(|e| PdfError::Write(format!("save: {e}")))?;
    Ok(())
}

/// Decode `path` into RGB8 pixels, embed as a /XObject /Image stream
/// in `doc`. Returns the object id + image dimensions in pixels.
fn embed_image(doc: &mut Document, path: &Path) -> Result<(lopdf::ObjectId, u32, u32), PdfError> {
    let reader = ImageReader::open(path)
        .map_err(PdfError::Io)?
        .with_guessed_format()
        .map_err(PdfError::Io)?;
    let dynamic = reader
        .decode()
        .map_err(|e| PdfError::Parse(format!("decode {}: {e}", path.display())))?;
    let rgb = dynamic.to_rgb8();
    let width = rgb.width();
    let height = rgb.height();
    let pixels = rgb.into_raw();

    // Construct the XObject /Image stream with the raw RGB pixel data.
    // `doc.compress()` at save time wraps streams in /FlateDecode, so
    // we leave the filter unset here and let lopdf add it consistently.
    let image_stream = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => width as i64,
            "Height" => height as i64,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
        },
        pixels,
    );
    Ok((doc.add_object(image_stream), width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    /// Synthesize a tiny RGB PNG for testing without depending on
    /// external fixture files. 8x8 solid red.
    fn write_red_png(path: &Path) {
        let mut img = image::RgbImage::new(8, 8);
        for px in img.pixels_mut() {
            *px = image::Rgb([255, 0, 0]);
        }
        let file = std::fs::File::create(path).unwrap();
        let mut writer = std::io::BufWriter::new(file);
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut writer, image::ImageFormat::Png)
            .unwrap();
        writer.flush().unwrap();
    }

    /// Tiny solid-blue JPEG, 16x16.
    fn write_blue_jpeg(path: &Path) {
        let mut img = image::RgbImage::new(16, 16);
        for px in img.pixels_mut() {
            *px = image::Rgb([0, 0, 255]);
        }
        let file = std::fs::File::create(path).unwrap();
        let mut writer = std::io::BufWriter::new(file);
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut writer, image::ImageFormat::Jpeg)
            .unwrap();
        writer.flush().unwrap();
    }

    #[test]
    fn errors_on_empty_inputs() {
        let tmp = TempDir::new().unwrap();
        let out = tmp.path().join("out.pdf");
        let err = images_to_pdf(&[], &out).unwrap_err();
        assert!(matches!(err, PdfError::Range(_)));
    }

    #[test]
    fn produces_one_page_per_image() {
        let tmp = TempDir::new().unwrap();
        let png = tmp.path().join("red.png");
        let jpg = tmp.path().join("blue.jpg");
        write_red_png(&png);
        write_blue_jpeg(&jpg);
        let out = tmp.path().join("combined.pdf");

        let inputs: Vec<&Path> = vec![png.as_path(), jpg.as_path()];
        images_to_pdf(&inputs, &out).expect("assemble ok");

        // Reload and assert page count + MediaBox per page matches the input dimensions.
        let doc = Document::load(&out).expect("reload");
        let pages = doc.get_pages();
        assert_eq!(pages.len(), 2, "expected 2 pages, one per image");
        let media_boxes: Vec<Vec<f32>> = pages
            .values()
            .map(|page_id| {
                let page = doc.get_object(*page_id).unwrap().as_dict().unwrap();
                page.get(b"MediaBox")
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|o| o.as_float().unwrap_or(o.as_i64().unwrap_or(0) as f32))
                    .collect()
            })
            .collect();
        // Page 1 = red PNG = 8x8; page 2 = blue JPEG = 16x16.
        // MediaBox is [llx, lly, urx, ury].
        assert!(media_boxes
            .iter()
            .any(|mb| (mb[2] - 8.0).abs() < 0.01 && (mb[3] - 8.0).abs() < 0.01));
        assert!(media_boxes
            .iter()
            .any(|mb| (mb[2] - 16.0).abs() < 0.01 && (mb[3] - 16.0).abs() < 0.01));
    }

    #[test]
    fn rejects_unreadable_image() {
        let tmp = TempDir::new().unwrap();
        let bogus = tmp.path().join("not-an-image.png");
        std::fs::write(&bogus, b"this is not a png").unwrap();
        let out = tmp.path().join("out.pdf");
        let err = images_to_pdf(&[bogus.as_path()], &out).unwrap_err();
        // The exact variant depends on whether the format guess fails
        // (Io) or the decode fails (Parse). Either is fine.
        assert!(
            matches!(err, PdfError::Parse(_) | PdfError::Io(_)),
            "expected Parse or Io, got {err:?}"
        );
    }
}
