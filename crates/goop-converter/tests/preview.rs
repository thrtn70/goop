use goop_converter::preview::{bounded_dimensions, validate_pixels};
#[test]
fn preview_limits_reject_invalid_or_oversized_sources() {
    assert!(validate_pixels(0, 100).is_err());
    assert!(validate_pixels(8064, 6048).is_err());
    assert!(validate_pixels(2000, 2000).is_ok());
    assert_eq!(bounded_dimensions(4000, 2000, 1280), (1280, 640));
}
use goop_converter::preview::PreviewService;
use goop_core::{PreviewRequest, TargetFormat};
use goop_sidecar::BinaryResolver;
fn request(path: &std::path::Path, id: &str) -> PreviewRequest {
    serde_json::from_value(serde_json::json!({"request_id":id,"input_path":path,"source_revision":"1","target":"jpeg","quality_preset":null,"resolution_cap":null,"compress_mode":null,"metadata_policy":null,"subtitle":null,"gif_options":null})).unwrap()
}
#[tokio::test]
async fn image_sample_is_bounded_and_source_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("source.png");
    image::RgbImage::from_pixel(1600, 800, image::Rgb([100, 80, 40]))
        .save(&input)
        .unwrap();
    let original = std::fs::read(&input).unwrap();
    let service = PreviewService::new(dir.path().join("previews"));
    let result = service
        .generate(
            &BinaryResolver::new(dir.path().into()),
            request(&input, "one"),
        )
        .await
        .unwrap();
    assert_eq!((result.width, result.height), (1280, 640));
    let before = image::open(result.before_path.unwrap()).unwrap();
    let after = image::open(&result.after_path).unwrap();
    assert_eq!(
        (before.width(), before.height()),
        (after.width(), after.height())
    );
    assert_eq!(std::fs::read(input).unwrap(), original);
    service.cancel("one");
    assert!(!std::path::Path::new(&result.after_path).exists());
}
#[tokio::test]
async fn target_size_and_unsupported_sources_fail_without_artifacts() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("large.dng");
    std::fs::write(&input, b"bad raw").unwrap();
    let service = PreviewService::new(dir.path().join("previews"));
    let mut req = request(&input, "raw");
    assert!(service
        .generate(&BinaryResolver::new(dir.path().into()), req.clone())
        .await
        .unwrap_err()
        .to_string()
        .contains("unavailable"));
    req.target = TargetFormat::Jpeg;
    req.compress_mode = Some(goop_core::CompressMode::TargetSizeBytes(100));
    assert!(service
        .generate(&BinaryResolver::new(dir.path().into()), req)
        .await
        .unwrap_err()
        .to_string()
        .contains("target-size"));
}
#[tokio::test]
async fn replaced_request_cannot_publish_and_leaves_one_preview() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("source.png");
    image::RgbImage::from_pixel(1600, 800, image::Rgb([30, 60, 90]))
        .save(&input)
        .unwrap();
    let service = PreviewService::new(dir.path().join("previews"));
    let resolver = BinaryResolver::new(dir.path().into());
    let (old, new) = tokio::join!(
        service.generate(&resolver, request(&input, "old")),
        service.generate(&resolver, request(&input, "new"))
    );
    assert!(matches!(old, Err(goop_core::GoopError::Cancelled)));
    let result = new.unwrap();
    assert!(std::path::Path::new(&result.after_path).exists());
    service.cancel("old");
    assert!(std::path::Path::new(&result.after_path).exists());
}
#[tokio::test]
#[ignore = "requires bundled FFmpeg and local fixture environment variables"]
async fn real_video_sample_decodes_and_is_muted_bounded() {
    use goop_converter::ConversionBackend;
    let dir = tempfile::tempdir().unwrap();
    let input = std::path::PathBuf::from(std::env::var("GOOP_PREVIEW_VIDEO").unwrap());
    let resolver = BinaryResolver::new(std::env::var("GOOP_PREVIEW_SIDECARS").unwrap().into());
    let service = PreviewService::new(dir.path().join("previews"));
    let mut req = request(&input, "video");
    req.target = TargetFormat::Mp4;
    let result = service.generate(&resolver, req).await.unwrap();
    let output = std::path::Path::new(&result.after_path);
    let probe = goop_converter::FfmpegBackend::probe(&resolver, output)
        .await
        .unwrap();
    assert!(probe.has_video);
    assert!(!probe.has_audio);
    assert!(probe.duration_ms <= 3040);
    assert!(probe.width.unwrap() <= 1280);
    assert!(probe.height.unwrap() <= 1280);
    let status = std::process::Command::new(resolver.resolve("ffmpeg").unwrap().path)
        .args(["-v", "error", "-xerror", "-i"])
        .arg(output)
        .args(["-f", "null", "-"])
        .status()
        .unwrap();
    assert!(status.success());
    service.cancel("video");
    assert!(!output.exists());
}
#[tokio::test]
async fn jpeg_orientation_is_shared_by_both_samples() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("oriented.jpg");
    image::RgbImage::from_pixel(20, 10, image::Rgb([80, 120, 160]))
        .save(&input)
        .unwrap();
    let jpeg = std::fs::read(&input).unwrap();
    let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
    let mut bytes = jpeg[..2].to_vec();
    bytes.extend_from_slice(&[255, 225]);
    bytes.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
    bytes.extend_from_slice(exif);
    bytes.extend_from_slice(&jpeg[2..]);
    std::fs::write(&input, bytes).unwrap();
    let service = PreviewService::new(dir.path().join("previews"));
    let result = service
        .generate(
            &BinaryResolver::new(dir.path().into()),
            request(&input, "oriented"),
        )
        .await
        .unwrap();
    assert_eq!((result.width, result.height), (10, 20));
    for path in [result.before_path.unwrap(), result.after_path] {
        let image = image::open(path).unwrap();
        assert_eq!((image.width(), image.height()), (10, 20));
    }
}
#[test]
fn stale_cleanup_removes_only_marked_session_directories() {
    use goop_converter::preview::cleanup_stale_sessions;
    let dir = tempfile::tempdir().unwrap();
    let owned = dir.path().join("session-old");
    let unrelated = dir.path().join("session-user");
    std::fs::create_dir(&owned).unwrap();
    std::fs::write(owned.join(".goop-preview-session"), b"v1").unwrap();
    std::fs::write(owned.join("sample.png"), b"owned").unwrap();
    std::fs::create_dir(&unrelated).unwrap();
    std::fs::write(unrelated.join("source"), b"keep").unwrap();
    cleanup_stale_sessions(dir.path()).unwrap();
    assert!(!owned.exists());
    assert!(unrelated.join("source").exists());
}
#[cfg(unix)]
#[test]
fn stale_cleanup_never_follows_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join(".goop-preview-session"), b"v1").unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("session-link")).unwrap();
    goop_converter::preview::cleanup_stale_sessions(dir.path()).unwrap();
    assert!(outside.path().join(".goop-preview-session").exists());
}

