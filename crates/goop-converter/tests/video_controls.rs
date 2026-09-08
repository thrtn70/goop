use goop_converter::{
    encoders::{parse_encoders, DetectedEncoders},
    parse_probe_json,
    video_options::{capabilities, resolve, validate_output},
};
use goop_core::*;
use serde_json::{json, Value};

fn source_json() -> Value {
    json!({"format":{"duration":"2.0","size":"4096"},"streams":[{"index":2,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"pix_fmt":"yuv420p","field_order":"progressive","sample_aspect_ratio":"1:1","disposition":{"attached_pic":0}},{"index":5,"codec_type":"audio","codec_name":"aac","disposition":{"attached_pic":0}}]})
}
fn probe(value: Value) -> ProbeResult {
    parse_probe_json(&serde_json::to_vec(&value).unwrap()).unwrap()
}
fn request() -> ConvertRequest {
    serde_json::from_value(json!({"input_path":"source.mp4","output_path":"out.mp4","target":"mp4","video_options":{"kind":"encode","codec":"h264","rate_control":{"kind":"constant_quality","crf":23},"speed":"medium","processor":"software"}})).unwrap()
}
fn inventory() -> DetectedEncoders {
    parse_encoders(
        " V..... libx264 H264\n V..... libx265 HEVC\n A..... aac AAC\n V....D h264_videotoolbox HW",
    )
}
#[test]
fn explicit_arguments_and_audio_are_independent() {
    let source = probe(source_json());
    let mut req = request();
    let before = resolve(&req, &source, &inventory()).unwrap();
    req.video_options = Some(VideoConvertOptions::Encode {
        codec: VideoCodec::Hevc,
        rate_control: VideoRateControl::ConstantQuality { crf: 30 },
        speed: VideoSpeed::Slow,
        processor: VideoProcessor::Software,
    });
    let after = resolve(&req, &source, &inventory()).unwrap();
    assert_eq!(before.summary.audio_codec, after.summary.audio_codec);
    for pair in [
        ["-crf", "30"],
        ["-preset", "slow"],
        ["-c:v", "libx265"],
        ["-tag:v", "hvc1"],
        ["-map", "0:2"],
        ["-map", "0:5"],
        ["-c:a", "copy"],
    ] {
        assert!(after.plan.args.windows(2).any(|p| p == pair), "{pair:?}");
    }
    assert_eq!(
        after
            .plan
            .args
            .iter()
            .filter(|x| x.as_str() == "-crf" || x.as_str() == "-b:v")
            .count(),
        1
    );
    assert_eq!(inventory().count(), 1);
}
#[test]
fn bitrate_and_missing_encoder() {
    let mut req = request();
    req.video_options = Some(VideoConvertOptions::Encode {
        codec: VideoCodec::H264,
        rate_control: VideoRateControl::AverageBitrate { kbps: 5000 },
        speed: VideoSpeed::Fast,
        processor: VideoProcessor::Software,
    });
    let source = probe(source_json());
    let p = resolve(&req, &source, &inventory()).unwrap();
    assert!(p.plan.args.windows(2).any(|p| p == ["-b:v", "5000k"]));
    assert!(!p.plan.args.contains(&"-crf".into()));
    assert!(resolve(&req, &source, &DetectedEncoders::empty())
        .unwrap_err()
        .user_message()
        .contains("libx264"));
}
#[test]
fn rejects_unsupported_encode_facts() {
    for (field, value) in [
        ("pix_fmt", json!("yuv420p10le")),
        ("pix_fmt", json!("yuva420p")),
        ("field_order", json!("unknown")),
        ("field_order", json!(null)),
        ("sample_aspect_ratio", json!("2:1")),
        ("color_transfer", json!("smpte2084")),
        ("color_transfer", json!({})),
        ("color_primaries", json!("bt2020")),
        ("color_space", json!("garbage")),
    ] {
        let mut v = source_json();
        v["streams"][0][field] = value;
        assert!(
            resolve(&request(), &probe(v), &inventory()).is_err(),
            "{field}"
        );
    }
}
#[test]
fn complete_inventory_required() {
    for stream in [
        json!({"index":6,"codec_type":"subtitle","codec_name":"subrip"}),
        json!({"index":6,"codec_type":"data"}),
        json!({"index":6,"codec_type":"video","codec_name":"h264"}),
        json!({"index":6,"codec_type":"audio","codec_name":"aac"}),
    ] {
        let mut v = source_json();
        v["streams"].as_array_mut().unwrap().push(stream);
        assert!(resolve(&request(), &probe(v), &inventory()).is_err());
    }
    for field in ["index", "codec_type", "codec_name", "disposition"] {
        let mut v = source_json();
        v["streams"][0].as_object_mut().unwrap().remove(field);
        assert!(
            resolve(&request(), &probe(v), &inventory()).is_err(),
            "{field}"
        );
    }
    let mut v = source_json();
    v["streams"][1]["index"] = json!(2);
    assert!(resolve(&request(), &probe(v), &inventory()).is_err());
    let mut source = probe(source_json());
    source.video_details = None;
    assert!(resolve(&request(), &source, &inventory()).is_err());
}
#[test]
fn rotation_and_caps() {
    let mut v = source_json();
    v["streams"][0]["side_data_list"] = json!([{"side_data_type":"Display Matrix","rotation":90,"displaymatrix": "00000000: 0 -65536 0\n00000001: 65536 0 0\n00000002: 0 0 1073741824"}]);
    let mut req = request();
    req.resolution_cap = Some(ResolutionCap::R720p);
    let p = resolve(&req, &probe(v.clone()), &inventory()).unwrap();
    assert_eq!((p.summary.width, p.summary.height), (1080, 1920));
    v["streams"][0]["tags"] = json!({"rotate":"180"});
    assert!(resolve(&req, &probe(v), &inventory()).is_err());
    for angle in [json!(45), json!(90.5), json!("bad")] {
        let mut v = source_json();
        v["streams"][0]["side_data_list"] =
            json!([{"side_data_type":"Display Matrix","rotation":angle}]);
        assert!(resolve(&req, &probe(v), &inventory()).is_err());
    }
}
#[test]
fn incomplete_display_matrix_disables_both_modes_but_rotate_tag_remains_supported() {
    for side in [
        json!({"side_data_type":"Display Matrix","rotation":90}),
        json!({"side_data_type":"Display Matrix","displaymatrix":"00000000: 0 -65536 0\n00000001: 65536 0 0\n00000002: 0 0 1073741824"}),
    ] {
        let mut v = source_json();
        v["streams"][0]["side_data_list"] = json!([side]);
        // A standalone tag cannot repair incomplete declared matrix facts.
        v["streams"][0]["tags"] = json!({"rotate":"90"});
        let source = probe(v);
        let caps = capabilities(&source, TargetFormat::Mp4, &inventory());
        assert!(!caps.encode.available);
        assert!(!caps.copy.available);
        let mut req = request();
        assert!(resolve(&req, &source, &inventory()).is_err());
        req.video_options = Some(VideoConvertOptions::Copy);
        assert!(resolve(&req, &source, &inventory()).is_err());
    }
    let mut v = source_json();
    v["streams"][0]["tags"] = json!({"rotate":"90"});
    assert_eq!(
        resolve(&request(), &probe(v), &inventory())
            .unwrap()
            .summary
            .width,
        1080
    );
}

