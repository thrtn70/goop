mod common;
use goop_converter::{ConversionBackend, ImageMagickBackend};
use goop_core::{
    CompressMode, ConvertRequest, ImageColorHandling, ImageColorPolicy, ImageConvertOptions,
    ImageResize, JobId, MetadataPolicy, TargetFormat,
};
use img_parts::{jpeg::Jpeg, ImageEXIF, ImageICC};
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

fn source(path: &Path, w: u32, h: u32) {
    image::RgbImage::from_fn(w, h, |x, y| {
        image::Rgb([
            ((x * 31 + y * 17) % 256) as u8,
            ((x * 13 + y * 47) % 256) as u8,
            ((x * 7 + y * 3) % 256) as u8,
        ])
    })
    .save_with_format(path, image::ImageFormat::Jpeg)
    .unwrap();
}
fn request(input: &Path, output: &Path, quality: u8, resize: ImageResize) -> ConvertRequest {
    let mut req = common::request(input, output, TargetFormat::Jpeg, None);
    req.metadata_policy = Some(MetadataPolicy::StripAll);
    req.image_options = Some(ImageConvertOptions {
        jpeg_quality: quality,
        resize,
    });
    req
}
async fn convert(req: &ConvertRequest) -> Result<goop_core::ConvertResult, goop_core::GoopError> {
    let resolver = goop_sidecar::BinaryResolver::new(std::env::temp_dir());
    ImageMagickBackend::new(&resolver, Arc::new(common::SilentSink))
        .convert(JobId::new(), req, CancellationToken::new())
        .await
}
#[tokio::test]
async fn explicit_jpeg_settings_change_dimensions_and_encoded_output() {
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("source.jpg");
    source(&input, 640, 480);
    let original = std::fs::read(&input).unwrap();
    let mut outputs = Vec::new();
    for quality in [30, 90] {
        let req = request(
            &input,
            &d.path().join(format!("q{quality}.jpg")),
            quality,
            ImageResize::FitWithin {
                width: 160,
                height: 160,
            },
        );
        let r = convert(&req).await.unwrap();
        assert_eq!(image::image_dimensions(&r.output_path).unwrap(), (160, 120));
        outputs.push(std::fs::read(r.output_path).unwrap());
    }
    assert_ne!(outputs[0], outputs[1]);
    assert!(outputs[0].len() < outputs[1].len());
    assert_eq!(std::fs::read(input).unwrap(), original);
}

async fn verify_retained_jpeg_channel_layout(resize: ImageResize, expected: (u32, u32)) {
    use image::ImageDecoder;
    let dir = tempfile::tempdir().unwrap();
    for grayscale in [true, false] {
        let input = dir.path().join(format!("source-{grayscale}.jpg"));
        if grayscale {
            image::GrayImage::from_fn(160, 120, |x, y| {
                image::Luma([if x < 80 {
                    if y < 60 {
                        20
                    } else {
                        150
                    }
                } else if y < 60 {
                    80
                } else {
                    230
                }])
            })
            .save(&input)
            .unwrap();
        } else {
            source(&input, 160, 120);
        }
        // Synthetic opaque profile bytes exercise preservation without a system fixture.
        let mut profile = vec![0; 128];
        profile[..4].copy_from_slice(&128u32.to_be_bytes());
        profile[16..20].copy_from_slice(if grayscale { b"GRAY" } else { b"RGB " });
        profile[36..40].copy_from_slice(b"acsp");
        let mut jpeg = Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
        jpeg.set_icc_profile(Some(profile.clone().into()));
        jpeg.set_exif(Some(orientation_exif().into()));
        jpeg.encoder()
            .write_to(std::fs::File::create(&input).unwrap())
            .unwrap();
        let original = std::fs::read(&input).unwrap();
        let mut req = request(
            &input,
            &dir.path().join(format!("out-{grayscale}.jpg")),
            90,
            resize.clone(),
        );
        req.metadata_policy = Some(MetadataPolicy::Preserve);
        let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_owned());
        goop_converter::capabilities::validate_request_source(&resolver, &req)
            .await
            .unwrap();
        let out = convert(&req).await.unwrap();
        let decoder = image::codecs::jpeg::JpegDecoder::new(std::io::BufReader::new(
            std::fs::File::open(&out.output_path).unwrap(),
        ))
        .unwrap();
        assert_eq!(
            decoder.color_type(),
            if grayscale {
                image::ColorType::L8
            } else {
                image::ColorType::Rgb8
            }
        );
        assert_eq!(decoder.dimensions(), expected);
        let (exif, icc) = goop_converter::metadata::read(Path::new(&out.output_path)).unwrap();
        assert_eq!(icc.unwrap(), profile);
        let exif = exif.unwrap();
        assert_eq!(exif[18], 1);
        for (offset, value) in [
            (30, expected.0),
            (42, expected.1),
            (72, expected.0),
            (84, expected.1),
        ] {
            assert_eq!(&exif[offset..offset + 4], &value.to_le_bytes());
        }
        if grayscale {
            let pixels = image::open(&out.output_path).unwrap().into_luma8();
            for (x, y, value) in [(1, 1, 150), (3, 1, 20), (1, 3, 230), (3, 3, 80)] {
                let actual = pixels.get_pixel(expected.0 * x / 4, expected.1 * y / 4)[0];
                assert!((i32::from(actual) - value).abs() < 10);
            }
        }
        assert_eq!(std::fs::read(&input).unwrap(), original);
    }
}