fn explicit_request(path: &std::path::Path, id: &str, quality: u8) -> PreviewRequest {
    let mut req = request(path, id);
    req.image_options = Some(goop_core::ImageConvertOptions {
        jpeg_quality: quality,
        resize: goop_core::ImageResize::Original,
    });
    req
}

#[tokio::test]
async fn explicit_grayscale_sample_preserves_channels_and_encoded_byte_count() {
    use img_parts::{jpeg::Jpeg, ImageEXIF, ImageICC};
    let dir = tempfile::tempdir().unwrap();
    let service = PreviewService::new(dir.path().join("previews"));
    let resolver = BinaryResolver::new(dir.path().into());
    for (index, (grayscale, explicit, size)) in [
        (true, true, (64, 48)),
        (true, true, (1600, 800)),
        (true, false, (64, 48)),
        (false, true, (64, 48)),
    ]
    .into_iter()
    .enumerate()
    {
        let input = dir.path().join(format!("source-{index}.jpg"));
        if grayscale {
            image::GrayImage::from_fn(size.0, size.1, |x, y| {
                image::Luma([((x * 7 + y * 13) % 256) as u8])
            })
            .save(&input)
            .unwrap();
        } else {
            image::RgbImage::from_fn(size.0, size.1, |x, y| image::Rgb([x as u8, y as u8, 80]))
                .save(&input)
                .unwrap();
        }
        let mut jpeg = Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
        jpeg.set_exif(Some(
            b"II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0"
                .to_vec()
                .into(),
        ));
        let mut profile = vec![0; 128];
        profile[16..20].copy_from_slice(if grayscale { b"GRAY" } else { b"RGB " });
        jpeg.set_icc_profile(Some(profile.into()));
        jpeg.encoder()
            .write_to(std::fs::File::create(&input).unwrap())
            .unwrap();
        let original = std::fs::read(&input).unwrap();
        let id = format!("channels-{index}");
        let req = if explicit {
            explicit_request(&input, &id, 75)
        } else {
            request(&input, &id)
        };
        let result = service.generate(&resolver, req).await.unwrap();
        assert_eq!(
            (result.width, result.height),
            bounded_dimensions(size.1, size.0, 1280)
        );
        let before = image::open(result.before_path.as_ref().unwrap()).unwrap();
        let mut encoded = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 75);
        if explicit && grayscale {
            encoder.encode_image(before.as_luma8().unwrap()).unwrap();
        } else {
            encoder.encode_image(&before.to_rgb8()).unwrap();
        }
        assert_eq!(result.sample_bytes as usize, encoded.len());
        let after = image::open(&result.after_path).unwrap();
        let decoded = image::load_from_memory(&encoded).unwrap();
        assert_eq!(
            after.color(),
            if explicit && grayscale {
                image::ColorType::L8
            } else {
                image::ColorType::Rgb8
            }
        );
        assert_eq!(after.as_bytes(), decoded.as_bytes());
        for path in [result.before_path.unwrap(), result.after_path] {
            assert_eq!(
                goop_converter::metadata::read(std::path::Path::new(&path)).unwrap(),
                (None, None)
            );
        }
        assert_eq!(std::fs::read(&input).unwrap(), original);
        service.cancel(&id);
    }
}
fn textured_jpeg(path: &std::path::Path) {
    image::RgbImage::from_fn(160, 100, |x, y| {
        image::Rgb([
            (x * 17 + y * 31) as u8,
            (x * 7 + y * 11) as u8,
            (x * y) as u8,
        ])
    })
    .save(path)
    .unwrap();
}
#[tokio::test]
async fn explicit_quality_changes_encoded_sample_and_default_matches_legacy() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("textured.jpg");
    textured_jpeg(&input);
    let original = std::fs::read(&input).unwrap();
    let service = PreviewService::new(dir.path().join("previews"));
    let resolver = BinaryResolver::new(dir.path().into());
    let low = service
        .generate(&resolver, explicit_request(&input, "low", 30))
        .await
        .unwrap();
    let low_pixels = std::fs::read(&low.after_path).unwrap();
    let high = service
        .generate(&resolver, explicit_request(&input, "high", 90))
        .await
        .unwrap();
    assert!(low.sample_bytes < high.sample_bytes);
    assert_ne!(low_pixels, std::fs::read(&high.after_path).unwrap());
    let legacy = service
        .generate(&resolver, request(&input, "legacy"))
        .await
        .unwrap();
    let legacy_pixels = std::fs::read(&legacy.after_path).unwrap();
    let explicit = service
        .generate(&resolver, explicit_request(&input, "default", 75))
        .await
        .unwrap();
    assert_eq!(legacy.sample_bytes, explicit.sample_bytes);
    assert_eq!(legacy_pixels, std::fs::read(&explicit.after_path).unwrap());
    assert_eq!(std::fs::read(&input).unwrap(), original);
}
#[tokio::test]
async fn explicit_fit_is_refused_before_decoding_or_creating_artifacts() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("not-decoded.jpg");
    std::fs::write(&input, b"invalid jpeg").unwrap();
    let root = dir.path().join("previews");
    let service = PreviewService::new(root.clone());
    let mut req = explicit_request(&input, "fit", 90);
    req.image_options.as_mut().unwrap().resize = goop_core::ImageResize::FitWithin {
        width: 64,
        height: 64,
    };
    let error = service
        .generate(&BinaryResolver::new(dir.path().into()), req)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Fit within"), "{error}");
    assert!(!root.exists());
}
#[tokio::test]
async fn explicit_requests_revalidate_quality_target_compression_and_actual_codec() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("source.jpg");
    textured_jpeg(&input);
    let resolver = BinaryResolver::new(dir.path().into());
    for case in 0..8 {
        let root = dir.path().join(format!("previews-{case}"));
        let service = PreviewService::new(root.clone());
        let mut req = explicit_request(&input, "invalid", 75);
        match case {
            0 => req.image_options.as_mut().unwrap().jpeg_quality = 0,
            1 => req.image_options.as_mut().unwrap().jpeg_quality = 101,
            2 => req.target = TargetFormat::Png,
            3 => req.compress_mode = Some(goop_core::CompressMode::Quality(80)),
            4 => req.quality_preset = Some(goop_core::QualityPreset::Balanced),
            5 => req.resolution_cap = Some(goop_core::ResolutionCap::R720p),
            6 => req.target = TargetFormat::Mp4,
            _ => {
                // A JPEG extension does not grant execution authority to PNG pixels.
                image::RgbImage::new(10, 10)
                    .save_with_format(&input, image::ImageFormat::Png)
                    .unwrap();
            }
        }
        assert!(
            service.generate(&resolver, req).await.is_err(),
            "case {case}"
        );
        if root.exists() {
            for session in std::fs::read_dir(&root).unwrap() {
                assert_eq!(
                    std::fs::read_dir(session.unwrap().path()).unwrap().count(),
                    1
                );
            }
        }
    }
}
#[tokio::test]
async fn explicit_preview_uses_short_and_long_orientation_in_both_samples() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("oriented.jpg");
    let service = PreviewService::new(dir.path().join("previews"));
    let resolver = BinaryResolver::new(dir.path().into());
    for kind in [3u16, 4] {
        for orientation in 1u32..=8 {
            textured_jpeg(&input);
            let jpeg = std::fs::read(&input).unwrap();
            let mut exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01".to_vec();
            exif.extend(kind.to_le_bytes());
            exif.extend(1u32.to_le_bytes());
            exif.extend(orientation.to_le_bytes());
            exif.extend(0u32.to_le_bytes());
            let mut bytes = jpeg[..2].to_vec();
            bytes.extend([255, 225]);
            bytes.extend(((exif.len() + 2) as u16).to_be_bytes());
            bytes.extend(exif);
            bytes.extend(&jpeg[2..]);
            std::fs::write(&input, bytes).unwrap();
            let mut expected = image::load_from_memory(&jpeg).unwrap();
            expected.apply_orientation(
                image::metadata::Orientation::from_exif(orientation as u8).unwrap(),
            );
            let result = service
                .generate(&resolver, explicit_request(&input, "oriented", 75))
                .await
                .unwrap();
            assert_eq!(
                (result.width, result.height),
                (expected.width(), expected.height()),
                "kind {kind}, orientation {orientation}"
            );
            assert!(
                image::open(result.before_path.unwrap()).unwrap().to_rgb8() == expected.to_rgb8(),
                "kind {kind}, orientation {orientation}"
            );
            let after = image::open(result.after_path).unwrap();
            assert_eq!(
                (after.width(), after.height()),
                (expected.width(), expected.height())
            );
        }
    }
}