#[cfg(unix)]
#[tokio::test]
async fn incomplete_display_matrix_rejected_before_staging() {
    for side in [
        json!({"side_data_type":"Display Matrix","rotation":90}),
        json!({"side_data_type":"Display Matrix","displaymatrix":"00000000: 0 -65536 0\n00000001: 65536 0 0\n00000002: 0 0 1073741824"}),
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("input.mp4");
        std::fs::write(&input, b"input").unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let mut source = source_json();
        source["streams"][0]["side_data_list"] = json!([side]);
        executable(&bin.join("ffprobe"), &format!("printf '%s' '{}'", source));
        executable(&bin.join("ffmpeg"), "exit 99");
        let r = goop_sidecar::BinaryResolver::new(bin);
        for options in [request().video_options.unwrap(), VideoConvertOptions::Copy] {
            let mut req = request();
            req.input_path = input.to_string_lossy().into_owned();
            req.output_path = tmp
                .path()
                .join("absent-parent/output.mp4")
                .to_string_lossy()
                .into_owned();
            req.video_options = Some(options);
            let error = run_explicit(&r, &req, &inventory()).await.unwrap_err();
            assert!(error.user_message().contains("rotation"), "{error:?}");
            assert!(!tmp.path().join("absent-parent").exists());
        }
    }
}
#[test]
fn copy_transform_audio_and_notices() {
    let mut req = request();
    req.video_options = Some(VideoConvertOptions::Copy);
    let mut v = source_json();
    v["streams"][0]["pix_fmt"] = json!("yuv420p10le");
    v["streams"][0]["color_transfer"] = json!("smpte2084");
    assert!(
        !resolve(&req, &probe(v), &inventory())
            .unwrap()
            .plan
            .reencoded
    );
    req.resolution_cap = Some(ResolutionCap::R720p);
    assert!(resolve(&req, &probe(source_json()), &inventory()).is_err());
    let mut v = source_json();
    v["streams"][1]["codec_name"] = json!("vorbis");
    req.resolution_cap = None;
    assert!(resolve(&req, &probe(v.clone()), &inventory()).is_err());
    let p = resolve(&request(), &probe(v), &inventory()).unwrap();
    assert_eq!(p.summary.audio_codec.as_deref(), Some("aac"));
    assert!(!p.summary.audio_copied);
    assert!(p.plan.args.windows(2).any(|p| p == ["-b:a", "192k"]));
    assert!(p.summary.notices.iter().any(|s| s.contains("unspecified")));
}
#[test]
fn output_validation_and_capabilities() {
    let source = probe(source_json());
    let p = resolve(&request(), &source, &inventory()).unwrap();
    assert!(validate_output(&p.summary, &source).is_ok());
    let mut wrong = source.clone();
    wrong.width = Some(10);
    assert!(validate_output(&p.summary, &wrong).is_err());
    wrong = source.clone();
    wrong.duration_ms = 0;
    assert!(validate_output(&p.summary, &wrong).is_err());
    let caps = capabilities(&source, TargetFormat::Mp4, &DetectedEncoders::empty());
    assert!(!caps.encode.available);
    assert!(!caps.preview_available);
    assert_eq!((caps.crf_min, caps.crf_max, caps.default_crf), (1, 51, 23));
}
#[tokio::test]
async fn preview_rejected_before_path_or_session_work() {
    let root = std::env::temp_dir().join(format!("goop-explicit-preview-{:?}", JobId::new()));
    let service = goop_converter::preview::PreviewService::new(root.clone());
    let resolver = goop_sidecar::BinaryResolver::new(root.join("missing"));
    let req:PreviewRequest=serde_json::from_value(json!({"request_id":"test","source_revision":"test","input_path":"/missing/source.mp4","target":"mp4","video_options":{"kind":"copy"}})).unwrap();
    let error = service.generate(&resolver, req).await.unwrap_err();
    assert!(
        error.user_message().contains("Explicit video previews"),
        "{error:?}"
    );
    assert!(!root.exists());
}

