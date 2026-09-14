use goop_converter::{
    encoders::DetectedEncoders,
    parse_probe_json,
    video_track_options::{resolve, settings, validate_output_against_source},
};
use goop_core::*;
use serde_json::{json, Value};
use std::{fs::OpenOptions, io::Write, path::Path, process::Command, sync::Arc};
use tokio_util::sync::CancellationToken;

mod common;

fn stream(index: u32, codec_type: &str, codec_name: &str, title: &str) -> Value {
    let mut value = json!({
        "index": index,
        "codec_type": codec_type,
        "codec_name": codec_name,
        "id": format!("0x{index:x}"),
        "tags": {"language": "eng", "title": title},
        "disposition": {"default": u8::from(index == 9), "forced": 0, "attached_pic": 0}
    });
    if codec_type == "video" {
        value["width"] = json!(1920);
        value["height"] = json!(1080);
        value["pix_fmt"] = json!("yuv420p");
        value["field_order"] = json!("progressive");
        value["sample_aspect_ratio"] = json!("1:1");
        value["avg_frame_rate"] = json!("24/1");
        value["r_frame_rate"] = json!("24/1");
        value["time_base"] = json!("1/24000");
        value["start_time"] = json!("0");
        value["duration"] = json!("3");
    } else if codec_type == "audio" {
        value["sample_rate"] = json!("48000");
        value["channels"] = json!(2);
        value["channel_layout"] = json!("stereo");
        value["sample_fmt"] = json!("fltp");
        value["time_base"] = json!("1/48000");
        value["start_time"] = json!("0.25");
        value["duration"] = json!(if index == 5 { "4" } else { "2" });
    }
    value
}

fn source_json() -> Value {
    json!({
        "format": {"duration": "4", "size": "4096", "format_name": "matroska"},
        "streams": [
            stream(2, "video", "h264", "Picture"),
            stream(5, "audio", "vorbis", "Commentary"),
            stream(7, "subtitle", "mov_text", "English"),
            stream(9, "audio", "aac", "Main"),
            stream(11, "subtitle", "ass", "Styled")
        ]
    })
}

fn probe(value: Value) -> ProbeResult {
    parse_probe_json(&serde_json::to_vec(&value).unwrap()).unwrap()
}

fn source_binding(probe: &ProbeResult) -> TrackSourceBinding {
    TrackSourceBinding {
        version: TRACK_SOURCE_BINDING_VERSION,
        canonical_path: "/tmp/source.mkv".into(),
        size_bytes: "4096".into(),
        modified_unix_ns: "1700000000000000000".into(),
        inventory: probe.track_inventory.clone().unwrap(),
    }
}

fn request(
    target: TargetFormat,
    video_options: VideoConvertOptions,
    audio: TrackStreamPolicy,
    subtitles: TrackStreamPolicy,
) -> ConvertRequest {
    let source = probe(source_json());
    ConvertRequest {
        input_path: "/tmp/source.mkv".into(),
        output_path: format!("/tmp/out.{}", target.extension()),
        target,
        quality_preset: None,
        resolution_cap: None,
        gif_options: None,
        compress_mode: None,
        batch_id: None,
        metadata_policy: None,
        image_color_policy: None,
        image_alpha_policy: None,
        subtitle: None,
        image_options: None,
        audio_options: None,
        video_options: Some(video_options),
        track_options: Some(TrackConvertOptions::Video {
            source: source_binding(&source),
            audio,
            subtitles,
        }),
    }
}

fn encoders() -> DetectedEncoders {
    DetectedEncoders::from_names(["libx264", "libx265", "aac"])
}

fn custom() -> VideoConvertOptions {
    VideoConvertOptions::Encode {
        codec: VideoCodec::H264,
        rate_control: VideoRateControl::ConstantQuality { crf: 23 },
        speed: VideoSpeed::Medium,
        processor: VideoProcessor::Software,
        resize: None,
        frame_rate: None,
    }
}

