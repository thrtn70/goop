use goop_converter::capabilities::{capabilities_for, validate_request};
use goop_converter::image_options::{output_dimensions, validate_options};
use goop_core::{
    CompressMode, ConvertRequest, GifOptions, GifSizePreset, ImageConvertOptions, ImageResize,
    MetadataPolicy, ProbeResult, QualityPreset, ResolutionCap, SubtitleMode, SubtitleOptions,
    TargetFormat,
};
fn probe(format: &str) -> ProbeResult {
    serde_json::from_value(serde_json::json!({"duration_ms":0,"width":2,"height":2,"video_codec":null,"audio_codec":null,"file_size":4,"container":null,"has_video":false,"has_audio":false,"source_kind":"image","color_space":null,"image_format":format})).unwrap()
}
fn request(target: TargetFormat, mode: Option<CompressMode>) -> ConvertRequest {
    serde_json::from_value(serde_json::json!({"input_path":"/tmp/input.webp","output_path":"/tmp/output.webp","target":target,"compress_mode":mode})).unwrap()
}

fn explicit_options() -> ImageConvertOptions {
    ImageConvertOptions {
        jpeg_quality: 75,
        resize: ImageResize::Original,
    }
}

fn opaque_probe(format: &str) -> ProbeResult {
    let mut value = probe(format);
    value.image_has_alpha = Some(false);
    value
}

#[test]
fn image_option_numeric_bounds_and_geometry_are_checked() {
    for quality in [0, 101] {
        let options = ImageConvertOptions {
            jpeg_quality: quality,
            resize: ImageResize::Original,
        };
        assert!(validate_options(&options).is_err(), "quality {quality}");
    }
    for (width, height) in [(0, 1), (1, 0), (32769, 1), (1, 32769)] {
        let options = ImageConvertOptions {
            jpeg_quality: 75,
            resize: ImageResize::FitWithin { width, height },
        };
        assert!(validate_options(&options).is_err(), "{width}x{height}");
    }
    for (source, resize, expected) in [
        (
            (6048, 8064),
            ImageResize::FitWithin {
                width: 2048,
                height: 2048,
            },
            (1536, 2048),
        ),
        (
            (8064, 6048),
            ImageResize::FitWithin {
                width: 2048,
                height: 2048,
            },
            (2048, 1536),
        ),
        (
            (900, 1200),
            ImageResize::FitWithin {
                width: 2048,
                height: 2048,
            },
            (900, 1200),
        ),
        (
            (5, 3),
            ImageResize::FitWithin {
                width: 3,
                height: 3,
            },
            (3, 2),
        ),
        (
            (1, 32768),
            ImageResize::FitWithin {
                width: 1,
                height: 32768,
            },
            (1, 32768),
        ),
        ((640, 480), ImageResize::Original, (640, 480)),
    ] {
        assert_eq!(output_dimensions(source, &resize).unwrap(), expected);
    }
    for (source, resize) in [
        ((0, 100), ImageResize::Original),
        ((100, 0), ImageResize::Original),
        ((32769, 1), ImageResize::Original),
        ((10_001, 10_000), ImageResize::Original),
        (
            (100, 100),
            ImageResize::FitWithin {
                width: 32769,
                height: 100,
            },
        ),
    ] {
        assert!(output_dimensions(source, &resize).is_err(), "{source:?}");
    }
}