mod common;
use goop_converter::{ConversionBackend, FfmpegBackend};
use std::{path::Path, process::Command, sync::Arc};
use tokio_util::sync::CancellationToken;
fn make_explicit_source(ffmpeg: &Path, path: &Path, codec: &str, audio: &str, w: u32, h: u32) {
    let output = Command::new(ffmpeg)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc2=size={w}x{h}:rate=24:duration=1"),
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            codec,
            "-preset",
            "fast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            audio,
            "-shortest",
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
async fn run_explicit(
    r: &goop_sidecar::BinaryResolver,
    req: &ConvertRequest,
    enc: &DetectedEncoders,
) -> Result<ConvertResult, GoopError> {
    FfmpegBackend::new(r, Arc::new(common::SilentSink))
        .with_encoders(Arc::new(enc.clone()), true)
        .convert(JobId::new(), req, CancellationToken::new())
        .await
}

#[tokio::test]
#[ignore]
async fn bundled_required_video_encoders_are_available() {
    let links = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(links.path());
    let encoders = goop_converter::detect_encoders(&resolver).await;
    for encoder in ["libx264", "libx265"] {
        assert!(
            encoders.is_available(encoder),
            "bundled ffmpeg must provide required encoder {encoder}"
        );
    }
}

fn payload(ffmpeg: &Path, path: &Path, codec: &str) -> Vec<u8> {
    let output = Command::new(ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(path)
        .args([
            "-map",
            "0:v:0",
            "-c:v",
            "copy",
            "-bsf:v",
            if codec == "h264" {
                "h264_mp4toannexb"
            } else {
                "hevc_mp4toannexb"
            },
            "-f",
            if codec == "h264" { "h264" } else { "hevc" },
            "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    output.stdout
}
#[tokio::test]
#[ignore]
async fn real_explicit_speed_copy_and_audio() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = common::bundled_resolver(links.path());
    let ffmpeg = common::ffmpeg_path(&r);
    let enc = goop_converter::detect_encoders(&r).await;
    let source = tmp.path().join("source.mkv");
    make_explicit_source(&ffmpeg, &source, "libx264", "libvorbis", 320, 180);
    let mut outputs = Vec::new();
    for codec in [VideoCodec::H264, VideoCodec::Hevc] {
        let name = if codec == VideoCodec::H264 {
            "libx264"
        } else {
            "libx265"
        };
        if !enc.is_available(name) {
            println!("UNAVAILABLE {name}");
            continue;
        }
        for (n, speed) in [VideoSpeed::Fast, VideoSpeed::Medium, VideoSpeed::Slow]
            .into_iter()
            .enumerate()
        {
            let mut req = request();
            req.input_path = source.to_string_lossy().into_owned();
            req.output_path = tmp
                .path()
                .join(format!("{name}-{n}.mp4"))
                .to_string_lossy()
                .into_owned();
            req.video_options = Some(VideoConvertOptions::Encode {
                codec,
                rate_control: VideoRateControl::ConstantQuality { crf: 23 },
                speed,
                processor: VideoProcessor::Software,
            });
            let result = run_explicit(&r, &req, &enc).await.unwrap();
            let facts = FfmpegBackend::probe(&r, Path::new(&result.output_path))
                .await
                .unwrap();
            let summary = result.video_execution.unwrap();
            assert_eq!(summary.encoder.as_deref(), Some(name));
            assert_eq!(
                facts.video_codec.as_deref(),
                Some(if codec == VideoCodec::H264 {
                    "h264"
                } else {
                    "hevc"
                })
            );
            assert_eq!(facts.audio_codec.as_deref(), Some("aac"));
            assert!(!summary.audio_copied);
            assert_eq!((facts.width, facts.height), (Some(320), Some(180)));
            println!(
                "ENCODE {name} {speed:?} bytes={} codec={:?} dimensions={:?}x{:?} audio={:?}",
                result.bytes, facts.video_codec, facts.width, facts.height, facts.audio_codec
            );
            outputs.push(result.bytes);
            let original_payload = payload(
                &ffmpeg,
                Path::new(&result.output_path),
                facts.video_codec.as_deref().unwrap(),
            );
            for target in [TargetFormat::Mp4, TargetFormat::Mov, TargetFormat::Mkv] {
                let mut copy = req.clone();
                copy.input_path = result.output_path.clone();
                copy.output_path = tmp
                    .path()
                    .join(format!("copy-{name}-{n}.{}", target.extension()))
                    .to_string_lossy()
                    .into_owned();
                copy.target = target;
                copy.video_options = Some(VideoConvertOptions::Copy);
                let copied = run_explicit(&r, &copy, &enc).await.unwrap();
                assert!(!copied.reencoded);
                assert_eq!(
                    original_payload,
                    payload(
                        &ffmpeg,
                        Path::new(&copied.output_path),
                        facts.video_codec.as_deref().unwrap()
                    )
                );
                println!(
                    "COPY {name} {target:?} elementary bytes identical={}",
                    original_payload.len()
                );
                if codec == VideoCodec::Hevc && target != TargetFormat::Mkv {
                    assert_eq!(
                        common::stream_tags(&r, Path::new(&copied.output_path), "v"),
                        vec!["hvc1"]
                    );
                }
            }
        }
    }
    assert!(
        !outputs.is_empty(),
        "at least one bundled software encoder must be tested"
    );
}
// Compare decoded samples against the same decoded input, without audio or
// container overhead. These fixtures have identical geometry and frame cadence.
fn decoded_video(ffmpeg: &Path, path: &Path) -> Vec<u8> {
    let output = Command::new(ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(path)
        .args([
            "-map", "0:v:0", "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!output.stdout.is_empty());
    output.stdout
}
fn mean_squared_error(reference: &[u8], actual: &[u8]) -> f64 {
    assert_eq!(reference.len(), actual.len());
    reference
        .iter()
        .zip(actual)
        .map(|(&a, &b)| (f64::from(a) - f64::from(b)).powi(2))
        .sum::<f64>()
        / reference.len() as f64
}
#[tokio::test]
#[ignore]
async fn real_explicit_rate_pairs_hold_other_settings_fixed() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = common::bundled_resolver(links.path());
    let ffmpeg = common::ffmpeg_path(&r);
    let enc = goop_converter::detect_encoders(&r).await;
    let source = tmp.path().join("rate-source.mkv");
    make_explicit_source(&ffmpeg, &source, "libx264", "aac", 640, 360);
    let reference = decoded_video(&ffmpeg, &source);
    let mut tested = 0;
    for (codec, encoder, stream_codec) in [
        (VideoCodec::H264, "libx264", "h264"),
        (VideoCodec::Hevc, "libx265", "hevc"),
    ] {
        if !enc.is_available(encoder) {
            println!("UNAVAILABLE {encoder} rate pairs");
            continue;
        }
        tested += 1;
        for (mode, rates) in [
            (
                "crf",
                [
                    VideoRateControl::ConstantQuality { crf: 38 },
                    VideoRateControl::ConstantQuality { crf: 16 },
                ],
            ),
            (
                "bitrate",
                [
                    VideoRateControl::AverageBitrate { kbps: 100 },
                    VideoRateControl::AverageBitrate { kbps: 2000 },
                ],
            ),
        ] {
            let mut measurements = Vec::new();
            for (index, rate) in rates.into_iter().enumerate() {
                let mut req = request();
                req.input_path = source.to_string_lossy().into_owned();
                req.output_path = tmp
                    .path()
                    .join(format!("{encoder}-{mode}-{index}.mp4"))
                    .to_string_lossy()
                    .into_owned();
                req.video_options = Some(VideoConvertOptions::Encode {
                    codec,
                    rate_control: rate,
                    speed: VideoSpeed::Medium,
                    processor: VideoProcessor::Software,
                });
                let result = run_explicit(&r, &req, &enc).await.unwrap();
                let path = Path::new(&result.output_path);
                let facts = FfmpegBackend::probe(&r, path).await.unwrap();
                assert_eq!(facts.video_codec.as_deref(), Some(stream_codec));
                assert_eq!((facts.width, facts.height), (Some(640), Some(360)));
                let summary = result.video_execution.unwrap();
                assert_eq!(summary.encoder.as_deref(), Some(encoder));
                assert_eq!(summary.audio_codec.as_deref(), Some("aac"));
                assert!(summary.audio_copied);
                let bytes = payload(&ffmpeg, path, stream_codec).len();
                let mse = mean_squared_error(&reference, &decoded_video(&ffmpeg, path));
                println!("RATE {encoder} {mode} {index}: elementary_bytes={bytes} mse={mse:.4}");
                measurements.push((bytes, mse));
            }
            let (low_bytes, low_fidelity_mse) = measurements[0];
            let (high_bytes, high_fidelity_mse) = measurements[1];
            // Wide rate separation on moving testsrc2 gives ample margin across
            // encoder versions; no exact short-clip bitrate/size is promised.
            assert!(
                high_bytes as f64 > low_bytes as f64 * 1.5,
                "{encoder} {mode}: {measurements:?}"
            );
            assert!(
                low_fidelity_mse > high_fidelity_mse * 1.5,
                "{encoder} {mode}: {measurements:?}"
            );
        }
    }
    assert!(
        tested > 0,
        "at least one bundled software encoder must be tested"
    );
}
#[tokio::test]
#[ignore]
async fn real_geometry_rejection_collision_cancel_and_corrupt() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = common::bundled_resolver(links.path());
    let ffmpeg = common::ffmpeg_path(&r);
    let enc = goop_converter::detect_encoders(&r).await;
    let source = tmp.path().join("source.mp4");
    make_explicit_source(&ffmpeg, &source, "libx264", "aac", 1920, 1080);
    let rotated = tmp.path().join("rotated.mp4");
    assert!(Command::new(&ffmpeg)
        .args(["-v", "error", "-display_rotation", "90", "-i"])
        .arg(&source)
        .args(["-c", "copy"])
        .arg(&rotated)
        .status()
        .unwrap()
        .success());
    for (src, cap, expected) in [
        (&source, ResolutionCap::R720p, (1280, 720)),
        (&rotated, ResolutionCap::R720p, (1080, 1920)),
        (&source, ResolutionCap::R480p, (854, 480)),
    ] {
        let mut req = request();
        req.input_path = src.to_string_lossy().into_owned();
        req.output_path = tmp
            .path()
            .join(format!("scaled-{}.mp4", expected.0))
            .to_string_lossy()
            .into_owned();
        req.resolution_cap = Some(cap);
        let result = run_explicit(&r, &req, &enc).await.unwrap();
        let summary = result.video_execution.unwrap();
        assert_eq!((summary.width, summary.height), expected);
        println!("GEOMETRY {expected:?} published");
        let existing = std::fs::read(&req.output_path).unwrap();
        assert!(run_explicit(&r, &req, &enc).await.is_err());
        assert_eq!(std::fs::read(&req.output_path).unwrap(), existing);
        println!("COLLISION unchanged existing output");
    }
    let invalid = tmp.path().join("multiple.mkv");
    assert!(Command::new(&ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(&source)
        .args(["-map", "0:v", "-map", "0:a", "-map", "0:a", "-c", "copy"])
        .arg(&invalid)
        .status()
        .unwrap()
        .success());
    let out = tmp.path().join("failure.mp4");
    let mut req = request();
    req.input_path = invalid.to_string_lossy().into_owned();
    req.output_path = out.to_string_lossy().into_owned();
    assert!(run_explicit(&r, &req, &enc).await.is_err());
    assert!(!out.exists());
    println!("ADMISSION extra audio rejected before publication");
    req.input_path = source.to_string_lossy().into_owned();
    let token = CancellationToken::new();
    let backend = FfmpegBackend::new(&r, Arc::new(common::SilentSink))
        .with_encoders(Arc::new(enc.clone()), true);
    let cancel = token.clone();
    let task = async {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        cancel.cancel();
    };
    let (result, _) = tokio::join!(backend.convert(JobId::new(), &req, token), task);
    assert!(matches!(result, Err(GoopError::Cancelled)));
    assert!(!out.exists());
    println!("CANCEL no publication");
    let corrupt = tmp.path().join("corrupt.mp4");
    std::fs::write(&corrupt, b"broken media").unwrap();
    req.input_path = corrupt.to_string_lossy().into_owned();
    assert!(run_explicit(&r, &req, &enc).await.is_err());
    assert!(!out.exists());
    assert!(std::fs::read_dir(tmp.path()).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".goop-")));
    println!("CORRUPT no publication; staging removed");
}

#[test]
fn malformed_display_matrix_and_fractional_rotation_are_rejected() {
    for matrix in [
        "garbage",
        "00000000: 65536 0 0\n00000001: 0 -65536 0\n00000002: 0 0 1073741824",
    ] {
        let mut v = source_json();
        v["streams"][0]["side_data_list"] =
            json!([{"side_data_type":"Display Matrix","rotation":0,"displaymatrix":matrix}]);
        assert!(resolve(&request(), &probe(v), &inventory()).is_err());
    }
}
#[cfg(unix)]
fn executable(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn output_mismatch_never_publishes() {
    let tmp = tempfile::tempdir().unwrap();
    let input = tmp.path().join("input.mp4");
    std::fs::write(&input, b"input").unwrap();
    let out = tmp.path().join("output.mp4");
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let source = source_json();
    let mut wrong = source.clone();
    wrong["streams"][0]["width"] = json!(16);
    executable(&bin.join("ffprobe"),&format!("for last do :; done\ncase \"$last\" in */input.mp4) printf '%s' '{}' ;; *) printf '%s' '{}' ;; esac",source,wrong));
    executable(
        &bin.join("ffmpeg"),
        "for last do :; done\nprintf 'output' > \"$last\"",
    );
    let r = goop_sidecar::BinaryResolver::new(bin);
    let mut req = request();
    req.input_path = input.to_string_lossy().into_owned();
    req.output_path = out.to_string_lossy().into_owned();
    assert!(run_explicit(&r, &req, &inventory())
        .await
        .unwrap_err()
        .user_message()
        .contains("geometry"));
    assert!(!out.exists());
    assert_eq!(std::fs::read(input).unwrap(), b"input");
    println!("OUTPUT MISMATCH: staged output removed, source unchanged, no publication");
}

#[tokio::test]
#[ignore]
async fn real_silent_hdr_copy_and_rotated_copy() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let r = common::bundled_resolver(links.path());
    let ffmpeg = common::ffmpeg_path(&r);
    let enc = goop_converter::detect_encoders(&r).await;
    if !enc.is_available("libx265") {
        println!("UNAVAILABLE libx265 HDR Copy fixture");
        return;
    }
    let source = tmp.path().join("hdr10.mp4");
    let generated = Command::new(&ffmpeg)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=1",
            "-c:v",
            "libx265",
            "-preset",
            "fast",
            "-pix_fmt",
            "yuv420p10le",
            "-color_trc",
            "smpte2084",
            "-color_primaries",
            "bt2020",
            "-colorspace",
            "bt2020nc",
            "-tag:v",
            "hvc1",
        ])
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        generated.status.success(),
        "{}",
        String::from_utf8_lossy(&generated.stderr)
    );
    let mut req = request();
    req.input_path = source.to_string_lossy().into_owned();
    req.output_path = tmp
        .path()
        .join("encoded.mp4")
        .to_string_lossy()
        .into_owned();
    assert!(run_explicit(&r, &req, &enc).await.is_err());
    assert!(!Path::new(&req.output_path).exists());
    req.video_options = Some(VideoConvertOptions::Copy);
    let original = payload(&ffmpeg, &source, "hevc");
    for target in [TargetFormat::Mp4, TargetFormat::Mov, TargetFormat::Mkv] {
        req.target = target;
        req.output_path = tmp
            .path()
            .join(format!("hdr-copy.{}", target.extension()))
            .to_string_lossy()
            .into_owned();
        let result = run_explicit(&r, &req, &enc).await.unwrap();
        assert!(result.video_execution.unwrap().audio_codec.is_none());
        assert_eq!(
            original,
            payload(&ffmpeg, Path::new(&result.output_path), "hevc")
        );
        println!("HDR10 SILENT COPY {target:?} payload identical; custom encode refused");
    }
    let rotated = tmp.path().join("rotated.mp4");
    assert!(Command::new(&ffmpeg)
        .args(["-v", "error", "-display_rotation", "90", "-i"])
        .arg(&source)
        .args(["-c", "copy"])
        .arg(&rotated)
        .status()
        .unwrap()
        .success());
    req.input_path = rotated.to_string_lossy().into_owned();
    for target in [TargetFormat::Mp4, TargetFormat::Mov, TargetFormat::Mkv] {
        req.target = target;
        req.output_path = tmp
            .path()
            .join(format!("rotation-copy.{}", target.extension()))
            .to_string_lossy()
            .into_owned();
        let result = run_explicit(&r, &req, &enc).await;
        let summary = result.unwrap().video_execution.unwrap();
        assert_eq!((summary.width, summary.height), (180, 320));
        println!("ROTATED COPY {target:?} retains coded and display geometry");
    }
}