#[test]
fn exact_maps_preserve_cross_family_source_order_and_independent_audio_processing() {
    let source = probe(source_json());
    let req = request(
        TargetFormat::Mp4,
        custom(),
        TrackStreamPolicy::KeepAll,
        TrackStreamPolicy::Choose {
            stream_indices: vec![7],
        },
    );
    let resolved = resolve(&req, &source, &encoders()).unwrap();

    let maps = resolved
        .plan
        .args
        .windows(2)
        .filter(|pair| pair[0] == "-map")
        .map(|pair| pair[1].as_str())
        .collect::<Vec<_>>();
    assert_eq!(maps, ["0:2", "0:5", "0:7", "0:9"]);
    assert!(resolved
        .plan
        .args
        .windows(2)
        .any(|p| p == ["-c:a:0", "aac"]));
    assert!(resolved
        .plan
        .args
        .windows(2)
        .any(|p| p == ["-b:a:0", "192k"]));
    assert!(resolved
        .plan
        .args
        .windows(2)
        .any(|p| p == ["-c:s:0", "copy"]));
    assert!(resolved
        .plan
        .args
        .windows(2)
        .any(|p| p == ["-c:a:1", "copy"]));
    assert_eq!(resolved.track_summary.retained.len(), 3);
    assert!(matches!(
        resolved.track_summary.retained[0].processing,
        VideoTrackProcessing::EncodedAac { bitrate_kbps: 192 }
    ));
    assert!(matches!(
        resolved.track_summary.retained[1].processing,
        VideoTrackProcessing::Copied
    ));
    assert!(matches!(
        resolved.track_summary.retained[2].processing,
        VideoTrackProcessing::Copied
    ));
    assert_eq!(resolved.track_summary.omitted_subtitles[0].index, 11);
}

#[test]
fn copy_is_all_or_refuse_but_dropped_incompatible_streams_do_not_block() {
    let source = probe(source_json());
    let all = request(
        TargetFormat::Mp4,
        VideoConvertOptions::Copy,
        TrackStreamPolicy::KeepAll,
        TrackStreamPolicy::KeepAll,
    );
    assert!(resolve(&all, &source, &encoders()).is_err());

    let subset = request(
        TargetFormat::Mp4,
        VideoConvertOptions::Copy,
        TrackStreamPolicy::Choose {
            stream_indices: vec![9],
        },
        TrackStreamPolicy::Choose {
            stream_indices: vec![7],
        },
    );
    let resolved = resolve(&subset, &source, &encoders()).unwrap();
    assert_eq!(
        resolved
            .track_summary
            .retained
            .iter()
            .map(|outcome| outcome.source.index)
            .collect::<Vec<_>>(),
        [7, 9]
    );
    assert_eq!(resolved.track_summary.omitted_audio[0].index, 5);
    assert_eq!(resolved.track_summary.omitted_subtitles[0].index, 11);

    let none = request(
        TargetFormat::Mp4,
        VideoConvertOptions::Copy,
        TrackStreamPolicy::None,
        TrackStreamPolicy::None,
    );
    assert!(resolve(&none, &source, &DetectedEncoders::empty()).is_ok());

    let promoted_default = request(
        TargetFormat::Mp4,
        custom(),
        TrackStreamPolicy::Choose {
            stream_indices: vec![5],
        },
        TrackStreamPolicy::None,
    );
    assert!(resolve(&promoted_default, &source, &encoders()).is_err());
}

#[test]
fn subtitle_copy_matrix_is_exact_for_copy_and_custom() {
    for (target, codec, supported) in [
        (TargetFormat::Mp4, "mov_text", true),
        (TargetFormat::Mov, "mov_text", true),
        (TargetFormat::Mkv, "subrip", true),
        (TargetFormat::Mkv, "ass", true),
        (TargetFormat::Mkv, "ssa", false),
        (TargetFormat::Mkv, "webvtt", true),
        (TargetFormat::Mp4, "subrip", false),
        (TargetFormat::Mkv, "srt", false),
        (TargetFormat::Mkv, "hdmv_pgs_subtitle", false),
    ] {
        let mut raw = source_json();
        raw["streams"] = json!([
            stream(2, "video", "h264", "Picture"),
            stream(7, "subtitle", codec, "English")
        ]);
        let source = probe(raw);
        let mut req = request(
            target,
            VideoConvertOptions::Copy,
            TrackStreamPolicy::None,
            TrackStreamPolicy::KeepAll,
        );
        let TrackConvertOptions::Video { source: bound, .. } = req.track_options.as_mut().unwrap()
        else {
            unreachable!()
        };
        *bound = source_binding(&source);
        assert_eq!(
            resolve(&req, &source, &encoders()).is_ok(),
            supported,
            "{target:?}/{codec}"
        );
        req.video_options = Some(custom());
        assert_eq!(
            resolve(&req, &source, &encoders()).is_ok(),
            supported,
            "custom {target:?}/{codec}"
        );
    }
}

