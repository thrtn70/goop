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