#[test]
fn jpeg_capabilities_report_shared_bounds_and_preview_truth() {
    let capabilities = capabilities_for(&opaque_probe("jpeg"));
    let jpeg = capabilities
        .targets
        .iter()
        .find(|capability| capability.target == TargetFormat::Jpeg)
        .unwrap();
    let settings = jpeg.image_settings.as_ref().unwrap();
    assert!(settings.available);
    assert_eq!(settings.reason, None);
    assert_eq!(settings.quality_min, 1);
    assert_eq!(settings.quality_max, 100);
    assert_eq!(settings.default_quality, 75);
    assert_eq!(settings.max_dimension, 32768);
    assert_eq!(settings.max_output_pixels, 100_000_000);
    assert!(settings.fit_within);
    assert!(!settings.upscale);
    assert!(settings.preview_original_available);
    assert!(!settings.preview_fit_within);
    assert!(settings.preview_unavailable_reason.is_some());
    assert!(capabilities
        .targets
        .iter()
        .filter(|capability| capability.target != TargetFormat::Jpeg)
        .all(|capability| capability.image_settings.is_none()));

    let mut preview_limited = opaque_probe("jpeg");
    preview_limited.width = Some(2001);
    preview_limited.height = Some(2000);
    let settings = capabilities_for(&preview_limited)
        .targets
        .into_iter()
        .find(|capability| capability.target == TargetFormat::Jpeg)
        .unwrap()
        .image_settings
        .unwrap();
    assert!(settings.available);
    assert!(!settings.preview_original_available);
    assert!(settings.preview_unavailable_reason.is_some());
}

#[test]
fn heic_and_raw_image_settings_fail_closed_when_support_is_uncertain() {
    for alpha in [Some(false), Some(true), None] {
        let mut source = probe("heic");
        source.image_has_alpha = alpha;
        let settings = capabilities_for(&source)
            .targets
            .into_iter()
            .find(|capability| capability.target == TargetFormat::Jpeg)
            .unwrap()
            .image_settings
            .unwrap();
        assert_eq!(settings.available, alpha == Some(false));
        assert_eq!(settings.reason.is_some(), alpha != Some(false));
        assert!(!settings.preview_original_available);
        assert!(settings.preview_unavailable_reason.is_some());
    }

    let settings = capabilities_for(&opaque_probe("RAW"))
        .targets
        .into_iter()
        .find(|capability| capability.target == TargetFormat::Jpeg)
        .unwrap()
        .image_settings
        .unwrap();
    assert_eq!(settings.available, cfg!(target_os = "macos"));
    assert_eq!(settings.reason.is_some(), !cfg!(target_os = "macos"));
}

#[test]
fn explicit_image_settings_reject_unsupported_sources_and_collisions() {
    let mut request = request(TargetFormat::Jpeg, None);
    request.image_options = Some(explicit_options());
    assert!(validate_request(&request, &opaque_probe("jpeg")).is_ok());
    request.quality_preset = Some(QualityPreset::Original);
    request.resolution_cap = Some(ResolutionCap::Original);
    assert!(validate_request(&request, &opaque_probe("jpeg")).is_ok());
    request.quality_preset = None;
    request.resolution_cap = None;
    assert!(validate_request(&request, &probe("jpeg")).is_err());
    assert!(validate_request(&request, &opaque_probe("png")).is_err());
    request.image_color_policy = Some(goop_core::ImageColorPolicy::AssumeSrgb);
    assert!(validate_request(&request, &opaque_probe("png")).is_ok());
    request.image_color_policy = None;

    request.target = TargetFormat::Png;
    assert!(validate_request(&request, &opaque_probe("jpeg")).is_err());
    request.target = TargetFormat::Jpeg;

    request.compress_mode = Some(CompressMode::Quality(75));
    assert!(validate_request(&request, &opaque_probe("jpeg")).is_err());
    request.compress_mode = None;

    request.quality_preset = Some(QualityPreset::Balanced);
    assert!(validate_request(&request, &opaque_probe("jpeg")).is_err());
    request.quality_preset = None;
    request.resolution_cap = Some(ResolutionCap::R1080p);
    assert!(validate_request(&request, &opaque_probe("jpeg")).is_err());
    request.resolution_cap = None;

    request.gif_options = Some(GifOptions {
        size_preset: GifSizePreset::Small,
        trim_start_ms: None,
        trim_end_ms: None,
    });
    assert!(validate_request(&request, &opaque_probe("jpeg")).is_err());
    request.gif_options = None;
    request.subtitle = Some(SubtitleOptions {
        source_path: "/tmp/captions.srt".into(),
        mode: SubtitleMode::Soft,
    });
    assert!(validate_request(&request, &opaque_probe("jpeg")).is_err());

    let mut oversized = opaque_probe("jpeg");
    oversized.width = Some(10_001);
    oversized.height = Some(10_000);
    request.subtitle = None;
    assert!(validate_request(&request, &oversized).is_err());
}
#[test]
fn webp_offers_lossy_quality_and_lossless_reoptimization_but_not_target_size() {
    let p = probe("webp");
    let c = capabilities_for(&p);
    assert!(c.compression.quality);
    assert!(!c.compression.target_size);
    assert!(c.compression.lossless);
    assert!(c
        .compression
        .reason
        .as_deref()
        .is_some_and(|reason| reason.contains("Target Size")));
    for quality in [1, 50, 100] {
        assert!(validate_request(
            &request(TargetFormat::Webp, Some(CompressMode::Quality(quality))),
            &p
        )
        .is_ok());
    }
    for quality in [0, 101] {
        assert!(validate_request(
            &request(TargetFormat::Webp, Some(CompressMode::Quality(quality))),
            &p
        )
        .is_err());
    }
    assert!(validate_request(
        &request(TargetFormat::Webp, Some(CompressMode::TargetSizeBytes(100))),
        &p
    )
    .is_err());
    assert!(validate_request(
        &request(TargetFormat::Webp, Some(CompressMode::LosslessReoptimize)),
        &p
    )
    .is_ok());
}