#[test]
fn silent_encoding_and_legacy_inventory_boundaries() {
    let mut value = source_json();
    value["streams"].as_array_mut().unwrap().pop();
    let source = probe(value);
    let resolved = resolve(&request(), &source, &inventory()).unwrap();
    assert!(resolved.summary.audio_codec.is_none());
    assert!(!resolved.plan.args.contains(&"-c:a".into()));
    let legacy = goop_converter::capabilities::capabilities_for(&source);
    let target = legacy
        .targets
        .iter()
        .find(|t| t.target == TargetFormat::Mp4)
        .unwrap();
    let settings = target.video_settings.as_ref().unwrap();
    assert!(!settings.copy.available);
    assert!(!settings.encode.available);
    let mut invalid = request();
    invalid.quality_preset = Some(QualityPreset::Balanced);
    assert!(resolve(&invalid, &source, &inventory()).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn legacy_probe_retains_its_existing_limits() {
    let dir = tempfile::tempdir().unwrap();
    let binary = dir.path().join("ffprobe");
    let script = format!(
        r#"printf '%s' '{}'
dd if=/dev/zero bs=1100000 count=1 2>/dev/null | tr '\000' ' '
"#,
        source_json()
    );
    executable(&binary, &script);
    let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_path_buf());
    let legacy = FfmpegBackend::probe(&resolver, Path::new("source.mp4")).await;
    assert!(
        legacy.is_ok(),
        "legacy probing must retain existing behavior: {legacy:?}"
    );
    let explicit = FfmpegBackend::probe_with_cancel(
        &resolver,
        Path::new("source.mp4"),
        &CancellationToken::new(),
    )
    .await;
    assert!(explicit.unwrap_err().user_message().contains("1 MiB"));
}