#[test]
fn capabilities_report_per_stream_reasons_and_policy_availability() {
    let source = probe(source_json());
    let binding = source_binding(&source);
    let caps = settings(&source, TargetFormat::Mp4, &encoders(), &binding).unwrap();
    assert!(!caps.audio_tracks[0].copy.available);
    assert!(caps.audio_tracks[0].custom.available);
    assert!(caps.audio_tracks[1].copy.available);
    assert!(!caps.subtitle_tracks[1].copy.available);
    assert!(!caps.subtitle_tracks[1].custom.available);
    assert!(!caps.audio_policy.copy.keep_all.available);
    assert!(caps.audio_policy.copy.choose.available);
    assert!(caps.audio_policy.copy.none.available);
    assert!(!caps.subtitle_policy.custom.keep_all.available);
    assert!(caps.subtitle_policy.custom.choose.available);
    assert!(caps.subtitle_policy.custom.none.available);
    assert!(caps.audio_tracks[0].copy.reason.is_some());
    assert!(caps.subtitle_tracks[1].copy.reason.is_some());
}

#[test]
fn missing_codecs_cannot_be_hidden_by_none_and_capabilities_match_refusal() {
    let mut raw = source_json();
    raw["streams"][1]
        .as_object_mut()
        .unwrap()
        .remove("codec_name");
    let source = probe(raw);
    let binding = source_binding(&source);
    let mut req = request(
        TargetFormat::Mp4,
        custom(),
        TrackStreamPolicy::None,
        TrackStreamPolicy::None,
    );
    let TrackConvertOptions::Video { source: bound, .. } = req.track_options.as_mut().unwrap()
    else {
        unreachable!()
    };
    *bound = binding.clone();
    assert!(resolve(&req, &source, &encoders()).is_err());

    let caps = settings(&source, TargetFormat::Mp4, &encoders(), &binding).unwrap();
    assert!(!caps.audio_tracks[0].copy.available);
    assert!(!caps.audio_tracks[0].custom.available);
    assert!(caps.audio_tracks[0].custom.reason.is_some());
    for mode in [
        &caps.audio_policy.copy.keep_all,
        &caps.audio_policy.copy.choose,
        &caps.audio_policy.copy.none,
        &caps.audio_policy.custom.keep_all,
        &caps.audio_policy.custom.choose,
        &caps.audio_policy.custom.none,
        &caps.subtitle_policy.copy.none,
        &caps.subtitle_policy.custom.none,
    ] {
        assert!(!mode.available);
        assert!(mode.reason.is_some());
    }
}

#[test]
fn mp4_capabilities_require_a_supported_source_default_audio_stream() {
    let mut no_default = source_json();
    no_default["streams"][3]["disposition"]["default"] = json!(0);
    let no_default = probe(no_default);
    let caps = settings(
        &no_default,
        TargetFormat::Mp4,
        &encoders(),
        &source_binding(&no_default),
    )
    .unwrap();
    assert!(!caps.audio_policy.custom.keep_all.available);
    assert!(!caps.audio_policy.custom.choose.available);
    assert!(caps.audio_policy.custom.none.available);

    let mut unsupported_default = source_json();
    unsupported_default["streams"][1]["disposition"]["default"] = json!(1);
    unsupported_default["streams"][3]["disposition"]["default"] = json!(0);
    let unsupported_default = probe(unsupported_default);
    let caps = settings(
        &unsupported_default,
        TargetFormat::Mp4,
        &encoders(),
        &source_binding(&unsupported_default),
    )
    .unwrap();
    assert!(!caps.audio_policy.copy.keep_all.available);
    assert!(!caps.audio_policy.copy.choose.available);
    assert!(caps.audio_policy.custom.choose.available);
}