#[tokio::test]
async fn explicit_original_preserves_grayscale_icc_and_channel_layout() {
    verify_retained_jpeg_channel_layout(ImageResize::Original, (120, 160)).await;
}

#[tokio::test]
async fn explicit_fit_preserves_grayscale_icc_and_channel_layout() {
    verify_retained_jpeg_channel_layout(
        ImageResize::FitWithin {
            width: 80,
            height: 80,
        },
        (60, 80),
    )
    .await;
}
fn orientation_exif() -> Vec<u8> {
    let mut bytes = b"II\x2a\0\x08\0\0\0".to_vec();
    bytes.extend(4u16.to_le_bytes());
    for (tag, kind, count, value) in [
        (0x0112u16, 3u16, 1u32, 6u32),
        (0x0100, 4, 1, 160),
        (0x0101, 4, 1, 120),
        (0x8769, 4, 1, 62),
    ] {
        bytes.extend(tag.to_le_bytes());
        bytes.extend(kind.to_le_bytes());
        bytes.extend(count.to_le_bytes());
        bytes.extend(value.to_le_bytes());
    }
    bytes.extend(116u32.to_le_bytes());
    bytes.extend(4u16.to_le_bytes());
    for (tag, kind, count, value) in [
        (0xa002u16, 4u16, 1u32, 160u32),
        (0xa003, 4, 1, 120),
        (0x927c, 7, 8, 122),
        (0x8825, 4, 1, 130),
    ] {
        bytes.extend(tag.to_le_bytes());
        bytes.extend(kind.to_le_bytes());
        bytes.extend(count.to_le_bytes());
        bytes.extend(value.to_le_bytes());
    }
    bytes.extend(0u32.to_le_bytes());
    bytes.extend([0; 6]);
    bytes.extend(b"MAKER123");
    bytes.extend([0; 6]);
    bytes
}

fn wide_gamut_rgb_profile() -> Vec<u8> {
    use lcms2::{CIExyY, CIExyYTRIPLE, Profile, ToneCurve};

    let white = CIExyY {
        x: 0.3127,
        y: 0.3290,
        Y: 1.0,
    };
    let primaries = CIExyYTRIPLE {
        Red: CIExyY {
            x: 0.680,
            y: 0.320,
            Y: 1.0,
        },
        Green: CIExyY {
            x: 0.265,
            y: 0.690,
            Y: 1.0,
        },
        Blue: CIExyY {
            x: 0.150,
            y: 0.060,
            Y: 1.0,
        },
    };
    let curve = ToneCurve::new(2.2);
    Profile::new_rgb(&white, &primaries, &[&curve, &curve, &curve])
        .unwrap()
        .icc()
        .unwrap()
}

fn tag_rgb_jpeg_with_profile_and_exif(path: &Path) -> Vec<u8> {
    let profile = wide_gamut_rgb_profile();
    let mut jpeg = Jpeg::from_bytes(std::fs::read(path).unwrap().into()).unwrap();
    jpeg.set_icc_profile(Some(profile.clone().into()));
    jpeg.set_exif(Some(orientation_exif().into()));
    jpeg.encoder()
        .write_to(std::fs::File::create(path).unwrap())
        .unwrap();
    profile
}

