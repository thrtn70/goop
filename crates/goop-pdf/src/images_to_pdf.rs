//! Combine N images into a single PDF, one image per page, in the
//! order supplied. Pure-Rust via `lopdf` + the `image` crate for
//! decoding. No sidecar dependency.
//!
//! v0.2.5 expanded the accepted input set from PNG / JPEG only to
//! every extension the `image` crate's `ImageReader::with_guessed_
//! format()` recognizes (PNG, JPEG, WebP, BMP, GIF, TIFF, AVIF, ICO,
//! HDR) so users can drop a heterogeneous folder of images and get
//! one PDF.
//!
//! Phase 9 also added the DCTDecode passthrough: JPEG inputs embed
//! their raw byte stream as a `/Filter /DCTDecode` XObject instead of
//! decoding to RGB and re-encoding as `/Filter /FlateDecode`. The
//! optimization shrinks photo-heavy output PDFs roughly 10× because
//! the JPEG's existing lossy compression is preserved instead of
//! being re-expanded to raw pixels and then re-deflated.
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

/// Embed `path` as a /XObject /Image stream in `doc`. JPEG inputs
/// take the fast DCTDecode passthrough (raw byte stream + dimensions
/// from `image::ImageReader::into_dimensions`); everything else
/// decodes to RGB8 and embeds as FlateDecode pixel data. Returns the
/// object id + image dimensions in pixels.
fn embed_image(doc: &mut Document, path: &Path) -> Result<(lopdf::ObjectId, u32, u32), PdfError> {
    if is_baseline_jpeg(path) {
        if let Some(out) = embed_jpeg_dct(doc, path)? {
            return Ok(out);
        }
        // Fall through to FlateDecode if the JPEG didn't satisfy the
        // baseline / 8-bit / RGB-or-grey requirements DCTDecode can
        // represent. Progressive JPEGs are fine in DCTDecode, but a
        // CMYK or 16-bit JPEG would need a different ColorSpace.
    }
    embed_flate(doc, path)
}

/// Returns true for any path ending in `.jpg` / `.jpeg`. Used to
/// gate the DCTDecode optimization on the extension; the actual SOF
/// marker is parsed by `embed_jpeg_dct` to confirm the file really is
/// a JPEG we can passthrough.
fn is_baseline_jpeg(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(ext.as_str(), "jpg" | "jpeg")
}

/// JPEG SOF (Start Of Frame) marker payload layout: P (precision, 1
/// byte), Y (height, 2 bytes BE), X (width, 2 bytes BE), Nf
/// (component count, 1 byte). We need Nf to pick `/DeviceRGB` (3) vs
/// `/DeviceGray` (1) and to refuse CMYK (4, which DCTDecode supports
/// but with a different ColorSpace key — out of scope for v0.2.5).
struct JpegInfo {
    width: u32,
    height: u32,
    components: u8,
}

/// Parse the SOF marker(s) of a JPEG file. Returns `None` if the
/// file isn't a parsable JPEG, or if the SOF describes a colour
/// model DCTDecode can't represent here (CMYK, 16-bit precision).
fn parse_jpeg_info(bytes: &[u8]) -> Option<JpegInfo> {
    // Minimum: SOI (0xFFD8) + a single SOF marker + payload.
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 3 < bytes.len() {
        if bytes[i] != 0xFF {
            return None;
        }
        // Skip 0xFF padding bytes between markers.
        let mut marker = bytes[i + 1];
        while marker == 0xFF && i + 2 < bytes.len() {
            i += 1;
            marker = bytes[i + 1];
        }
        // SOF markers: 0xC0..=0xCF excluding 0xC4 (DHT), 0xC8 (JPG),
        // 0xCC (DAC). 0xC0/0xC2 are the baseline + progressive forms
        // we care about.
        if matches!(marker, 0xC0 | 0xC1 | 0xC2 | 0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
            // SOF payload starts at i+4 (skipping length).
            if i + 9 >= bytes.len() {
                return None;
            }
            let precision = bytes[i + 4];
            let height = u32::from(u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]));
            let width = u32::from(u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]));
            let components = bytes[i + 9];
            if precision != 8 || !matches!(components, 1 | 3) {
                return None;
            }
            return Some(JpegInfo {
                width,
                height,
                components,
            });
        }
        // Standalone markers (no payload length): SOI/EOI/RSTn.
        if matches!(marker, 0xD0..=0xD9) {
            i += 2;
            continue;
        }
        if i + 3 >= bytes.len() {
            return None;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if len < 2 {
            return None;
        }
        i += 2 + len;
    }
    None
}