#[test]
fn webp_quality_target_fails_closed_for_sources_outside_the_snapshot_matrix() {
    let p = probe("tiff");
    let capability = capabilities_for(&p)
        .targets
        .into_iter()
        .find(|target| target.target == TargetFormat::Webp)
        .unwrap()
        .compression
        .unwrap();
    assert!(!capability.quality);
    assert!(capability.lossless);
    assert!(capability
        .reason
        .as_deref()
        .is_some_and(|reason| reason.contains("JPEG, PNG and WebP")));
    assert!(validate_request(
        &request(TargetFormat::Webp, Some(CompressMode::Quality(75))),
        &p,
    )
    .is_err());
    assert!(validate_request(
        &request(TargetFormat::Webp, Some(CompressMode::LosslessReoptimize)),
        &p,
    )
    .is_ok());
}
#[test]
fn dng_has_all_image_outputs_with_platform_truth() {
    let c = capabilities_for(&probe("RAW"));
    assert_eq!(c.targets.len(), 7);
    for t in c.targets {
        assert_eq!(t.available, cfg!(target_os = "macos"));
        assert!(!t.preserves_metadata);
        assert!(t.metadata_warning.is_some());
    }
}
#[test]
fn rejects_incompatible_and_unsupported_modes() {
    assert!(validate_request(&request(TargetFormat::Mp4, None), &probe("jpeg")).is_err());
    for (fmt, target) in [
        ("avif", TargetFormat::Avif),
        ("jxl", TargetFormat::JpegXl),
        ("bmp", TargetFormat::Bmp),
    ] {
        assert!(validate_request(
            &request(target, Some(CompressMode::Quality(70))),
            &probe(fmt)
        )
        .is_err());
    }
    assert!(validate_request(
        &request(TargetFormat::Jpeg, Some(CompressMode::Quality(70))),
        &probe("jpeg")
    )
    .is_ok());
}

#[tokio::test]
async fn admission_revalidates_actual_source_instead_of_claimed_format() {
    use goop_converter::capabilities::validate_request_source;
    let dir = tempfile::tempdir().unwrap();
    let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_owned());
    let source = dir.path().join("source.png");
    image::RgbImage::new(2, 2).save(&source).unwrap();
    let mut req = request(TargetFormat::Mp4, None);
    req.input_path = source.to_string_lossy().into_owned();
    assert!(validate_request_source(&resolver, &req).await.is_err());
    req.target = TargetFormat::Png;
    assert!(validate_request_source(&resolver, &req).await.is_ok());
    std::fs::remove_file(source).unwrap();
    assert!(validate_request_source(&resolver, &req).await.is_err());
}