fn assert_canonical_srgb_profile(actual: &[u8]) {
    let mut actual = actual.to_vec();
    let mut expected = lcms2::Profile::new_srgb().icc().unwrap();
    actual[24..36].fill(0);
    expected[24..36].fill(0);
    assert_eq!(actual, expected);
}

#[tokio::test]
async fn tagged_rgb_conversion_publishes_only_canonical_srgb_color_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("tagged.jpg");
    let output = directory.path().join("converted.jpg");
    source(&input, 32, 24);
    let source_profile = tag_rgb_jpeg_with_profile_and_exif(&input);
    let original = std::fs::read(&input).unwrap();

    let mut req = request(&input, &output, 90, ImageResize::Original);
    req.metadata_policy = Some(MetadataPolicy::Preserve);
    req.image_color_policy = Some(ImageColorPolicy::ConvertToSrgb);
    let result = convert(&req).await.unwrap();

    assert_eq!(std::fs::read(&input).unwrap(), original);
    let (exif, icc) = goop_converter::metadata::read(&output).unwrap();
    let icc = icc.expect("converted output must describe its sRGB pixels");
    assert!(exif.is_none());
    assert_canonical_srgb_profile(&icc);
    assert_ne!(icc, source_profile);
    let execution = result.image_metadata_execution.unwrap();
    assert_eq!(execution.requested_policy, MetadataPolicy::Preserve);
    assert_eq!(
        execution.requested_color_policy,
        ImageColorPolicy::ConvertToSrgb
    );
    assert_eq!(
        execution.color_handling,
        ImageColorHandling::ConvertedToSrgb
    );
    assert!(!execution.exif_retained);
    assert!(!execution.icc_retained);
    assert!(execution.destination_srgb_profile_attached);
}

#[tokio::test]
async fn explicit_privacy_policies_strip_source_metadata_but_keep_destination_srgb() {
    for policy in [MetadataPolicy::RemovePersonal, MetadataPolicy::StripAll] {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("tagged.jpg");
        let output = directory.path().join("converted.jpg");
        source(&input, 32, 24);
        let source_profile = tag_rgb_jpeg_with_profile_and_exif(&input);

        let mut req = request(&input, &output, 90, ImageResize::Original);
        req.metadata_policy = Some(policy);
        req.image_color_policy = Some(ImageColorPolicy::ConvertToSrgb);
        let result = convert(&req).await.unwrap();

        let (exif, icc) = goop_converter::metadata::read(&output).unwrap();
        let icc = icc.expect("generated destination profile must survive privacy policy");
        assert!(exif.is_none(), "source EXIF survived {policy:?}");
        assert_canonical_srgb_profile(&icc);
        assert_ne!(icc, source_profile);
        let execution = result.image_metadata_execution.unwrap();
        assert_eq!(execution.requested_policy, policy);
        assert!(!execution.exif_retained);
        assert!(!execution.icc_retained);
        assert!(execution.destination_srgb_profile_attached);
        assert_eq!(
            execution.color_handling,
            ImageColorHandling::ConvertedToSrgb
        );
    }
}

#[tokio::test]
async fn orientation_six_is_applied_once_before_fitting_and_preserve_normalizes_tag() {
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("source.jpg");
    image::RgbImage::from_fn(160, 120, |x, y| {
        image::Rgb(match (x < 80, y < 60) {
            (true, true) => [255u8, 0, 0],
            (false, true) => [0, 255, 0],
            (true, false) => [0, 0, 255],
            _ => [255, 255, 0],
        })
    })
    .save(&input)
    .unwrap();
    let mut jpeg = Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
    jpeg.set_exif(Some(orientation_exif().into()));
    let mut profile = vec![0; 128];
    profile[..4].copy_from_slice(&128u32.to_be_bytes());
    profile[16..20].copy_from_slice(b"RGB ");
    profile[36..40].copy_from_slice(b"acsp");
    jpeg.set_icc_profile(Some(profile.clone().into()));
    jpeg.encoder()
        .write_to(std::fs::File::create(&input).unwrap())
        .unwrap();
    let mut req = request(
        &input,
        &d.path().join("out.jpg"),
        90,
        ImageResize::FitWithin {
            width: 120,
            height: 120,
        },
    );
    req.metadata_policy = Some(MetadataPolicy::Preserve);
    let out = convert(&req).await.unwrap();
    let pixels = image::open(&out.output_path).unwrap().to_rgb8();
    assert_eq!(pixels.dimensions(), (90, 120));
    for (x, y, expected) in [
        (20, 20, [0, 0, 255]),
        (70, 20, [255, 0, 0]),
        (20, 100, [255, 255, 0]),
        (70, 100, [0, 255, 0]),
    ] {
        for (actual, expected) in pixels.get_pixel(x, y).0.into_iter().zip(expected) {
            assert!((i32::from(actual) - expected).abs() < 25);
        }
    }
    let (exif, icc) = goop_converter::metadata::read(Path::new(&out.output_path)).unwrap();
    let exif = exif.unwrap();
    assert_eq!(exif[18], 1);
    for (offset, value) in [(30, 90u32), (42, 120), (72, 90), (84, 120), (58, 0)] {
        assert_eq!(&exif[offset..offset + 4], &value.to_le_bytes());
    }
    assert_eq!(&exif[122..], &orientation_exif()[122..]);
    assert_eq!(icc.unwrap(), profile);
}