#[test]
fn staged_validation_checks_exact_count_order_metadata_disposition_and_timing() {
    let source = probe(source_json());
    let req = request(
        TargetFormat::Mp4,
        custom(),
        TrackStreamPolicy::Choose {
            stream_indices: vec![9],
        },
        TrackStreamPolicy::Choose {
            stream_indices: vec![7],
        },
    );
    let resolved = resolve(&req, &source, &encoders()).unwrap();
    let mut output_json = source_json();
    output_json["format"]["duration"] = json!("3");
    output_json["streams"] = json!([
        stream(0, "video", "h264", "Picture"),
        stream(1, "subtitle", "mov_text", "English"),
        stream(2, "audio", "aac", "Main")
    ]);
    output_json["streams"][2]["disposition"]["default"] = json!(1);
    let output = probe(output_json.clone());
    let summary = validate_output_against_source(
        &resolved.video_summary,
        &resolved.track_summary,
        &source,
        &output,
        TargetFormat::Mp4,
    )
    .unwrap();
    assert_eq!(summary.retained.len(), 2);

    output_json["streams"][2]["tags"]["title"] = json!("Changed");
    assert!(validate_output_against_source(
        &resolved.video_summary,
        &resolved.track_summary,
        &source,
        &probe(output_json),
        TargetFormat::Mkv,
    )
    .is_err());

    for mismatch in [
        "extra",
        "missing",
        "type",
        "codec",
        "default",
        "forced",
        "audio_timing",
        "video_timing",
    ] {
        let mut changed = source_json();
        changed["format"]["duration"] = json!("3");
        changed["streams"] = json!([
            stream(0, "video", "h264", "Picture"),
            stream(1, "subtitle", "mov_text", "English"),
            stream(2, "audio", "aac", "Main")
        ]);
        changed["streams"][2]["disposition"]["default"] = json!(1);
        match mismatch {
            "extra" => changed["streams"]
                .as_array_mut()
                .unwrap()
                .push(stream(3, "audio", "aac", "Extra")),
            "missing" => {
                changed["streams"].as_array_mut().unwrap().pop();
            }
            "type" => changed["streams"][2]["codec_type"] = json!("subtitle"),
            "codec" => changed["streams"][2]["codec_name"] = json!("ac3"),
            "default" => changed["streams"][2]["disposition"]["default"] = json!(0),
            "forced" => changed["streams"][1]["disposition"]["forced"] = json!(1),
            "audio_timing" => changed["streams"][2]["start_time"] = json!("1.25"),
            "video_timing" => changed["streams"][0]["duration"] = json!("5"),
            _ => unreachable!(),
        }
        assert!(
            validate_output_against_source(
                &resolved.video_summary,
                &resolved.track_summary,
                &source,
                &probe(changed),
                TargetFormat::Mp4,
            )
            .is_err(),
            "{mismatch}"
        );
    }
}

#[test]
fn staged_timing_accepts_primary_start_normalization() {
    let mut source_raw = source_json();
    source_raw["streams"][0]["start_time"] = json!("1");
    source_raw["streams"][3]["start_time"] = json!("1.25");
    let source = probe(source_raw);
    let mut req = request(
        TargetFormat::Mp4,
        custom(),
        TrackStreamPolicy::Choose {
            stream_indices: vec![9],
        },
        TrackStreamPolicy::None,
    );
    let TrackConvertOptions::Video { source: bound, .. } = req.track_options.as_mut().unwrap()
    else {
        unreachable!()
    };
    *bound = source_binding(&source);
    let resolved = resolve(&req, &source, &encoders()).unwrap();

    let mut output_raw = json!({
        "format": {"duration": "3", "size": "4096", "format_name": "mov,mp4"},
        "streams": [
            stream(0, "video", "h264", "Picture"),
            stream(1, "audio", "aac", "Main")
        ]
    });
    output_raw["streams"][1]["start_time"] = json!("0.25");
    output_raw["streams"][1]["disposition"]["default"] = json!(1);
    assert!(validate_output_against_source(
        &resolved.video_summary,
        &resolved.track_summary,
        &source,
        &probe(output_raw),
        TargetFormat::Mp4,
    )
    .is_ok());
}