/// Embed a JPEG via DCTDecode (raw byte passthrough). Returns
/// `Ok(None)` when the JPEG can't be passthrough'd (CMYK, 16-bit,
/// malformed) so the caller falls back to the decode path.
fn embed_jpeg_dct(
    doc: &mut Document,
    path: &Path,
) -> Result<Option<(lopdf::ObjectId, u32, u32)>, PdfError> {
    let bytes = std::fs::read(path).map_err(PdfError::Io)?;
    let Some(info) = parse_jpeg_info(&bytes) else {
        return Ok(None);
    };
    let color_space = match info.components {
        1 => "DeviceGray",
        3 => "DeviceRGB",
        _ => return Ok(None),
    };
    // The /Filter dict entry tells the PDF viewer the stream is
    // already DCT-compressed; the viewer reuses the JPEG decoder
    // it already has rather than asking lopdf to inflate FlateDecode
    // around raw pixels.
    let stream = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => i64::from(info.width),
            "Height" => i64::from(info.height),
            "ColorSpace" => color_space,
            "BitsPerComponent" => 8,
            "Filter" => "DCTDecode",
        },
        bytes,
    )
    // Prevent lopdf's `doc.compress()` pass from wrapping the
    // already-compressed JPEG stream in a FlateDecode layer (which
    // would make the file larger, not smaller).
    .with_compression(false);
    Ok(Some((doc.add_object(stream), info.width, info.height)))
}

/// Decode `path` to RGB8 pixels and embed as a FlateDecode XObject —
/// the v0.2.4 path, now reserved for non-JPEG inputs and JPEGs that
/// don't satisfy `embed_jpeg_dct`'s requirements.
fn embed_flate(doc: &mut Document, path: &Path) -> Result<(lopdf::ObjectId, u32, u32), PdfError> {
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
    fn jpeg_input_uses_dctdecode_filter() {
        let tmp = TempDir::new().unwrap();
        let jpg = tmp.path().join("blue.jpg");
        write_blue_jpeg(&jpg);
        let out = tmp.path().join("dct.pdf");

        images_to_pdf(&[jpg.as_path()], &out).unwrap();

        // Read the output PDF as raw bytes and assert the
        // /DCTDecode filter appears. Searching the byte stream is
        // safe because lopdf doesn't compress XObjects we marked
        // with .with_compression(false).
        let bytes = std::fs::read(&out).unwrap();
        let needle = b"/DCTDecode";
        assert!(
            bytes.windows(needle.len()).any(|w| w == needle),
            "expected /DCTDecode filter in output JPEG-only PDF"
        );
    }

    #[test]
    fn png_input_falls_through_to_flate() {
        let tmp = TempDir::new().unwrap();
        let png = tmp.path().join("red.png");
        write_red_png(&png);
        let out = tmp.path().join("flate.pdf");

        images_to_pdf(&[png.as_path()], &out).unwrap();

        // PNG decode path produces a stream with no /Filter entry
        // before doc.compress() applies FlateDecode at save time.
        // Look for FlateDecode in the output bytes.
        let bytes = std::fs::read(&out).unwrap();
        let needle = b"/FlateDecode";
        assert!(
            bytes.windows(needle.len()).any(|w| w == needle),
            "expected /FlateDecode filter in PNG-only PDF"
        );
        // And confirm we did NOT accidentally embed a DCTDecode
        // stream for the PNG.
        let dct = b"/DCTDecode";
        assert!(
            !bytes.windows(dct.len()).any(|w| w == dct),
            "PNG input must not produce a DCTDecode XObject"
        );
    }

    #[test]
    fn dctdecode_shrinks_jpeg_output_size() {
        // Synthesize a JPEG with non-trivial content so the
        // pre/post comparison reflects compressed vs raw RGB bytes.
        let tmp = TempDir::new().unwrap();
        let jpg = tmp.path().join("photo.jpg");
        let mut img = image::RgbImage::new(256, 256);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = image::Rgb([(x as u8).wrapping_mul(3), (y as u8).wrapping_mul(5), 64]);
        }
        let file = std::fs::File::create(&jpg).unwrap();
        let mut writer = std::io::BufWriter::new(file);
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut writer, image::ImageFormat::Jpeg)
            .unwrap();
        writer.flush().unwrap();

        let out = tmp.path().join("photo.pdf");
        images_to_pdf(&[jpg.as_path()], &out).unwrap();

        let pdf_size = std::fs::metadata(&out).unwrap().len();
        let raw_rgb_size = 256u64 * 256 * 3; // 196_608 bytes uncompressed
                                             // DCTDecode preserves the JPEG's compressed payload, so the
                                             // PDF should be a fraction of the raw pixel size.
        assert!(
            pdf_size < raw_rgb_size,
            "expected DCT'd PDF ({pdf_size}) smaller than raw RGB ({raw_rgb_size})"
        );
    }

    #[test]
    fn jpeg_info_parses_synthetic_sof() {
        let tmp = TempDir::new().unwrap();
        let jpg = tmp.path().join("blue.jpg");
        write_blue_jpeg(&jpg);
        let bytes = std::fs::read(&jpg).unwrap();
        let info = parse_jpeg_info(&bytes).expect("SOF parses");
        assert_eq!(info.width, 16);
        assert_eq!(info.height, 16);
        assert_eq!(info.components, 3);
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