#[tokio::test]
async fn dimensions_original_no_upscale_portrait_landscape_and_quality_extremes() {
    let d = tempfile::tempdir().unwrap();
    for (i, (size, resize, expected)) in [
        ((400, 300), ImageResize::Original, (400, 300)),
        (
            (90, 120),
            ImageResize::FitWithin {
                width: 2048,
                height: 2048,
            },
            (90, 120),
        ),
        (
            (400, 300),
            ImageResize::FitWithin {
                width: 101,
                height: 101,
            },
            (101, 76),
        ),
        (
            (300, 400),
            ImageResize::FitWithin {
                width: 101,
                height: 101,
            },
            (76, 101),
        ),
        (
            (400, 300),
            ImageResize::FitWithin {
                width: 400,
                height: 100,
            },
            (133, 100),
        ),
        (
            (1, 200),
            ImageResize::FitWithin {
                width: 100,
                height: 1,
            },
            (1, 1),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let input = d.path().join(format!("in{i}.jpg"));
        source(&input, size.0, size.1);
        for quality in [1, 100] {
            let req = request(
                &input,
                &d.path().join(format!("out{i}-{quality}.jpg")),
                quality,
                resize.clone(),
            );
            let out = convert(&req).await.unwrap();
            assert_eq!(image::image_dimensions(out.output_path).unwrap(), expected);
        }
    }
}

#[tokio::test]
async fn malformed_metadata_fails_closed_for_preserve_and_privacy_modes() {
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("in.jpg");
    source(&input, 32, 24);
    let mut jpeg = Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
    jpeg.set_exif(Some(b"II\x2a\0\xff\xff\xff\xff".to_vec().into()));
    jpeg.set_icc_profile(Some(vec![42; 128].into()));
    jpeg.encoder()
        .write_to(std::fs::File::create(&input).unwrap())
        .unwrap();
    let mut req = request(
        &input,
        &d.path().join("preserve.jpg"),
        75,
        ImageResize::Original,
    );
    req.metadata_policy = Some(MetadataPolicy::Preserve);
    assert!(convert(&req).await.is_err());
    assert!(!Path::new(&req.output_path).exists());
    req.output_path = d.path().join("strip.jpg").to_string_lossy().into_owned();
    req.metadata_policy = Some(MetadataPolicy::StripAll);
    assert!(convert(&req).await.is_err());
    assert!(!Path::new(&req.output_path).exists());
    assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1);
}