#[test]
fn malformed_or_out_of_scope_source_facts_refuse_without_policy_narrowing() {
    let cases = [
        {
            let mut raw = source_json();
            raw["streams"][1]["disposition"]["hearing_impaired"] = json!(1);
            raw
        },
        {
            let mut raw = source_json();
            raw["streams"][1]["tags"]["title"] = json!(7);
            raw
        },
        {
            let mut raw = source_json();
            raw["streams"]
                .as_array_mut()
                .unwrap()
                .push(stream(12, "video", "h264", "Alternate"));
            raw
        },
        {
            let mut raw = source_json();
            raw["streams"].as_array_mut().unwrap().push(stream(
                12,
                "data",
                "bin_data",
                "Timed data",
            ));
            raw
        },
        {
            let mut raw = source_json();
            raw["streams"][0]["disposition"]["attached_pic"] = json!(1);
            raw
        },
    ];

    for source in cases {
        let source = probe(source);
        let mut req = request(
            TargetFormat::Mp4,
            VideoConvertOptions::Copy,
            TrackStreamPolicy::None,
            TrackStreamPolicy::None,
        );
        let TrackConvertOptions::Video { source: bound, .. } = req.track_options.as_mut().unwrap()
        else {
            unreachable!()
        };
        *bound = source_binding(&source);
        assert!(resolve(&req, &source, &encoders()).is_err());
    }
}

#[test]
fn legacy_single_audio_video_plan_remains_unindexed_and_byte_stable() {
    let raw = json!({
        "format": {"duration": "3", "size": "4096", "format_name": "matroska"},
        "streams": [
            stream(2, "video", "h264", "Picture"),
            stream(5, "audio", "aac", "Main")
        ]
    });
    let source = probe(raw);
    let mut req = request(
        TargetFormat::Mp4,
        VideoConvertOptions::Copy,
        TrackStreamPolicy::None,
        TrackStreamPolicy::None,
    );
    req.track_options = None;
    let resolved = goop_converter::video_options::resolve(&req, &source, &encoders()).unwrap();
    assert_eq!(
        resolved.plan.args,
        ["-map", "0:2", "-map", "0:5", "-c:v", "copy", "-c:a", "copy"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>()
    );
}

fn make_mixed_video_source(ffmpeg: &Path, output: &Path) {
    let status = Command::new(ffmpeg)
        .args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=320x180:r=24:d=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=2",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-map",
            "2:a:0",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a:0",
            "pcm_s16le",
            "-c:a:1",
            "aac",
            "-metadata:s:a:0",
            "language=eng",
            "-metadata:s:a:0",
            "title=PCM tone",
            "-metadata:s:a:1",
            "language=fra",
            "-metadata:s:a:1",
            "title=AAC tone",
            "-disposition:a:0",
            "default",
            "-disposition:a:1",
            "0",
        ])
        .arg(output)
        .status()
        .unwrap();
    assert!(status.success(), "failed to create mixed video source");
}