#[tokio::test]
async fn admission_enforces_source_bound_metadata_policy_availability() {
    use goop_converter::capabilities::validate_request_source;
    let dir = tempfile::tempdir().unwrap();
    let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_owned());
    let jpeg = dir.path().join("source.jpg");
    let png = dir.path().join("source.png");
    image::RgbImage::new(8, 8).save(&jpeg).unwrap();
    image::RgbImage::new(8, 8).save(&png).unwrap();

    let mut req = request(TargetFormat::Jpeg, None);
    req.metadata_policy = Some(MetadataPolicy::RemovePersonal);
    req.input_path = jpeg.to_string_lossy().into_owned();
    assert!(validate_request_source(&resolver, &req).await.is_ok());

    req.input_path = png.to_string_lossy().into_owned();
    let error = validate_request_source(&resolver, &req).await.unwrap_err();
    assert!(error.user_message().contains("JPEG to JPEG"));
}

#[tokio::test]
async fn ordinary_and_target_size_preserve_admission_keep_legacy_duplicate_exif_compatibility() {
    use goop_converter::capabilities::validate_request_source;
    use img_parts::{jpeg::Jpeg, jpeg::JpegSegment, Bytes};

    let dir = tempfile::tempdir().unwrap();
    let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_owned());
    let source = dir.path().join("duplicate-exif.jpg");
    image::RgbImage::new(8, 8).save(&source).unwrap();
    let mut jpeg = Jpeg::from_bytes(std::fs::read(&source).unwrap().into()).unwrap();
    for value in [1u16, 6] {
        let mut exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
        exif.extend_from_slice(&value.to_le_bytes());
        exif.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        jpeg.segments_mut()
            .insert(1, JpegSegment::new_with_contents(0xe1, Bytes::from(exif)));
    }
    std::fs::write(&source, jpeg.encoder().bytes()).unwrap();

    for mode in [None, Some(CompressMode::TargetSizeBytes(10_000))] {
        let mut req = request(TargetFormat::Jpeg, mode);
        req.input_path = source.to_string_lossy().into_owned();
        req.metadata_policy = Some(MetadataPolicy::Preserve);
        assert!(validate_request_source(&resolver, &req).await.is_ok());
    }
}

#[test]
fn image_presets_never_silently_ignore_video_settings() {
    let mut req = request(TargetFormat::Jpeg, None);
    req.resolution_cap = Some(goop_core::ResolutionCap::R1080p);
    assert!(validate_request(&req, &probe("jpeg")).is_err());
}

#[test]
fn video_subtitles_are_compatible_outputs_and_image_metadata_is_explicit() {
    let mut p = probe("jpeg");
    let caps = capabilities_for(&p);
    assert!(
        caps.targets
            .iter()
            .find(|t| t.target == TargetFormat::Jpeg)
            .unwrap()
            .preserves_metadata
    );
    assert!(caps
        .targets
        .iter()
        .find(|t| t.target == TargetFormat::Png)
        .unwrap()
        .metadata_warning
        .is_some());
    p.source_kind = goop_core::SourceKind::Video;
    p.has_video = true;
    p.has_subtitles = true;
    p.subtitle_codecs = vec!["subrip".into()];
    assert!(capabilities_for(&p)
        .targets
        .iter()
        .any(|t| t.target == TargetFormat::Srt && t.available));
}

#[test]
fn lossless_audio_does_not_promise_ignored_quality_knobs() {
    let mut p = probe("");
    p.source_kind = goop_core::SourceKind::Audio;
    p.has_audio = true;
    for (container, target) in [("wav", TargetFormat::Wav), ("flac", TargetFormat::Flac)] {
        p.container = Some(container.into());
        let c = capabilities_for(&p).compression;
        assert!(!c.quality);
        assert!(!c.target_size);
        assert!(validate_request(&request(target, Some(CompressMode::Quality(75))), &p).is_err());
    }
}

