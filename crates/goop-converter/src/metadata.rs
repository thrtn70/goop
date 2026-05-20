//! Image metadata propagation (EXIF + ICC) across a convert / compress
//! op. The `image` crate's encoders strip metadata by default, so
//! "Preserve" requires actively reading the source's metadata chunks
//! and writing them into the output file after encoding.
//!
//! v0.2.5 supports the JPEG↔JPEG and PNG↔PNG paths via `img-parts`:
//!
//! * JPEG: EXIF lives in the APP1 marker (`Exif\0\0` prefix). ICC
//!   lives in APP2 (`ICC_PROFILE\0` prefix, possibly split across
//!   multiple APP2 segments which `img-parts::Jpeg::icc_profile`
//!   reassembles).
//! * PNG: EXIF lives in the `eXIf` chunk (PNG 1.5+). ICC lives in
//!   the `iCCP` chunk.
//!
//! Cross-format conversions (e.g. JPEG → AVIF) drop the metadata for
//! v0.2.5 / v0.2.6; broadening the supported matrix is a v0.2.7+
//! candidate.

use goop_core::{GoopError, MetadataPolicy};
use img_parts::jpeg::Jpeg;
use img_parts::png::Png;
use img_parts::{ImageEXIF, ImageICC};
use std::path::Path;

/// Categorize a file path by container format. Used to gate whether
/// the propagation path is implemented for this source / output pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Jpeg,
    Png,
    Other,
}

pub fn container_of(path: &Path) -> Container {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" => Container::Jpeg,
        "png" => Container::Png,
        _ => Container::Other,
    }
}

/// Optional EXIF + ICC bytes pulled from a source image.
pub type Metadata = (Option<Vec<u8>>, Option<Vec<u8>>);

/// Read EXIF + ICC bytes from a JPEG or PNG input. Returns `(None,
/// None)` for unsupported containers — callers should branch on the
/// container before invoking. EXIF / ICC may individually be `None`
/// when the source doesn't carry that chunk.
pub fn read(input: &Path) -> Result<Metadata, GoopError> {
    let bytes = std::fs::read(input).map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("failed to read input for metadata: {e}"),
    })?;
    match container_of(input) {
        Container::Jpeg => {
            let jpeg = Jpeg::from_bytes(bytes.into()).map_err(|e| GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("metadata: failed to parse JPEG: {e}"),
            })?;
            Ok((
                jpeg.exif().map(|b| b.to_vec()),
                jpeg.icc_profile().map(|b| b.to_vec()),
            ))
        }
        Container::Png => {
            let png = Png::from_bytes(bytes.into()).map_err(|e| GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("metadata: failed to parse PNG: {e}"),
            })?;
            Ok((
                png.exif().map(|b| b.to_vec()),
                png.icc_profile().map(|b| b.to_vec()),
            ))
        }
        Container::Other => Ok((None, None)),
    }
}

