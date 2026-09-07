use goop_converter::capabilities::{capabilities_for, validate_request};
use goop_converter::image_options::{output_dimensions, validate_options};
use goop_core::{
    CompressMode, ConvertRequest, GifOptions, GifSizePreset, ImageConvertOptions, ImageResize,
    ProbeResult, QualityPreset, ResolutionCap, SubtitleMode, SubtitleOptions, TargetFormat,
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
fn webp_is_lossless_only() {
    let p = probe("webp");
    let c = capabilities_for(&p);
    assert!(!c.compression.quality);
    assert!(!c.compression.target_size);
    assert!(c.compression.lossless);
    for m in [
        CompressMode::Quality(75),
        CompressMode::TargetSizeBytes(100),
    ] {
        assert!(validate_request(&request(TargetFormat::Webp, Some(m)), &p).is_err());
    }
    assert!(validate_request(
        &request(TargetFormat::Webp, Some(CompressMode::LosslessReoptimize)),
        &p
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
async fn inspection_returns_consistent_probe_and_capabilities() {
    let dir = tempfile::tempdir().unwrap();
    let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_owned());
    let source = dir.path().join("source.png");
    image::RgbImage::new(3, 5).save(&source).unwrap();
    let inspection = goop_converter::capabilities::inspect_source(&resolver, &source)
        .await
        .unwrap();
    assert_eq!(inspection.probe.width, Some(3));
    assert_eq!(inspection.probe.height, Some(5));
    assert_eq!(inspection.capabilities, capabilities_for(&inspection.probe));
    assert!(inspection.capabilities.compression.lossless);
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