#[tokio::test]
async fn direct_backend_rejects_conflicts_and_invalid_values_without_publishing() {
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("in.jpg");
    source(&input, 32, 24);
    let base = request(&input, &d.path().join("out.jpg"), 75, ImageResize::Original);
    let mut cases = Vec::new();
    for quality in [0, 101] {
        let mut r = base.clone();
        r.image_options.as_mut().unwrap().jpeg_quality = quality;
        cases.push(r);
    }
    for (width, height) in [(0, 1), (1, 0), (32769, 1), (1, 32769)] {
        let mut r = base.clone();
        r.image_options.as_mut().unwrap().resize = ImageResize::FitWithin { width, height };
        cases.push(r);
    }
    let mut r = base.clone();
    r.target = TargetFormat::Png;
    cases.push(r);
    let mut r = base.clone();
    r.compress_mode = Some(goop_core::CompressMode::Quality(75));
    cases.push(r);
    for (key, value) in [
        ("gif_options", serde_json::json!({"size_preset":"small"})),
        ("quality_preset", serde_json::json!("balanced")),
        ("resolution_cap", serde_json::json!("r720p")),
        (
            "subtitle",
            serde_json::json!({"source_path":"captions.srt","mode":"soft"}),
        ),
    ] {
        let mut value_req = serde_json::to_value(&base).unwrap();
        value_req[key] = value;
        cases.push(serde_json::from_value(value_req).unwrap());
    }
    for req in cases {
        assert!(convert(&req).await.is_err(), "{req:?}");
        assert!(!Path::new(&req.output_path).exists());
    }
    let mut original = base;
    original.quality_preset = Some(goop_core::QualityPreset::Original);
    original.resolution_cap = Some(goop_core::ResolutionCap::Original);
    assert!(convert(&original).await.is_ok());
}

#[tokio::test]
async fn actual_source_is_revalidated_after_probe_and_header_overrides_suffix() {
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("in.jpg");
    source(&input, 32, 24);
    let req = request(&input, &d.path().join("out.jpg"), 75, ImageResize::Original);
    let probe = goop_converter::imagemagick_probe::probe_image(&input).unwrap();
    goop_converter::capabilities::validate_request(&req, &probe).unwrap();
    image::RgbaImage::new(32, 24)
        .save_with_format(&input, image::ImageFormat::Png)
        .unwrap();
    assert!(convert(&req).await.is_err());
    assert!(!Path::new(&req.output_path).exists());
    std::fs::write(&input, b"broken image").unwrap();
    assert!(convert(&req).await.is_err());
    let input = d.path().join("jpeg-in-png.png");
    source(&input, 32, 24);
    let mut req = request(
        &input,
        &d.path().join("actual.jpg"),
        75,
        ImageResize::Original,
    );
    req.metadata_policy = Some(MetadataPolicy::Preserve);
    assert!(convert(&req).await.is_ok());
}

#[tokio::test]
async fn genuine_heic_is_fitted_and_avif_renamed_heic_is_refused() {
    let d = tempfile::tempdir().unwrap();
    let input = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sample.heic");
    let req = request(
        &input,
        &d.path().join("heic.jpg"),
        75,
        ImageResize::FitWithin {
            width: 32,
            height: 24,
        },
    );
    let out = convert(&req).await.unwrap();
    assert_eq!(image::image_dimensions(out.output_path).unwrap(), (24, 24));
    let fake = d.path().join("avif.heic");
    image::RgbImage::new(32, 24)
        .save_with_format(&fake, image::ImageFormat::Avif)
        .unwrap();
    let req = request(&fake, &d.path().join("fake.jpg"), 75, ImageResize::Original);
    assert!(convert(&req).await.is_err());
    assert!(!Path::new(&req.output_path).exists());
}

#[tokio::test]
#[ignore = "requires private native fixture directory in GOOP_JPEG_FIXTURES"]
async fn native_proraw_and_heic_explicit_original_and_fit() {
    let fixtures =
        std::path::PathBuf::from(std::env::var("GOOP_JPEG_FIXTURES").expect("fixture directory"));
    let d = tempfile::tempdir().unwrap();
    for name in ["public-proraw-12mp.dng", "IMG_1405.DNG", "photo.heic"] {
        let input = fixtures.join(name);
        let original = std::fs::read(&input).unwrap();
        let probe = goop_converter::imagemagick_probe::probe_image(&input).unwrap();
        let source = probe.width.zip(probe.height).unwrap();
        for (quality, resize) in [
            (75, ImageResize::Original),
            (
                90,
                ImageResize::FitWithin {
                    width: 2048,
                    height: 2048,
                },
            ),
        ] {
            let expected =
                goop_converter::image_options::output_dimensions(source, &resize).unwrap();
            let req = request(
                &input,
                &d.path().join(format!("{name}-{quality}.jpg")),
                quality,
                resize,
            );
            let started = std::time::Instant::now();
            let out = convert(&req).await.unwrap();
            assert_eq!(image::image_dimensions(&out.output_path).unwrap(), expected);
            eprintln!(
                "{name} q{quality}: {expected:?}, {} bytes, {:?}",
                out.bytes,
                started.elapsed()
            );
        }
        assert_eq!(std::fs::read(input).unwrap(), original);
    }
}