#[tokio::test]
async fn inspection_refines_only_source_bound_capabilities_consistently() {
    let dir = tempfile::tempdir().unwrap();
    let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_owned());
    let source = dir.path().join("source.png");
    image::RgbImage::new(3, 5).save(&source).unwrap();
    let inspection = goop_converter::capabilities::inspect_source(&resolver, &source)
        .await
        .unwrap();
    assert_eq!(inspection.probe.width, Some(3));
    assert_eq!(inspection.probe.height, Some(5));
    let mut inspected_without_color = inspection.capabilities.clone();
    let mut baseline_without_color = capabilities_for(&inspection.probe);
    let jpeg_settings = inspection
        .capabilities
        .targets
        .iter()
        .find(|target| target.target == TargetFormat::Jpeg)
        .unwrap()
        .image_settings
        .as_ref()
        .unwrap();
    assert_eq!(
        jpeg_settings.required_color_policy,
        Some(goop_core::ImageColorPolicy::AssumeSrgb)
    );
    assert!(jpeg_settings.preview_original_available);
    assert!(!jpeg_settings.preview_fit_within);
    for (target, baseline) in inspected_without_color
        .targets
        .iter_mut()
        .zip(&baseline_without_color.targets)
    {
        target.image_color = None;
        target.image_alpha = None;
        if let (Some(settings), Some(baseline)) = (
            target.image_settings.as_mut(),
            baseline.image_settings.as_ref(),
        ) {
            settings.required_color_policy = baseline.required_color_policy;
            settings.preview_original_available = baseline.preview_original_available;
            settings.preview_unavailable_reason = baseline.preview_unavailable_reason.clone();
        }
    }
    for target in &mut baseline_without_color.targets {
        target.image_color = None;
        target.image_alpha = None;
    }
    assert_eq!(inspected_without_color, baseline_without_color);
    assert!(inspection.capabilities.compression.lossless);
    let png_target = inspection
        .capabilities
        .targets
        .iter()
        .find(|target| target.target == TargetFormat::Png)
        .unwrap();
    let png_color = png_target.image_color.as_ref().unwrap();
    assert!(png_color.preserve.available);
    assert!(!png_color.convert_to_srgb.available);
    assert!(png_color
        .convert_to_srgb
        .reason
        .as_deref()
        .unwrap()
        .contains("no embedded ICC profile"));
    assert!(png_color.assume_srgb.available);
    assert!(png_color.assume_srgb.reason.is_none());
    let webp_color = inspection
        .capabilities
        .targets
        .iter()
        .find(|target| target.target == TargetFormat::Webp)
        .unwrap()
        .image_color
        .as_ref()
        .unwrap();
    assert!(!webp_color.convert_to_srgb.available);
    assert!(webp_color
        .convert_to_srgb
        .reason
        .as_deref()
        .unwrap()
        .contains("only for JPEG and PNG output"));
    assert!(!webp_color.assume_srgb.available);
    let png = png_target.image_metadata.as_ref().unwrap();
    assert_eq!(
        png.orientation,
        goop_core::ImageOrientationStatus::Uninspected
    );
}

#[tokio::test]
async fn jpeg_inspection_reports_source_bound_metadata_policy_capabilities() {
    let dir = tempfile::tempdir().unwrap();
    let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_owned());
    let source = dir.path().join("source.jpg");
    image::RgbImage::new(3, 5).save(&source).unwrap();

    let inspection = goop_converter::capabilities::inspect_source(&resolver, &source)
        .await
        .unwrap();
    let jpeg_target = inspection
        .capabilities
        .targets
        .iter()
        .find(|target| target.target == TargetFormat::Jpeg)
        .unwrap();
    assert_eq!(
        jpeg_target
            .image_settings
            .as_ref()
            .unwrap()
            .required_color_policy,
        None
    );
    let jpeg = jpeg_target.image_metadata.as_ref().unwrap();
    assert!(jpeg.preserve.available);
    assert!(jpeg.rgb_reencode_preserve.available);
    assert!(jpeg.remove_personal.available);
    assert!(jpeg.strip_all.available);
    assert_eq!(jpeg.source_has_exif, Some(false));
    assert_eq!(jpeg.source_has_icc, Some(false));
    assert_eq!(jpeg.orientation, goop_core::ImageOrientationStatus::Absent);

    let png = inspection
        .capabilities
        .targets
        .iter()
        .find(|target| target.target == TargetFormat::Png)
        .unwrap()
        .image_metadata
        .as_ref()
        .unwrap();
    assert!(png.preserve.available);
    assert!(png.rgb_reencode_preserve.available);
    assert!(!png.remove_personal.available);
    assert!(png
        .remove_personal
        .reason
        .as_deref()
        .unwrap()
        .contains("JPEG to JPEG"));
    assert!(png.strip_all.available);
}