#[tokio::test]
async fn explicit_raw_heic_and_oversized_sources_stay_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let resolver = BinaryResolver::new(dir.path().into());
    for ext in ["dng", "heic", "heif"] {
        let input = dir.path().join(format!("source.{ext}"));
        std::fs::write(&input, b"unsupported source").unwrap();
        let root = dir.path().join(format!("previews-{ext}"));
        let service = PreviewService::new(root.clone());
        let error = service
            .generate(&resolver, explicit_request(&input, "unsupported", 75))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("unavailable"), "{error}");
        assert!(!root.exists());
    }
    for dimensions in [(2001, 2000), (40_000, 1)] {
        let input = dir.path().join("oversized.jpg");
        image::RgbImage::new(dimensions.0, dimensions.1)
            .save(&input)
            .unwrap();
        let service = PreviewService::new(dir.path().join("previews-large"));
        assert!(
            service
                .generate(&resolver, explicit_request(&input, "large", 75))
                .await
                .is_err(),
            "{dimensions:?}"
        );
    }
    let input = dir.path().join("encoded-large.jpg");
    let file = std::fs::File::create(&input).unwrap();
    file.set_len(64 * 1024 * 1024 + 1).unwrap();
    let service = PreviewService::new(dir.path().join("previews-bytes"));
    let error = service
        .generate(&resolver, explicit_request(&input, "bytes", 75))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("64 MiB"), "{error}");
}
#[tokio::test]
async fn explicit_malformed_orientation_fails_preserve_but_strip_can_sample() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("malformed.jpg");
    textured_jpeg(&input);
    let jpeg = std::fs::read(&input).unwrap();
    let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x04\0\x01\0\0\0\x09\0\0\0\0\0\0\0";
    let mut bytes = jpeg[..2].to_vec();
    bytes.extend([255, 225]);
    bytes.extend(((exif.len() + 2) as u16).to_be_bytes());
    bytes.extend(exif);
    bytes.extend(&jpeg[2..]);
    std::fs::write(&input, bytes).unwrap();
    let service = PreviewService::new(dir.path().join("previews"));
    let resolver = BinaryResolver::new(dir.path().into());
    let mut req = explicit_request(&input, "metadata", 75);
    assert!(service
        .generate(&resolver, req.clone())
        .await
        .unwrap_err()
        .to_string()
        .contains("EXIF"));
    req.metadata_policy = Some(goop_core::MetadataPolicy::StripAll);
    let sample = service.generate(&resolver, req).await.unwrap();
    assert_eq!((sample.width, sample.height), (160, 100));
}