#[tokio::test]
async fn genuine_alpha_heic_is_refused_without_flattening() {
    // A 64×64 RGBA gradient encoded with macOS ImageIO; the left half is translucent.
    let input = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/alpha.heic");
    let probe = goop_converter::imagemagick_probe::probe_image(&input).unwrap();
    assert_eq!(probe.image_format.as_deref(), Some("HEIC"));
    assert_eq!(probe.image_has_alpha, Some(true));
    let d = tempfile::tempdir().unwrap();
    let req = request(&input, &d.path().join("out.jpg"), 75, ImageResize::Original);
    let error = convert(&req).await.unwrap_err();
    assert!(error.to_string().contains("transparency"));
    assert!(!Path::new(&req.output_path).exists());
}

#[tokio::test]
async fn oversized_jpeg_header_is_rejected_before_raster_decode() {
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("in.jpg");
    source(&input, 32, 24);
    let mut jpeg = Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
    let segment = jpeg
        .segments_mut()
        .iter_mut()
        .find(|s| s.marker() == 0xc0)
        .unwrap();
    let mut contents = segment.contents().to_vec();
    contents[1..3].copy_from_slice(&10001u16.to_be_bytes());
    contents[3..5].copy_from_slice(&10000u16.to_be_bytes());
    *segment = img_parts::jpeg::JpegSegment::new_with_contents(0xc0, contents.into());
    jpeg.encoder()
        .write_to(std::fs::File::create(&input).unwrap())
        .unwrap();
    let req = request(&input, &d.path().join("out.jpg"), 75, ImageResize::Original);
    let error = convert(&req).await.unwrap_err();
    assert!(error.to_string().contains("100-million"), "{error}");
    assert!(!Path::new(&req.output_path).exists());
}

#[tokio::test]
async fn duplicate_exif_segments_are_ambiguous_under_preserve() {
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("in.jpg");
    source(&input, 32, 24);
    let mut jpeg = Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
    jpeg.set_exif(Some(orientation_exif().into()));
    let duplicate = jpeg
        .segments()
        .iter()
        .find(|s| s.marker() == 0xe1)
        .unwrap()
        .clone();
    jpeg.segments_mut().insert(0, duplicate);
    jpeg.encoder()
        .write_to(std::fs::File::create(&input).unwrap())
        .unwrap();
    let mut req = request(&input, &d.path().join("out.jpg"), 75, ImageResize::Original);
    req.metadata_policy = Some(MetadataPolicy::Preserve);
    assert!(convert(&req).await.is_err());
    assert!(!Path::new(&req.output_path).exists());
}

#[tokio::test]
async fn rgb_reencoding_preserve_refuses_non_rgb_icc_before_publication() {
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("in.jpg");
    source(&input, 32, 24);
    let mut profile = vec![0; 128];
    profile[..4].copy_from_slice(&128u32.to_be_bytes());
    profile[16..20].copy_from_slice(b"CMYK");
    profile[36..40].copy_from_slice(b"acsp");
    let mut jpeg = Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
    jpeg.set_icc_profile(Some(profile.into()));
    jpeg.encoder()
        .write_to(std::fs::File::create(&input).unwrap())
        .unwrap();

    let resolver = goop_sidecar::BinaryResolver::new(d.path().to_owned());
    for (name, mode) in [
        ("ordinary", None),
        ("quality", Some(CompressMode::Quality(75))),
        ("target", Some(CompressMode::TargetSizeBytes(100_000))),
    ] {
        let output = d.path().join(format!("{name}.jpg"));
        let mut req = request(&input, &output, 75, ImageResize::Original);
        req.image_options = None;
        req.compress_mode = mode;
        req.metadata_policy = Some(MetadataPolicy::Preserve);

        let admission = goop_converter::capabilities::validate_request_source(&resolver, &req)
            .await
            .unwrap_err();
        assert!(admission.user_message().contains("RGB ICC profile"));
        let execution = convert(&req).await.unwrap_err();
        assert!(execution.user_message().contains("RGB ICC profile"));
        assert!(!output.exists());
    }
}