#[tokio::test]
async fn grayscale_jpeg_reports_channel_aware_preserve_separately_from_rgb_reencode() {
    use img_parts::{jpeg::Jpeg, Bytes, ImageICC};

    let dir = tempfile::tempdir().unwrap();
    let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_owned());
    let source = dir.path().join("gray.jpg");
    image::GrayImage::new(3, 5).save(&source).unwrap();
    let mut profile = vec![0u8; 128];
    profile[..4].copy_from_slice(&128u32.to_be_bytes());
    profile[16..20].copy_from_slice(b"GRAY");
    profile[36..40].copy_from_slice(b"acsp");
    let mut jpeg = Jpeg::from_bytes(std::fs::read(&source).unwrap().into()).unwrap();
    jpeg.set_icc_profile(Some(Bytes::from(profile)));
    std::fs::write(&source, jpeg.encoder().bytes()).unwrap();

    let inspection = goop_converter::capabilities::inspect_source(&resolver, &source)
        .await
        .unwrap();
    let metadata = inspection
        .capabilities
        .targets
        .iter()
        .find(|target| target.target == TargetFormat::Jpeg)
        .unwrap()
        .image_metadata
        .as_ref()
        .unwrap();
    assert!(metadata.preserve.available);
    assert!(!metadata.rgb_reencode_preserve.available);
    assert!(metadata
        .rgb_reencode_preserve
        .reason
        .as_deref()
        .unwrap()
        .contains("RGB ICC profile"));
}

#[tokio::test]
async fn jpeg_with_opaque_icc_refuses_remove_personal_but_keeps_other_policies_available() {
    use img_parts::{jpeg::Jpeg, Bytes, ImageICC};

    let dir = tempfile::tempdir().unwrap();
    let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_owned());
    let source = dir.path().join("source.jpg");
    image::RgbImage::new(3, 5).save(&source).unwrap();
    let mut jpeg = Jpeg::from_bytes(std::fs::read(&source).unwrap().into()).unwrap();
    let mut profile = vec![0u8; 256];
    profile[..4].copy_from_slice(&256u32.to_be_bytes());
    profile[16..20].copy_from_slice(b"RGB ");
    profile[36..40].copy_from_slice(b"acsp");
    profile[128..].copy_from_slice(&[b'P'; 128]);
    jpeg.set_icc_profile(Some(Bytes::from(profile)));
    std::fs::write(&source, jpeg.encoder().bytes()).unwrap();

    let inspection = goop_converter::capabilities::inspect_source(&resolver, &source)
        .await
        .unwrap();
    let metadata = inspection
        .capabilities
        .targets
        .iter()
        .find(|target| target.target == TargetFormat::Jpeg)
        .unwrap()
        .image_metadata
        .as_ref()
        .unwrap();
    assert!(metadata.preserve.available);
    assert!(metadata.rgb_reencode_preserve.available);
    assert!(!metadata.remove_personal.available);
    assert!(metadata
        .remove_personal
        .reason
        .as_deref()
        .unwrap()
        .contains("ICC profile"));
    assert!(metadata.strip_all.available);
}