fn decoded_tone(resolver: &goop_sidecar::BinaryResolver, path: &Path, selector: &str) -> Vec<f32> {
    let output = Command::new(common::ffmpeg_path(resolver))
        .args(["-v", "error", "-i"])
        .arg(path)
        .args([
            "-map",
            selector,
            "-vn",
            "-sn",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    output
        .stdout
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect()
}

fn packet_hash(resolver: &goop_sidecar::BinaryResolver, path: &Path, selector: &str) -> Vec<u8> {
    let output = Command::new(common::ffmpeg_path(resolver))
        .args(["-v", "error", "-i"])
        .arg(path)
        .args([
            "-map", selector, "-c", "copy", "-f", "hash", "-hash", "sha256", "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    output.stdout
}

#[tokio::test]
#[ignore = "requires bundled ffmpeg and ffprobe sidecars"]
async fn bundled_ffmpeg_verifies_mixed_audio_outcomes_payload_and_tones() {
    let temp = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(temp.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let source = temp.path().join("mixed-video.mkv");
    let output = temp.path().join("mixed-video.mp4");
    make_mixed_video_source(&ffmpeg, &source);

    let detected = DetectedEncoders::from_names(["libx264", "libx265", "aac"]);
    let inspection =
        goop_converter::capabilities::inspect_source_with_encoders(&resolver, &source, &detected)
            .await
            .unwrap();
    let binding = inspection.track_source.unwrap();
    let mut req = request(
        TargetFormat::Mp4,
        custom(),
        TrackStreamPolicy::KeepAll,
        TrackStreamPolicy::None,
    );
    req.input_path = source.to_string_lossy().into_owned();
    req.output_path = output.to_string_lossy().into_owned();
    let TrackConvertOptions::Video { source: bound, .. } = req.track_options.as_mut().unwrap()
    else {
        unreachable!()
    };
    *bound = binding;

    let backend = goop_converter::FfmpegBackend::new(&resolver, Arc::new(common::SilentSink))
        .with_encoders(Arc::new(detected), false);
    let result = goop_converter::backend::ConversionBackend::convert(
        &backend,
        JobId::new(),
        &req,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let summary = result.video_track_execution.unwrap();
    assert!(matches!(
        summary.retained[0].processing,
        VideoTrackProcessing::EncodedAac { bitrate_kbps: 192 }
    ));
    assert!(matches!(
        summary.retained[1].processing,
        VideoTrackProcessing::Copied
    ));
    assert!(summary.retained.iter().all(|outcome| matches!(
        (&outcome.source_codec_tag, &outcome.output_codec_tag),
        (TrackTextFact::Value { .. }, TrackTextFact::Value { .. })
    )));
    assert_eq!(
        common::stream_codecs(&resolver, &output, "a"),
        ["aac", "aac"]
    );

    let first = decoded_tone(&resolver, &output, "0:a:0");
    let second = decoded_tone(&resolver, &output, "0:a:1");
    assert!(common::tone_magnitude(&first, 48_000.0, 440.0) > 0.03);
    assert!(common::tone_magnitude(&second, 48_000.0, 880.0) > 0.03);
    assert_eq!(
        packet_hash(&resolver, &source, "0:a:1"),
        packet_hash(&resolver, &output, "0:a:1")
    );
}

fn subtitle_fixture(codec: &str) -> (&'static str, &'static str) {
    match codec {
        "ass" => (
            "ass",
            "[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hello\n",
        ),
        "ssa" => (
            "ssa",
            "[Script Info]\nScriptType: v4.00\n[V4 Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding\nStyle: Default,Arial,20,&Hffffff,&Hffffff,&Hffffff,&H000000,0,0,1,1,0,2,10,10,10,0,1\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hello\n",
        ),
        "webvtt" => ("vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n"),
        _ => ("srt", "1\n00:00:00,000 --> 00:00:01,000\nHello\n"),
    }
}

#[tokio::test]
#[ignore = "requires bundled ffmpeg and ffprobe sidecars"]
async fn bundled_ffmpeg_proves_fixtureable_subtitle_copy_pairs() {
    let temp = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(temp.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let detected = DetectedEncoders::from_names(["libx264", "libx265", "aac"]);

    for (target, codec, encoder) in [
        (TargetFormat::Mp4, "mov_text", "mov_text"),
        (TargetFormat::Mov, "mov_text", "mov_text"),
        (TargetFormat::Mkv, "subrip", "srt"),
        (TargetFormat::Mkv, "ass", "ass"),
        (TargetFormat::Mkv, "webvtt", "webvtt"),
    ] {
        let (subtitle_extension, subtitle_text) = subtitle_fixture(codec);
        let subtitle = temp
            .path()
            .join(format!("source-{codec}.{subtitle_extension}"));
        std::fs::write(&subtitle, subtitle_text).unwrap();
        let source = temp
            .path()
            .join(format!("source-{codec}.{}", target.extension()));
        let output = temp
            .path()
            .join(format!("output-{codec}.{}", target.extension()));
        let status = Command::new(&ffmpeg)
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=320x180:r=24:d=2",
                "-i",
            ])
            .arg(&subtitle)
            .args([
                "-map",
                "0:v:0",
                "-map",
                "1:s:0",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:s",
                encoder,
                "-metadata:s:s:0",
                "language=eng",
                "-metadata:s:s:0",
                if matches!(target, TargetFormat::Mp4 | TargetFormat::Mov) {
                    "handler_name=English"
                } else {
                    "title=English"
                },
                "-disposition:s:0",
                "forced",
            ])
            .arg(&source)
            .status()
            .unwrap();
        assert!(status.success(), "failed to create {target:?}/{codec}");

        let inspection = goop_converter::capabilities::inspect_source_with_encoders(
            &resolver, &source, &detected,
        )
        .await
        .unwrap_or_else(|error| panic!("{target:?}/{codec}: {error}"));
        let binding = inspection.track_source.unwrap();
        let reported = binding
            .inventory
            .streams
            .iter()
            .find(|stream| stream.codec_type == "subtitle")
            .unwrap();
        assert_eq!(
            reported.codec_name,
            TrackTextFact::Value {
                value: codec.into()
            }
        );

        let mut req = request(
            target,
            VideoConvertOptions::Copy,
            TrackStreamPolicy::None,
            TrackStreamPolicy::KeepAll,
        );
        req.input_path = source.to_string_lossy().into_owned();
        req.output_path = output.to_string_lossy().into_owned();
        let TrackConvertOptions::Video { source: bound, .. } = req.track_options.as_mut().unwrap()
        else {
            unreachable!()
        };
        *bound = binding;
        let backend = goop_converter::FfmpegBackend::new(&resolver, Arc::new(common::SilentSink))
            .with_encoders(Arc::new(detected.clone()), false);
        let result = goop_converter::backend::ConversionBackend::convert(
            &backend,
            JobId::new(),
            &req,
            CancellationToken::new(),
        )
        .await
        .unwrap_or_else(|error| panic!("{target:?}/{codec}: {error}"));
        assert_eq!(common::stream_codecs(&resolver, &output, "s"), [codec]);
        assert_eq!(result.video_track_execution.unwrap().retained.len(), 1);
    }
}

#[tokio::test]
#[ignore = "requires bundled ffmpeg and ffprobe sidecars"]
async fn bundled_ffmpeg_rechecks_bound_source_before_run_and_publication() {
    for before_publish in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let resolver = common::bundled_resolver(temp.path());
        let ffmpeg = common::ffmpeg_path(&resolver);
        let source = temp.path().join("bound-source.mkv");
        let output = temp.path().join("must-not-publish.mp4");
        make_mixed_video_source(&ffmpeg, &source);
        let detected = DetectedEncoders::from_names(["libx264", "libx265", "aac"]);
        let binding = goop_converter::capabilities::inspect_source_with_encoders(
            &resolver, &source, &detected,
        )
        .await
        .unwrap()
        .track_source
        .unwrap();
        let retained_default = binding
            .inventory
            .streams
            .iter()
            .find(|stream| stream.codec_type == "audio" && stream.disposition.default == Some(true))
            .unwrap()
            .index;
        let mut req = request(
            TargetFormat::Mp4,
            custom(),
            TrackStreamPolicy::Choose {
                stream_indices: vec![retained_default],
            },
            TrackStreamPolicy::None,
        );
        req.input_path = source.to_string_lossy().into_owned();
        req.output_path = output.to_string_lossy().into_owned();
        let TrackConvertOptions::Video { source: bound, .. } = req.track_options.as_mut().unwrap()
        else {
            unreachable!()
        };
        *bound = binding;

        let mutate_path = source.clone();
        let mutate = Arc::new(move || {
            OpenOptions::new()
                .append(true)
                .open(&mutate_path)
                .unwrap()
                .write_all(b"late source mutation")
                .unwrap();
        });
        let backend = goop_converter::FfmpegBackend::new(&resolver, Arc::new(common::SilentSink))
            .with_encoders(Arc::new(detected), false);
        let backend = if before_publish {
            backend.with_before_publish_test_hook(mutate)
        } else {
            backend.with_before_run_test_hook(mutate)
        };
        let error = goop_converter::backend::ConversionBackend::convert(
            &backend,
            JobId::new(),
            &req,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(
            error.user_message().contains("source changed"),
            "unexpected error: {error:?}"
        );
        assert!(!output.exists());
    }
}