#[tokio::test]
async fn explicit_preserve_refuses_cmyk_source_before_publication() {
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("cmyk.jpg");
    source(&input, 32, 24);
    let mut profile = vec![0; 128];
    profile[..4].copy_from_slice(&128u32.to_be_bytes());
    profile[16..20].copy_from_slice(b"CMYK");
    profile[36..40].copy_from_slice(b"acsp");
    let mut jpeg = Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
    let frame = jpeg
        .segments_mut()
        .iter_mut()
        .find(|segment| {
            (0xc0..=0xcf).contains(&segment.marker())
                && !matches!(segment.marker(), 0xc4 | 0xc8 | 0xcc)
        })
        .unwrap();
    let marker = frame.marker();
    let mut contents = frame.contents().to_vec();
    contents[5] = 4;
    contents.extend_from_slice(&[4, 0x11, 0]);
    *frame = img_parts::jpeg::JpegSegment::new_with_contents(marker, contents.into());
    jpeg.set_icc_profile(Some(profile.into()));
    jpeg.encoder()
        .write_to(std::fs::File::create(&input).unwrap())
        .unwrap();

    let output = d.path().join("out.jpg");
    let mut req = request(&input, &output, 75, ImageResize::Original);
    req.metadata_policy = Some(MetadataPolicy::Preserve);
    let resolver = goop_sidecar::BinaryResolver::new(d.path().to_owned());

    let admission = goop_converter::capabilities::validate_request_source(&resolver, &req)
        .await
        .unwrap_err();
    assert!(admission.user_message().contains("converted to RGB"));
    let execution = convert(&req).await.unwrap_err();
    assert!(execution.user_message().contains("converted to RGB"));
    assert!(!output.exists());
}

#[tokio::test]
async fn absent_options_keep_legacy_jpeg_behavior_and_default_quality() {
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("in.jpg");
    source(&input, 160, 120);
    let mut legacy = request(
        &input,
        &d.path().join("legacy.jpg"),
        75,
        ImageResize::Original,
    );
    legacy.image_options = None;
    let old = convert(&legacy).await.unwrap();
    let explicit = request(
        &input,
        &d.path().join("explicit.jpg"),
        75,
        ImageResize::Original,
    );
    let new = convert(&explicit).await.unwrap();
    assert_eq!(
        std::fs::read(old.output_path).unwrap(),
        std::fs::read(new.output_path).unwrap()
    );
    let mut jpeg = Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
    jpeg.set_exif(Some(orientation_exif().into()));
    jpeg.encoder()
        .write_to(std::fs::File::create(&input).unwrap())
        .unwrap();
    legacy.output_path = d
        .path()
        .join("legacy-oriented.jpg")
        .to_string_lossy()
        .into_owned();
    legacy.metadata_policy = Some(MetadataPolicy::Preserve);
    let out = convert(&legacy).await.unwrap();
    assert_eq!(
        image::image_dimensions(&out.output_path).unwrap(),
        (160, 120)
    );
    assert_eq!(
        goop_converter::metadata::read(Path::new(&out.output_path))
            .unwrap()
            .0
            .unwrap(),
        orientation_exif()
    );
}