#[tokio::test]
async fn malformed_jpeg_orientation_reports_a_privacy_reason_without_unavailable_advice() {
    use img_parts::{jpeg::Jpeg, Bytes, ImageEXIF};

    let dir = tempfile::tempdir().unwrap();
    let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_owned());
    let source = dir.path().join("malformed-orientation.jpg");
    image::RgbImage::new(3, 5).save(&source).unwrap();
    let mut exif = b"II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
    exif.extend_from_slice(&9u16.to_le_bytes());
    exif.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
    let mut jpeg = Jpeg::from_bytes(std::fs::read(&source).unwrap().into()).unwrap();
    jpeg.set_exif(Some(Bytes::from(exif)));
    std::fs::write(&source, jpeg.encoder().bytes()).unwrap();

    let inspection = goop_converter::capabilities::inspect_source(&resolver, &source)
        .await
        .unwrap();
    let metadata = inspection
        .capabilities
        .targets
        .iter()
        .find(|target| target.target == TargetFormat::Jpeg)
        .unwrap()
        .image_metadata
        .as_ref()
        .unwrap();
    for availability in [&metadata.remove_personal, &metadata.strip_all] {
        let reason = availability.reason.as_deref().unwrap();
        assert!(reason.contains("privacy modes cannot safely normalize"));
        assert!(!reason.contains("choose Strip all"));
    }
}

#[tokio::test]
async fn fragmented_jpeg_metadata_is_refused_before_capability_parsing() {
    let dir = tempfile::tempdir().unwrap();
    let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_owned());
    let source = dir.path().join("fragmented.jpg");
    image::RgbImage::new(3, 5).save(&source).unwrap();
    let jpeg = std::fs::read(&source).unwrap();
    let mut fragmented = Vec::with_capacity(jpeg.len() + 20_000 * 4);
    fragmented.extend_from_slice(&jpeg[..2]);
    for _ in 0..20_000 {
        fragmented.extend_from_slice(&[0xff, 0xe2, 0x00, 0x02]);
    }
    fragmented.extend_from_slice(&jpeg[2..]);
    std::fs::write(&source, fragmented).unwrap();

    let error = goop_converter::capabilities::inspect_source(&resolver, &source)
        .await
        .unwrap_err();
    assert!(error.user_message().contains("segment safety limit"));
}

#[test]
fn subtitle_extraction_requires_the_first_stream_to_be_text() {
    let mut p = probe("");
    p.source_kind = goop_core::SourceKind::Video;
    p.has_video = true;
    p.has_subtitles = true;
    for codecs in [
        vec!["hdmv_pgs_subtitle"],
        vec!["dvd_subtitle"],
        vec!["unknown"],
        vec![],
        vec!["hdmv_pgs_subtitle", "subrip"],
    ] {
        p.subtitle_codecs = codecs.into_iter().map(str::to_owned).collect();
        for target in [TargetFormat::Srt, TargetFormat::Vtt] {
            let caps = capabilities_for(&p);
            let c = caps.targets.iter().find(|c| c.target == target).unwrap();
            assert!(!c.available);
            assert!(c.reason.is_some());
            assert!(validate_request(&request(target, None), &p).is_err());
        }
    }
    p.subtitle_codecs = vec!["subrip".into(), "hdmv_pgs_subtitle".into()];
    assert!(validate_request(&request(TargetFormat::Srt, None), &p).is_ok());
}

#[test]
fn video_presets_are_rejected_for_outputs_that_ignore_them() {
    let mut p = probe("");
    p.source_kind = goop_core::SourceKind::Video;
    p.has_video = true;
    p.has_audio = true;
    p.has_subtitles = true;
    p.subtitle_codecs = vec!["subrip".into()];
    for target in [TargetFormat::Mp3, TargetFormat::Srt, TargetFormat::Gif] {
        let mut req = request(target, None);
        req.quality_preset = Some(goop_core::QualityPreset::Balanced);
        assert!(validate_request(&req, &p).is_err());
        req.quality_preset = None;
        req.resolution_cap = Some(goop_core::ResolutionCap::R1080p);
        assert!(validate_request(&req, &p).is_err());
    }
}

#[test]
fn avi_accepts_resolution_but_rejects_ignored_quality_levels() {
    let mut p = probe("");
    p.source_kind = goop_core::SourceKind::Video;
    p.has_video = true;
    let mut req = request(TargetFormat::Avi, None);
    req.quality_preset = Some(goop_core::QualityPreset::Balanced);
    assert!(validate_request(&req, &p).is_err());
    req.quality_preset = None;
    req.resolution_cap = Some(goop_core::ResolutionCap::R1080p);
    assert!(validate_request(&req, &p).is_ok());
}