/// Apply `policy` to `output` using the source metadata read from
/// `input`. If `policy` is `StripAll` this is a no-op (output is
/// already clean after encode). If `policy` is `Preserve` and both
/// input + output containers are JPEG or PNG (matching), the EXIF
/// and ICC bytes from the source are written into the output.
///
/// Returns `Ok(true)` if metadata was actually copied, `Ok(false)`
/// if the policy was `Preserve` but the container pair isn't
/// supported (e.g. JPEG → AVIF). The boolean lets the caller log
/// the difference at INFO level for the dev console.
pub fn apply(input: &Path, output: &Path, policy: MetadataPolicy) -> Result<bool, GoopError> {
    if matches!(policy, MetadataPolicy::StripAll) {
        return Ok(true);
    }
    let in_container = container_of(input);
    let out_container = container_of(output);
    if in_container != out_container || matches!(in_container, Container::Other) {
        return Ok(false);
    }

    let (exif, icc) = read(input)?;
    if exif.is_none() && icc.is_none() {
        return Ok(false);
    }

    let out_bytes = std::fs::read(output).map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("metadata: failed to read output for update: {e}"),
    })?;

    let updated: Vec<u8> = match out_container {
        Container::Jpeg => {
            let mut jpeg =
                Jpeg::from_bytes(out_bytes.into()).map_err(|e| GoopError::SubprocessFailed {
                    binary: "image".into(),
                    stderr: format!("metadata: failed to parse JPEG output: {e}"),
                })?;
            if let Some(bytes) = exif {
                jpeg.set_exif(Some(bytes.into()));
            }
            if let Some(bytes) = icc {
                jpeg.set_icc_profile(Some(bytes.into()));
            }
            let mut out = Vec::new();
            jpeg.encoder()
                .write_to(&mut out)
                .map_err(|e| GoopError::SubprocessFailed {
                    binary: "image".into(),
                    stderr: format!("metadata: JPEG re-encode failed: {e}"),
                })?;
            out
        }
        Container::Png => {
            let mut png =
                Png::from_bytes(out_bytes.into()).map_err(|e| GoopError::SubprocessFailed {
                    binary: "image".into(),
                    stderr: format!("metadata: failed to parse PNG output: {e}"),
                })?;
            if let Some(bytes) = exif {
                png.set_exif(Some(bytes.into()));
            }
            if let Some(bytes) = icc {
                png.set_icc_profile(Some(bytes.into()));
            }
            let mut out = Vec::new();
            png.encoder()
                .write_to(&mut out)
                .map_err(|e| GoopError::SubprocessFailed {
                    binary: "image".into(),
                    stderr: format!("metadata: PNG re-encode failed: {e}"),
                })?;
            out
        }
        Container::Other => return Ok(false),
    };

    std::fs::write(output, &updated).map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("metadata: failed to write updated output: {e}"),
    })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use img_parts::Bytes;
    use std::path::PathBuf;

    fn tmp_dir(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static C: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let c = C.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("goop-metadata-{label}-{n}-{c}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_test_jpeg(path: &Path) {
        use image::{Rgb, RgbImage};
        let img: RgbImage =
            ImageBuffer::from_fn(64, 64, |x, y| Rgb([x as u8, y as u8, ((x + y) as u8) / 2]));
        img.save(path).unwrap();
    }

    fn write_test_png(path: &Path) {
        let img: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_fn(32, 32, |x, y| Rgba([x as u8, y as u8, 128, 255]));
        img.save(path).unwrap();
    }

    fn make_fake_exif() -> Vec<u8> {
        // A minimal but valid-looking EXIF blob: TIFF header + 0 IFD
        // entries. img-parts doesn't validate the inner TIFF
        // structure on set_exif — it just wraps the bytes in an
        // APP1 marker.
        let mut buf = Vec::new();
        buf.extend_from_slice(&[0x49, 0x49, 0x2a, 0x00]); // little-endian TIFF magic
        buf.extend_from_slice(&[0x08, 0x00, 0x00, 0x00]); // IFD0 offset = 8
        buf.extend_from_slice(&[0x00, 0x00]); // 0 entries
        buf.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // next IFD = 0
        buf
    }

    fn make_fake_icc() -> Vec<u8> {
        // ICC profiles start with a 128-byte header. A real profile
        // is much larger; img-parts only requires the bytes for
        // wrapping into the iCCP / APP2 chunk.
        vec![0u8; 128]
    }

    #[test]
    fn container_of_recognizes_jpeg_and_png() {
        assert_eq!(container_of(Path::new("/x.jpg")), Container::Jpeg);
        assert_eq!(container_of(Path::new("/x.jpeg")), Container::Jpeg);
        assert_eq!(container_of(Path::new("/x.png")), Container::Png);
        assert_eq!(container_of(Path::new("/x.webp")), Container::Other);
    }

    #[test]
    fn jpeg_preserve_round_trips_exif() {
        let dir = tmp_dir("jpeg-preserve");
        // Build a JPEG with fake EXIF baked in.
        let in_path = dir.join("in.jpg");
        write_test_jpeg(&in_path);
        let raw = std::fs::read(&in_path).unwrap();
        let mut jpeg = Jpeg::from_bytes(raw.into()).unwrap();
        jpeg.set_exif(Some(Bytes::from(make_fake_exif())));
        jpeg.set_icc_profile(Some(Bytes::from(make_fake_icc())));
        let mut with_meta = Vec::new();
        jpeg.encoder().write_to(&mut with_meta).unwrap();
        std::fs::write(&in_path, &with_meta).unwrap();

        // Synthesize a "converted" output JPEG (same encode, no
        // metadata) and run apply() to copy metadata back in.
        let out_path = dir.join("out.jpg");
        write_test_jpeg(&out_path);

        let copied = apply(&in_path, &out_path, MetadataPolicy::Preserve).unwrap();
        assert!(copied);

        let (exif, icc) = read(&out_path).unwrap();
        assert!(exif.is_some());
        assert!(icc.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn jpeg_strip_all_is_noop() {
        let dir = tmp_dir("jpeg-strip");
        let in_path = dir.join("in.jpg");
        write_test_jpeg(&in_path);
        let out_path = dir.join("out.jpg");
        write_test_jpeg(&out_path);

        // No metadata in either file; StripAll should still succeed
        // and report `true` (i.e. "stripping happened" — even when
        // there was nothing to strip).
        let stripped = apply(&in_path, &out_path, MetadataPolicy::StripAll).unwrap();
        assert!(stripped);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cross_format_preserve_returns_false() {
        let dir = tmp_dir("cross");
        let in_path = dir.join("in.jpg");
        write_test_jpeg(&in_path);
        let out_path = dir.join("out.png");
        write_test_png(&out_path);

        // JPEG → PNG isn't a supported preserve path in v0.2.5; the
        // function returns Ok(false) so the caller can log "metadata
        // dropped for cross-format conversion".
        let copied = apply(&in_path, &out_path, MetadataPolicy::Preserve).unwrap();
        assert!(!copied);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn png_preserve_round_trips_icc() {
        let dir = tmp_dir("png-preserve");
        let in_path = dir.join("in.png");
        write_test_png(&in_path);
        let raw = std::fs::read(&in_path).unwrap();
        let mut png = Png::from_bytes(raw.into()).unwrap();
        png.set_icc_profile(Some(Bytes::from(make_fake_icc())));
        let mut with_meta = Vec::new();
        png.encoder().write_to(&mut with_meta).unwrap();
        std::fs::write(&in_path, &with_meta).unwrap();

        let out_path = dir.join("out.png");
        write_test_png(&out_path);

        let copied = apply(&in_path, &out_path, MetadataPolicy::Preserve).unwrap();
        assert!(copied);

        let (_, icc) = read(&out_path).unwrap();
        assert!(icc.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preserve_no_metadata_in_source_returns_false() {
        let dir = tmp_dir("no-meta");
        let in_path = dir.join("in.jpg");
        write_test_jpeg(&in_path);
        let out_path = dir.join("out.jpg");
        write_test_jpeg(&out_path);

        // image crate writes JPEGs without EXIF / ICC. apply()
        // returns Ok(false) so the caller knows nothing was carried.
        let copied = apply(&in_path, &out_path, MetadataPolicy::Preserve).unwrap();
        assert!(!copied);
        std::fs::remove_dir_all(&dir).ok();
    }
}