fn scalar_orientation(little: bool, kind: u16, value: u32) -> Vec<u8> {
    let mut bytes = if little {
        b"II".to_vec()
    } else {
        b"MM".to_vec()
    };
    let short = |v: u16| {
        if little {
            v.to_le_bytes()
        } else {
            v.to_be_bytes()
        }
    };
    let long = |v: u32| {
        if little {
            v.to_le_bytes()
        } else {
            v.to_be_bytes()
        }
    };
    bytes.extend(short(42));
    bytes.extend(long(8));
    bytes.extend(short(1));
    bytes.extend(short(0x0112));
    bytes.extend(short(kind));
    bytes.extend(long(1));
    if kind == 3 {
        bytes.extend(short(value as u16));
        bytes.extend([0, 0]);
    } else {
        bytes.extend(long(value));
    }
    bytes.extend(long(0));
    bytes
}
#[tokio::test]
async fn long_orientation_matches_upright_probe_and_encoded_quadrants_in_both_endiannesses() {
    for little in [true, false] {
        let d = tempfile::tempdir().unwrap();
        let input = d.path().join("long.png");
        image::RgbImage::from_fn(160, 120, |x, y| {
            image::Rgb(match (x < 80, y < 60) {
                (true, true) => [255u8, 0, 0],
                (false, true) => [0, 255, 0],
                (true, false) => [0, 0, 255],
                _ => [255, 255, 0],
            })
        })
        .save_with_format(&input, image::ImageFormat::Jpeg)
        .unwrap();
        let mut jpeg = Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
        jpeg.set_exif(Some(scalar_orientation(little, 4, 6).into()));
        jpeg.encoder()
            .write_to(std::fs::File::create(&input).unwrap())
            .unwrap();
        let probe = goop_converter::imagemagick_probe::probe_image(&input).unwrap();
        assert_eq!(probe.width.zip(probe.height), Some((120, 160)));
        let mut req = request(
            &input,
            &d.path().join("out.jpg"),
            90,
            ImageResize::FitWithin {
                width: 120,
                height: 120,
            },
        );
        req.metadata_policy = Some(MetadataPolicy::Preserve);
        let out = convert(&req).await.unwrap();
        let pixels = image::open(&out.output_path).unwrap().to_rgb8();
        assert_eq!(pixels.dimensions(), (90, 120));
        for (x, y, expected) in [
            (20, 20, [0, 0, 255]),
            (70, 20, [255, 0, 0]),
            (20, 100, [255, 255, 0]),
            (70, 100, [0, 255, 0]),
        ] {
            for (actual, expected) in pixels.get_pixel(x, y).0.into_iter().zip(expected) {
                assert!((i32::from(actual) - expected).abs() < 25);
            }
        }
        assert_eq!(
            goop_converter::metadata::read(Path::new(&out.output_path))
                .unwrap()
                .0
                .unwrap(),
            scalar_orientation(little, 4, 1)
        );
    }
}
#[tokio::test]
async fn invalid_orientation_refuses_preserve_and_privacy_modes() {
    for little in [true, false] {
        for kind in [3, 4] {
            for orientation in [0, 9, 255] {
                let d = tempfile::tempdir().unwrap();
                let input = d.path().join("in.jpg");
                source(&input, 32, 24);
                let mut jpeg = Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
                jpeg.set_exif(Some(scalar_orientation(little, kind, orientation).into()));
                jpeg.encoder()
                    .write_to(std::fs::File::create(&input).unwrap())
                    .unwrap();
                let mut req = request(
                    &input,
                    &d.path().join("preserve.jpg"),
                    75,
                    ImageResize::Original,
                );
                req.metadata_policy = Some(MetadataPolicy::Preserve);
                assert!(convert(&req).await.is_err());
                assert!(!Path::new(&req.output_path).exists());
                req.output_path = d.path().join("strip.jpg").to_string_lossy().into_owned();
                req.metadata_policy = Some(MetadataPolicy::StripAll);
                assert!(convert(&req).await.is_err());
                assert!(!Path::new(&req.output_path).exists());
            }
        }
    }
}

#[tokio::test]
async fn explicit_admission_preserves_routing_and_uses_the_actual_image_header() {
    let d = tempfile::tempdir().unwrap();
    let input = d.path().join("jpeg.png");
    source(&input, 32, 24);
    let resolver = goop_sidecar::BinaryResolver::new(d.path().to_owned());
    let mut req = request(&input, &d.path().join("out.jpg"), 75, ImageResize::Original);
    goop_converter::capabilities::validate_request_source(&resolver, &req)
        .await
        .unwrap();
    let video_path = d.path().join("jpeg.mp4");
    std::fs::rename(&input, &video_path).unwrap();
    req.input_path = video_path.to_string_lossy().into_owned();
    assert!(
        goop_converter::capabilities::validate_request_source(&resolver, &req)
            .await
            .is_err()
    );
    req.input_path = input.to_string_lossy().into_owned();
    image::RgbImage::new(32, 24).save(&input).unwrap();
    assert!(
        goop_converter::capabilities::validate_request_source(&resolver, &req)
            .await
            .is_err()
    );
    req.image_color_policy = Some(goop_core::ImageColorPolicy::AssumeSrgb);
    goop_converter::capabilities::validate_request_source(&resolver, &req)
        .await
        .unwrap();
    image::RgbImage::new(32, 24)
        .save_with_format(&input, image::ImageFormat::WebP)
        .unwrap();
    assert!(
        goop_converter::capabilities::validate_request_source(&resolver, &req)
            .await
            .is_err()
    );
}