#[test]
fn compression_does_not_silently_discard_video_settings() {
    let mut p = probe("");
    p.source_kind = goop_core::SourceKind::Video;
    p.has_video = true;
    for target in [
        TargetFormat::Mp4,
        TargetFormat::Mkv,
        TargetFormat::Webm,
        TargetFormat::Mov,
        TargetFormat::Avi,
    ] {
        for mode in [
            CompressMode::Quality(75),
            CompressMode::TargetSizeBytes(1_000_000),
        ] {
            let mut req = request(target, Some(mode));
            assert!(validate_request(&req, &p).is_ok());
            req.quality_preset = Some(goop_core::QualityPreset::Original);
            req.resolution_cap = Some(goop_core::ResolutionCap::Original);
            assert!(validate_request(&req, &p).is_ok());
            req.quality_preset = Some(goop_core::QualityPreset::Small);
            assert!(
                validate_request(&req, &p).is_err(),
                "{target:?}: compression ignores quality preset"
            );
            req.quality_preset = None;
            req.resolution_cap = Some(goop_core::ResolutionCap::R720p);
            assert!(
                validate_request(&req, &p).is_err(),
                "{target:?}: compression ignores resolution"
            );
            req.compress_mode = None;
            assert!(validate_request(&req, &p).is_ok());
        }
    }
}

#[tokio::test]
async fn admission_expands_home_relative_source_paths() {
    use goop_converter::capabilities::validate_request_source;
    let home = goop_core::path::expand("~");
    assert!(home.is_absolute(), "test requires the current-user home");
    let dir = tempfile::Builder::new()
        .prefix(".goop-admission-test-")
        .tempdir_in(&home)
        .unwrap();
    let source = dir.path().join("source.png");
    image::RgbImage::new(2, 2).save(&source).unwrap();
    let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_owned());
    let mut req = request(TargetFormat::Png, None);
    req.input_path = source.to_string_lossy().into_owned();
    assert!(validate_request_source(&resolver, &req).await.is_ok());
    req.input_path = format!(
        "~/{}",
        source.strip_prefix(&home).unwrap().to_string_lossy()
    );
    assert!(validate_request_source(&resolver, &req).await.is_ok());
}

#[test]
fn output_compression_capabilities_do_not_inherit_source_format() {
    let caps = serde_json::to_value(capabilities_for(&probe("png"))).unwrap();
    let jpeg = caps["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["target"] == "jpeg")
        .unwrap();
    assert_eq!(jpeg["compression"]["quality"], true);
    assert_eq!(jpeg["compression"]["lossless"], false);
}

#[test]
fn transparent_sources_do_not_advertise_jpeg_compression_without_a_background() {
    for format in ["png", "webp"] {
        let mut transparent = probe(format);
        transparent.image_has_alpha = Some(true);
        let capability = capabilities_for(&transparent)
            .targets
            .into_iter()
            .find(|target| target.target == TargetFormat::Jpeg)
            .unwrap()
            .compression
            .unwrap();

        assert!(!capability.quality, "transparent {format} quality");
        assert!(!capability.target_size, "transparent {format} target size");
        assert!(!capability.lossless, "transparent {format} lossless");
        assert!(capability
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("background") && reason.contains("Convert")));

        for mode in [
            CompressMode::Quality(75),
            CompressMode::TargetSizeBytes(100_000),
            CompressMode::LosslessReoptimize,
        ] {
            assert!(
                validate_request(&request(TargetFormat::Jpeg, Some(mode)), &transparent,).is_err()
            );
        }

        let opaque = capabilities_for(&opaque_probe(format))
            .targets
            .into_iter()
            .find(|target| target.target == TargetFormat::Jpeg)
            .unwrap()
            .compression
            .unwrap();
        assert!(opaque.quality, "opaque {format} quality");
        assert!(opaque.target_size, "opaque {format} target size");
        assert!(!opaque.lossless, "opaque {format} lossless");
        assert!(opaque.reason.is_none(), "opaque {format} reason");
    }
}
