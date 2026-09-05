use goop_converter::imagemagick_probe::probe_image;
use goop_core::SourceKind;
use std::{fs, path::Path};

#[test]
fn probes_heic_primary_dimensions() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sample.heic");
    let result = probe_image(&path).unwrap();
    assert_eq!((result.width, result.height), (Some(64), Some(64)));
    assert_eq!(result.image_format.as_deref(), Some("HEIC"));
    assert_eq!(result.source_kind, SourceKind::Image);
}

#[test]
fn probes_jxl_dimensions_with_existing_decoder() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sample.jxl");
    let mut encoder = jpegxl_rs::encoder_builder().build().unwrap();
    let pixels = vec![128u8; 16 * 8 * 3];
    let encoded = encoder.encode::<u8, u8>(&pixels, 16, 8).unwrap();
    fs::write(&path, &*encoded).unwrap();
    let result = probe_image(&path).unwrap();
    assert_eq!((result.width, result.height), (Some(16), Some(8)));
    assert_eq!(result.image_format.as_deref(), Some("JXL"));
}
