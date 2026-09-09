use goop_converter::{
    encoders::{parse_encoders, DetectedEncoders},
    parse_probe_json,
    video_options::{capabilities, resolve, validate_output, validate_output_against_source},
};
use goop_core::*;
use serde_json::{json, Value};

fn source_json() -> Value {
    json!({"format":{"duration":"2.0","size":"4096"},"streams":[{"index":2,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"pix_fmt":"yuv420p","field_order":"progressive","sample_aspect_ratio":"1:1","avg_frame_rate":"24000/1001","r_frame_rate":"24/1","time_base":"1/24000","start_time":"0.000000","duration":"2.000000","disposition":{"attached_pic":0}},{"index":5,"codec_type":"audio","codec_name":"aac","start_time":"0.250000","duration":"1.500000","disposition":{"attached_pic":0}}]})
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

fn encode_with(
    resize: Option<VideoResize>,
    frame_rate: Option<VideoFrameRate>,
) -> VideoConvertOptions {
    VideoConvertOptions::Encode {
        codec: VideoCodec::H264,
        rate_control: VideoRateControl::ConstantQuality { crf: 23 },
        speed: VideoSpeed::Medium,
        processor: VideoProcessor::Software,
        resize,
        frame_rate,
    }
}

fn with_dimensions(mut value: Value, width: u32, height: u32) -> Value {
    value["streams"][0]["width"] = json!(width);
    value["streams"][0]["height"] = json!(height);
    value
}

#[test]
fn probe_reduces_exact_timing_facts_and_preserves_missing_or_malformed() {
    let mut value = source_json();
    value["streams"][0]["avg_frame_rate"] = json!("60000/2002");
    value["streams"][0]["r_frame_rate"] = json!("bad");
    value["streams"][0]
        .as_object_mut()
        .unwrap()
        .remove("time_base");
    let source = probe(value);
    let details = source.video_details.as_ref().unwrap();
    let stream = &details.streams[0];
    assert_eq!(
        stream.average_frame_rate,
        Some(VideoRationalFact::Exact {
            numerator: 30000,
            denominator: 1001,
        })
    );
    assert_eq!(stream.base_frame_rate, Some(VideoRationalFact::Malformed));
    assert_eq!(stream.time_base, None);
    assert_eq!(stream.start_time_ms, Some(0));
    assert_eq!(stream.duration_ms, Some(2_000));
    let audio = &details.streams[1];
    assert_eq!(audio.start_time_ms, Some(250));
    assert_eq!(audio.duration_ms, Some(1_500));
}

#[test]
fn probe_uses_stream_tick_and_matroska_tag_duration_fallbacks() {
    let mut value = source_json();
    value["streams"][0]
        .as_object_mut()
        .unwrap()
        .remove("duration");
    value["streams"][0]["duration_ts"] = json!(48_000);
    value["streams"][1]
        .as_object_mut()
        .unwrap()
        .remove("duration");
    value["streams"][1]["tags"] = json!({"DURATION":"00:00:01.500000000"});
    let source = probe(value);
    let streams = &source.video_details.unwrap().streams;
    assert_eq!(streams[0].duration_ms, Some(2_000));
    assert_eq!(streams[1].duration_ms, Some(1_500));

    let mut extreme = source_json();
    extreme["streams"][0]["start_time"] = json!("1e100");
    extreme["streams"][0]["duration"] = json!("1e100");
    let extreme = probe(extreme);
    let video = &extreme.video_details.unwrap().streams[0];
    assert_eq!(video.start_time_ms, None);
    assert_eq!(video.duration_ms, None);
}

#[test]
fn fit_within_resolves_landscape_portrait_rounding_and_no_enlargement() {
    for (source, box_size, expected) in [
        (source_json(), (1000, 1000), (1000, 562)),
        (source_json(), (1920, 500), (888, 500)),
        (source_json(), (333, 221), (332, 186)),
        (source_json(), (4000, 4000), (1920, 1080)),
    ] {
        let mut req = request();
        req.video_options = Some(encode_with(
            Some(VideoResize::FitWithin {
                width: box_size.0,
                height: box_size.1,
            }),
            None,
        ));
        let resolved = resolve(&req, &probe(source), &inventory()).unwrap();
        assert_eq!((resolved.summary.width, resolved.summary.height), expected);
        assert_eq!(
            resolved.plan.video_filters,
            vec![
                format!("scale={}:{}", expected.0, expected.1),
                "setsar=1".to_owned(),
            ]
        );
    }

    let mut req = request();
    req.video_options = Some(encode_with(
        Some(VideoResize::FitWithin {
            width: 2,
            height: 32768,
        }),
        None,
    ));
    let source = probe(with_dimensions(source_json(), 32768, 2));
    assert!(resolve(&req, &source, &inventory())
        .unwrap_err()
        .user_message()
        .contains("below 2"));
}

#[test]
fn fit_within_uses_upright_rotation_without_a_second_rotation_filter() {
    for (rotation, matrix, expected) in [
        (
            90,
            "00000000: 0 -65536 0\n00000001: 65536 0 0\n00000002: 0 0 1073741824",
            (562, 1000),
        ),
        (
            180,
            "00000000: -65536 0 0\n00000001: 0 -65536 0\n00000002: 0 0 1073741824",
            (800, 450),
        ),
        (
            270,
            "00000000: 0 65536 0\n00000001: -65536 0 0\n00000002: 0 0 1073741824",
            (562, 1000),
        ),
    ] {
        let mut value = source_json();
        value["streams"][0]["side_data_list"] = json!([{
            "side_data_type":"Display Matrix",
            "rotation":rotation,
            "displaymatrix":matrix
        }]);
        let mut req = request();
        req.video_options = Some(encode_with(
            Some(VideoResize::FitWithin {
                width: 800,
                height: 1000,
            }),
            None,
        ));
        let resolved = resolve(&req, &probe(value), &inventory()).unwrap();
        assert_eq!((resolved.summary.width, resolved.summary.height), expected);
        assert_eq!(
            resolved.plan.video_filters,
            [
                format!("scale={}:{}", expected.0, expected.1),
                "setsar=1".into()
            ]
        );
        assert!(resolved
            .plan
            .video_filters
            .iter()
            .all(|filter| !filter.contains("transpose")));
    }
}

#[test]
fn legacy_width_caps_keep_their_existing_geometry_and_filter_shape() {
    for (cap, expected, filter) in [
        (
            ResolutionCap::R1080p,
            (1920, 1080),
            "scale='trunc(min(1920,iw)/2)*2':-2",
        ),
        (
            ResolutionCap::R720p,
            (1280, 720),
            "scale='trunc(min(1280,iw)/2)*2':-2",
        ),
        (
            ResolutionCap::R480p,
            (854, 480),
            "scale='trunc(min(854,iw)/2)*2':-2",
        ),
    ] {
        let mut req = request();
        req.resolution_cap = Some(cap);
        let resolved = resolve(&req, &probe(source_json()), &inventory()).unwrap();
        assert_eq!((resolved.summary.width, resolved.summary.height), expected);
        assert_eq!(resolved.plan.video_filters, [filter, "setsar=1"]);
    }
}

#[test]
fn preserve_and_constant_frame_rate_have_one_explicit_timing_authority() {
    let source = probe(source_json());
    for (choice, expected_time_base, expected_filter) in [
        (VideoFrameRate::Preserve, "demux", None),
        (
            VideoFrameRate::Constant {
                numerator: 30000,
                denominator: 1001,
            },
            "filter",
            Some("fps=fps=30000/1001:round=near"),
        ),
    ] {
        let mut req = request();
        req.video_options = Some(encode_with(None, Some(choice.clone())));
        let resolved = resolve(&req, &source, &inventory()).unwrap();
        assert_eq!(
            resolved
                .plan
                .args
                .windows(2)
                .filter(|pair| pair[0] == "-fps_mode:v")
                .count(),
            1
        );
        assert!(resolved
            .plan
            .args
            .windows(2)
            .any(|pair| pair == ["-fps_mode:v", "passthrough"]));
        assert!(resolved
            .plan
            .args
            .windows(2)
            .any(|pair| pair == ["-enc_time_base:v", expected_time_base]));
        assert!(!resolved.plan.args.iter().any(|arg| arg == "-r"));
        assert_eq!(
            resolved.plan.video_filters.last().map(String::as_str),
            expected_filter
        );
        assert_eq!(resolved.summary.requested_frame_rate, Some(choice));
    }
}

#[test]
fn absent_frame_rate_keeps_the_previous_argument_vector() {
    let resolved = resolve(&request(), &probe(source_json()), &inventory()).unwrap();
    assert_eq!(
        resolved.plan.args,
        [
            "-map", "0:2", "-map", "0:5", "-c:v", "libx264", "-preset", "medium", "-pix_fmt",
            "yuv420p", "-crf", "23", "-c:a", "copy"
        ]
    );
    assert!(resolved.plan.video_filters.is_empty());
    assert_eq!(resolved.summary.requested_frame_rate, None);
}

#[test]
fn missing_or_malformed_timing_disables_only_the_fps_editor() {
    for value in [Value::Null, json!("bad")] {
        let mut raw = source_json();
        if value.is_null() {
            raw["streams"][0]
                .as_object_mut()
                .unwrap()
                .remove("avg_frame_rate");
        } else {
            raw["streams"][0]["avg_frame_rate"] = value;
        }
        let source = probe(raw);
        let caps = capabilities(&source, TargetFormat::Mp4, &inventory());
        assert!(caps.encode.available);
        let timing = caps.frame_rate.unwrap();
        assert!(!timing.available);
        assert!(timing.default.is_none());
        assert!(timing.reason.unwrap().contains("timing"));

        let mut legacy = request();
        assert!(resolve(&legacy, &source, &inventory()).is_ok());
        legacy.video_options = Some(encode_with(None, Some(VideoFrameRate::Preserve)));
        assert!(resolve(&legacy, &source, &inventory()).is_err());
    }
}

#[test]
fn incomplete_stream_endpoints_disable_frame_rate_before_conversion() {
    let mut raw = source_json();
    raw["streams"][1]
        .as_object_mut()
        .unwrap()
        .remove("start_time");
    let source = probe(raw);
    let timing = capabilities(&source, TargetFormat::Mp4, &inventory())
        .frame_rate
        .unwrap();
    assert!(!timing.available);
    assert!(timing.reason.unwrap().contains("stream endpoints"));

    let mut req = request();
    req.video_options = Some(encode_with(None, Some(VideoFrameRate::Preserve)));
    assert!(resolve(&req, &source, &inventory())
        .unwrap_err()
        .user_message()
        .contains("stream endpoints"));
}

#[test]
fn output_timing_mismatch_is_rejected() {
    let mut req = request();
    req.video_options = Some(encode_with(
        None,
        Some(VideoFrameRate::Constant {
            numerator: 30000,
            denominator: 1001,
        }),
    ));
    let expected = resolve(&req, &probe(source_json()), &inventory())
        .unwrap()
        .summary;
    let mut wrong = source_json();
    wrong["streams"][0]["avg_frame_rate"] = json!("24/1");
    assert!(validate_output(&expected, &probe(wrong))
        .unwrap_err()
        .user_message()
        .contains("frame rate"));

    let source = probe(source_json());
    let mut late = source.clone();
    late.duration_ms += 100;
    let late_video = &mut late.video_details.as_mut().unwrap().streams[0];
    late_video.average_frame_rate = Some(VideoRationalFact::Exact {
        numerator: 30_000,
        denominator: 1_001,
    });
    assert!(validate_output_against_source(&expected, &source, &late)
        .unwrap_err()
        .user_message()
        .contains("duration"));

    let mut truncated_video = source_json();
    truncated_video["streams"][0]["avg_frame_rate"] = json!("30000/1001");
    truncated_video["streams"][0]["duration"] = json!("1.000000");
    assert!(
        validate_output_against_source(&expected, &source, &probe(truncated_video))
            .unwrap_err()
            .user_message()
            .contains("video endpoint")
    );

    let mut shifted_audio = source_json();
    shifted_audio["streams"][0]["avg_frame_rate"] = json!("30000/1001");
    shifted_audio["streams"][1]["start_time"] = json!("0.750000");
    assert!(
        validate_output_against_source(&expected, &source, &probe(shifted_audio))
            .unwrap_err()
            .user_message()
            .contains("audio offset")
    );

    let mut impossible_endpoint = source.clone();
    impossible_endpoint.video_details.as_mut().unwrap().streams[1].duration_ms = Some(u64::MAX);
    let mut valid_actual = source.clone();
    valid_actual.video_details.as_mut().unwrap().streams[0].average_frame_rate =
        Some(VideoRationalFact::Exact {
            numerator: 30_000,
            denominator: 1_001,
        });
    let error = validate_output_against_source(&expected, &impossible_endpoint, &valid_actual)
        .unwrap_err()
        .user_message();
    assert!(error.contains("audio endpoint"), "{error}");

    let mut missing_start = valid_actual.clone();
    missing_start.video_details.as_mut().unwrap().streams[1].start_time_ms = None;
    assert!(
        validate_output_against_source(&expected, &source, &missing_start)
            .unwrap_err()
            .user_message()
            .contains("start time")
    );
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
        resize: None,
        frame_rate: None,
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
        resize: None,
        frame_rate: None,
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
fn resize_and_frame_rate_do_not_change_audio_decisions() {
    for (source_audio, expected_codec, expected_copied) in
        [("aac", "aac", true), ("vorbis", "aac", false)]
    {
        let mut value = source_json();
        value["streams"][1]["codec_name"] = json!(source_audio);
        let source = probe(value);
        let baseline = resolve(&request(), &source, &inventory()).unwrap();
        let mut changed = request();
        changed.video_options = Some(encode_with(
            Some(VideoResize::FitWithin {
                width: 1280,
                height: 720,
            }),
            Some(VideoFrameRate::Constant {
                numerator: 30,
                denominator: 1,
            }),
        ));
        let changed = resolve(&changed, &source, &inventory()).unwrap();
        assert_eq!(
            baseline.summary.audio_codec.as_deref(),
            Some(expected_codec)
        );
        assert_eq!(changed.summary.audio_codec.as_deref(), Some(expected_codec));
        assert_eq!(baseline.summary.audio_copied, expected_copied);
        assert_eq!(changed.summary.audio_copied, expected_copied);
        let baseline_audio: Vec<_> = baseline
            .plan
            .args
            .windows(2)
            .filter(|pair| matches!(pair[0].as_str(), "-c:a" | "-b:a"))
            .collect();
        let changed_audio: Vec<_> = changed
            .plan
            .args
            .windows(2)
            .filter(|pair| matches!(pair[0].as_str(), "-c:a" | "-b:a"))
            .collect();
        assert_eq!(baseline_audio, changed_audio);
    }

    let mut silent = source_json();
    silent["streams"].as_array_mut().unwrap().pop();
    let mut req = request();
    req.video_options = Some(encode_with(
        Some(VideoResize::Original),
        Some(VideoFrameRate::Preserve),
    ));
    let resolved = resolve(&req, &probe(silent), &inventory()).unwrap();
    assert!(resolved.summary.audio_codec.is_none());
    assert!(!resolved.plan.args.iter().any(|arg| arg == "-c:a"));
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
    let ready = capabilities(&source, TargetFormat::Mp4, &inventory());
    let resize = ready.resize.unwrap();
    assert!(resize.available);
    assert_eq!((resize.min_dimension, resize.max_dimension), (2, 32_768));
    assert!(resize.no_enlargement);
    assert_eq!(resize.default, VideoResize::Original);
    let timing = ready.frame_rate.unwrap();
    assert!(timing.available);
    assert_eq!(timing.default, Some(VideoFrameRate::Preserve));
    assert_eq!(timing.constant_choices.len(), 8);
    assert_eq!(
        timing.constant_choices[3],
        VideoFrameRateChoice {
            frame_rate: VideoFrameRate::Constant {
                numerator: 30_000,
                denominator: 1_001,
            },
            label: "29.97 fps".into(),
        }
    );
    assert_eq!(
        timing.average_frame_rate,
        p.summary.source_average_frame_rate
    );
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

#[tokio::test]
#[ignore]
async fn bundled_ffmpeg_accepts_preserve_and_constant_timing_arguments() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(links.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let encoders = goop_converter::detect_encoders(&resolver).await;
    let source = tmp.path().join("timing-source.mp4");
    make_explicit_source(&ffmpeg, &source, "libx264", "aac", 320, 180);

    for (name, frame_rate, expected_rate) in [
        ("preserve", VideoFrameRate::Preserve, (24, 1)),
        (
            "constant",
            VideoFrameRate::Constant {
                numerator: 30_000,
                denominator: 1_001,
            },
            (30_000, 1_001),
        ),
    ] {
        let mut req = request();
        req.input_path = source.to_string_lossy().into_owned();
        req.output_path = tmp
            .path()
            .join(format!("{name}.mp4"))
            .to_string_lossy()
            .into_owned();
        req.video_options = Some(encode_with(
            Some(VideoResize::FitWithin {
                width: 160,
                height: 100,
            }),
            Some(frame_rate),
        ));
        let result = run_explicit(&resolver, &req, &encoders).await.unwrap();
        let facts = FfmpegBackend::probe(&resolver, Path::new(&result.output_path))
            .await
            .unwrap();
        let stream = &facts.video_details.unwrap().streams[0];
        assert_eq!((facts.width, facts.height), (Some(160), Some(90)));
        assert_eq!(
            stream.average_frame_rate,
            Some(VideoRationalFact::Exact {
                numerator: expected_rate.0,
                denominator: expected_rate.1,
            })
        );
    }
}

fn video_presentation_times(ffprobe: &Path, path: &Path) -> Vec<f64> {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_frames",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    parse_video_presentation_times(&output.stdout)
        .unwrap_or_else(|error| panic!("invalid ffprobe frame inventory: {error}"))
}

fn parse_video_presentation_times(output: &[u8]) -> Result<Vec<f64>, String> {
    let document: Value = serde_json::from_slice(output).map_err(|error| error.to_string())?;
    let frames = document["frames"]
        .as_array()
        .ok_or_else(|| "frame inventory is required".to_owned())?;
    if frames.is_empty() {
        return Err("frame inventory must not be empty".to_owned());
    }
    frames
        .iter()
        .map(|frame| {
            let text = frame["best_effort_timestamp_time"]
                .as_str()
                .ok_or_else(|| "frame timestamp is required".to_owned())?;
            let timestamp: f64 = text
                .parse()
                .map_err(|_| "frame timestamp must be numeric".to_owned())?;
            if !timestamp.is_finite() {
                return Err("frame timestamp must be finite".to_owned());
            }
            Ok(timestamp)
        })
        .collect()
}

#[test]
fn frame_time_inventory_rejects_missing_and_malformed_timestamps() {
    assert!(parse_video_presentation_times(br#"{"frames":[{}]}"#).is_err());
    assert!(parse_video_presentation_times(
        br#"{"frames":[{"best_effort_timestamp_time":"not-a-number"}]}"#
    )
    .is_err());
}

fn presentation_bounds(packets: &[(f64, f64)]) -> (f64, f64) {
    assert!(packets.iter().all(|(timestamp, duration)| {
        timestamp.is_finite() && duration.is_finite() && *duration >= 0.0
    }));
    let first = packets
        .iter()
        .map(|(timestamp, _)| *timestamp)
        .min_by(f64::total_cmp)
        .expect("selected stream must have packets");
    let last = packets
        .iter()
        .map(|(timestamp, duration)| timestamp + duration)
        .max_by(f64::total_cmp)
        .unwrap();
    (first, last)
}

fn packet_bounds(ffprobe: &Path, path: &Path, selector: &str) -> (f64, f64) {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            selector,
            "-show_packets",
            "-show_entries",
            "packet=pts_time,duration_time",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let document: Value = serde_json::from_slice(&output.stdout).unwrap();
    let packets: Vec<(f64, f64)> = document["packets"]
        .as_array()
        .expect("ffprobe packet inventory is required")
        .iter()
        .map(|packet| {
            let parse = |field: &str| {
                packet[field]
                    .as_str()
                    .unwrap_or_else(|| panic!("packet {field} is required"))
                    .parse()
                    .unwrap_or_else(|_| panic!("packet {field} must be numeric"))
            };
            (parse("pts_time"), parse("duration_time"))
        })
        .collect();
    presentation_bounds(&packets)
}

fn minimum_packet_pts(ffprobe: &Path, path: &Path, selector: &str) -> f64 {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            selector,
            "-show_packets",
            "-show_entries",
            "packet=pts_time",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    parse_minimum_packet_pts(&output.stdout)
        .unwrap_or_else(|error| panic!("invalid ffprobe packet inventory: {error}"))
}

fn parse_minimum_packet_pts(output: &[u8]) -> Result<f64, String> {
    let document: Value = serde_json::from_slice(output).map_err(|error| error.to_string())?;
    let packets = document["packets"]
        .as_array()
        .ok_or_else(|| "packet inventory is required".to_owned())?;
    let mut timestamps = packets
        .iter()
        .map(|packet| {
            let text = packet["pts_time"]
                .as_str()
                .ok_or_else(|| "packet pts_time is required".to_owned())?;
            let timestamp: f64 = text
                .parse()
                .map_err(|_| "packet pts_time must be numeric".to_owned())?;
            if !timestamp.is_finite() {
                return Err("packet pts_time must be finite".to_owned());
            }
            Ok(timestamp)
        })
        .collect::<Result<Vec<_>, _>>()?;
    timestamps
        .drain(..)
        .min_by(f64::total_cmp)
        .ok_or_else(|| "packet inventory must not be empty".to_owned())
}

#[test]
fn presentation_bounds_use_the_greatest_pts_not_decode_order_tail() {
    assert_eq!(
        presentation_bounds(&[(0.0, 0.04), (1.0, 0.04), (0.96, 0.04)]),
        (0.0, 1.04)
    );
}

#[test]
fn minimum_packet_pts_is_order_independent_and_fail_closed() {
    assert_eq!(
        parse_minimum_packet_pts(br#"{"packets":[{"pts_time":"1.0"},{"pts_time":"0.5"}]}"#),
        Ok(0.5)
    );
    assert!(parse_minimum_packet_pts(br#"{"packets":[{}]}"#).is_err());
    assert!(parse_minimum_packet_pts(br#"{"packets":[{"pts_time":"NaN"}]}"#).is_err());
}

fn decoded_corner_kinds(ffmpeg: &Path, path: &Path, width: usize, height: usize) -> [char; 4] {
    let output = Command::new(ffmpeg)
        .args(["-v", "error", "-ss", "0.2", "-i"])
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout.len(), width * height * 3);
    let classify = |x: usize, y: usize| {
        let offset = (y * width + x) * 3;
        let (r, g, b) = (
            output.stdout[offset],
            output.stdout[offset + 1],
            output.stdout[offset + 2],
        );
        if r > g.saturating_add(40) && r > b.saturating_add(40) {
            'R'
        } else if g > r.saturating_add(30) && g > b.saturating_add(30) {
            'G'
        } else if b > r.saturating_add(40) && b > g.saturating_add(40) {
            'B'
        } else if r > 120 && g > 100 && b < 80 {
            'Y'
        } else {
            panic!("unclassified RGB corner sample ({r}, {g}, {b}) at ({x}, {y})")
        }
    };
    [
        classify(width / 4, height / 4),
        classify(width * 3 / 4, height / 4),
        classify(width / 4, height * 3 / 4),
        classify(width * 3 / 4, height * 3 / 4),
    ]
}

fn normalized_intervals(times: &[f64]) -> Vec<f64> {
    times.windows(2).map(|pair| pair[1] - pair[0]).collect()
}

fn assert_within(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "expected {actual:.9} within {tolerance:.9} of {expected:.9}"
    );
}

#[tokio::test]
#[ignore]
async fn bundled_ffmpeg_preserves_vfr_intervals_and_converts_frame_counts_without_speed_change() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(links.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let ffprobe = resolver
        .resolve("ffprobe")
        .expect("bundled ffprobe must be resolvable")
        .path;
    let encoders = goop_converter::detect_encoders(&resolver).await;

    let vfr_source = tmp.path().join("vfr-source.mkv");
    let generated = Command::new(&ffmpeg)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=10",
            "-vf",
            "select='between(n,0,2)+between(n,5,7)+between(n,12,15)'",
            "-frames:v",
            "10",
            "-c:v",
            "libx264",
            "-bf",
            "2",
            "-pix_fmt",
            "yuv420p",
            "-fps_mode",
            "vfr",
        ])
        .arg(&vfr_source)
        .status()
        .unwrap();
    assert!(generated.success());
    let source_times = video_presentation_times(&ffprobe, &vfr_source);
    assert_eq!(source_times.len(), 10);
    assert!(normalized_intervals(&source_times)
        .windows(2)
        .any(|pair| (pair[0] - pair[1]).abs() > 0.05));

    let mut preserve = request();
    preserve.target = TargetFormat::Mkv;
    preserve.input_path = vfr_source.to_string_lossy().into_owned();
    preserve.output_path = tmp
        .path()
        .join("vfr-preserve.mkv")
        .to_string_lossy()
        .into_owned();
    preserve.video_options = Some(encode_with(None, Some(VideoFrameRate::Preserve)));
    let preserved = run_explicit(&resolver, &preserve, &encoders).await.unwrap();
    let preserved_times = video_presentation_times(&ffprobe, Path::new(&preserved.output_path));
    assert_eq!(preserved_times.len(), source_times.len());
    for (actual, expected) in normalized_intervals(&preserved_times)
        .iter()
        .zip(normalized_intervals(&source_times))
    {
        assert_within(*actual, expected, 0.002);
    }

    for (source_rate, requested_rate, expected_frames) in [
        (
            "24",
            VideoFrameRate::Constant {
                numerator: 30,
                denominator: 1,
            },
            60,
        ),
        (
            "60",
            VideoFrameRate::Constant {
                numerator: 24,
                denominator: 1,
            },
            48,
        ),
        (
            "24000/1001",
            VideoFrameRate::Constant {
                numerator: 30_000,
                denominator: 1_001,
            },
            60,
        ),
    ] {
        let source = tmp
            .path()
            .join(format!("cfr-{}.mkv", source_rate.replace('/', "-")));
        assert!(Command::new(&ffmpeg)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!("testsrc2=size=320x180:rate={source_rate}:duration=2"),
                "-c:v",
                "libx264",
                "-bf",
                "2",
                "-pix_fmt",
                "yuv420p",
                "-fps_mode",
                "cfr",
            ])
            .arg(&source)
            .status()
            .unwrap()
            .success());
        let source_times = video_presentation_times(&ffprobe, &source);
        let mut convert = request();
        convert.target = TargetFormat::Mkv;
        convert.input_path = source.to_string_lossy().into_owned();
        convert.output_path = tmp
            .path()
            .join(format!("converted-{}.mkv", source_rate.replace('/', "-")))
            .to_string_lossy()
            .into_owned();
        convert.video_options = Some(encode_with(None, Some(requested_rate.clone())));
        let converted = run_explicit(&resolver, &convert, &encoders).await.unwrap();
        let converted_times = video_presentation_times(&ffprobe, Path::new(&converted.output_path));
        assert_eq!(converted_times.len(), expected_frames);
        let source_span = source_times.last().unwrap() - source_times.first().unwrap();
        let converted_span = converted_times.last().unwrap() - converted_times.first().unwrap();
        let VideoFrameRate::Constant {
            numerator,
            denominator,
        } = requested_rate
        else {
            unreachable!()
        };
        let target_interval = f64::from(denominator) / f64::from(numerator);
        assert_within(converted_span, source_span, target_interval + 0.002);
    }
}

#[tokio::test]
#[ignore]
async fn bundled_ffmpeg_preserve_keeps_nonzero_bframe_timing_and_relative_audio_offset() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(links.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let ffprobe = resolver
        .resolve("ffprobe")
        .expect("bundled ffprobe must be resolvable")
        .path;
    let encoders = goop_converter::detect_encoders(&resolver).await;
    let source = tmp.path().join("offset-source.mkv");
    assert!(Command::new(&ffmpeg)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=2",
            "-itsoffset",
            "0.25",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1.5",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-bf",
            "2",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-fps_mode",
            "cfr",
        ])
        .arg(&source)
        .status()
        .unwrap()
        .success());
    let source_times = video_presentation_times(&ffprobe, &source);
    let source_offset =
        minimum_packet_pts(&ffprobe, &source, "a:0") - minimum_packet_pts(&ffprobe, &source, "v:0");

    let mut preserve = request();
    preserve.target = TargetFormat::Mkv;
    preserve.input_path = source.to_string_lossy().into_owned();
    preserve.output_path = tmp
        .path()
        .join("offset-preserve.mkv")
        .to_string_lossy()
        .into_owned();
    preserve.video_options = Some(encode_with(None, Some(VideoFrameRate::Preserve)));
    let preserved = run_explicit(&resolver, &preserve, &encoders).await.unwrap();
    let output_path = Path::new(&preserved.output_path);
    let preserved_times = video_presentation_times(&ffprobe, output_path);
    assert_eq!(preserved_times.len(), source_times.len());
    assert!(preserved_times.windows(2).all(|pair| pair[0] < pair[1]));
    for (actual, expected) in normalized_intervals(&preserved_times)
        .iter()
        .zip(normalized_intervals(&source_times))
    {
        assert_within(*actual, expected, 0.002);
    }
    let preserved_offset = minimum_packet_pts(&ffprobe, output_path, "a:0")
        - minimum_packet_pts(&ffprobe, output_path, "v:0");
    assert_within(preserved_offset, source_offset, 1.0 / 24.0 + 0.002);
}

#[tokio::test]
#[ignore]
async fn bundled_ffmpeg_new_controls_cover_codec_container_matrix_and_stream_endpoints() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(links.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let ffprobe = resolver
        .resolve("ffprobe")
        .expect("bundled ffprobe must be resolvable")
        .path;
    let encoders = goop_converter::detect_encoders(&resolver).await;
    let source = tmp.path().join("matrix-source.mkv");
    make_explicit_source(&ffmpeg, &source, "libx264", "libvorbis", 320, 180);
    let source_video = packet_bounds(&ffprobe, &source, "v:0");
    let source_audio = packet_bounds(&ffprobe, &source, "a:0");

    for (codec, encoder, stream_codec) in [
        (VideoCodec::H264, "libx264", "h264"),
        (VideoCodec::Hevc, "libx265", "hevc"),
    ] {
        assert!(encoders.is_available(encoder), "missing required {encoder}");
        for target in [TargetFormat::Mp4, TargetFormat::Mov, TargetFormat::Mkv] {
            let mut req = request();
            req.target = target;
            req.input_path = source.to_string_lossy().into_owned();
            req.output_path = tmp
                .path()
                .join(format!("matrix-{stream_codec}.{}", target.extension()))
                .to_string_lossy()
                .into_owned();
            req.video_options = Some(VideoConvertOptions::Encode {
                codec,
                rate_control: VideoRateControl::ConstantQuality { crf: 23 },
                speed: VideoSpeed::Fast,
                processor: VideoProcessor::Software,
                resize: Some(VideoResize::FitWithin {
                    width: 160,
                    height: 100,
                }),
                frame_rate: Some(VideoFrameRate::Constant {
                    numerator: 30_000,
                    denominator: 1_001,
                }),
            });
            let converted = run_explicit(&resolver, &req, &encoders).await.unwrap();
            let output_path = Path::new(&converted.output_path);
            let facts = FfmpegBackend::probe(&resolver, output_path).await.unwrap();
            assert_eq!(facts.video_codec.as_deref(), Some(stream_codec));
            assert_eq!((facts.width, facts.height), (Some(160), Some(90)));
            assert_eq!(
                facts
                    .video_details
                    .as_ref()
                    .unwrap()
                    .streams
                    .iter()
                    .find(|stream| stream.codec_type == "video")
                    .unwrap()
                    .average_frame_rate,
                Some(VideoRationalFact::Exact {
                    numerator: 30_000,
                    denominator: 1_001,
                })
            );
            assert_eq!(
                facts.audio_codec.as_deref(),
                Some(if target == TargetFormat::Mkv {
                    "vorbis"
                } else {
                    "aac"
                })
            );
            let output_video = packet_bounds(&ffprobe, output_path, "v:0");
            let output_audio = packet_bounds(&ffprobe, output_path, "a:0");
            let tolerance = 1_001.0 / 30_000.0 + 0.003;
            assert_within(
                output_video.1 - output_video.0,
                source_video.1 - source_video.0,
                tolerance,
            );
            assert_within(
                output_audio.1 - output_video.0,
                source_audio.1 - source_video.0,
                tolerance,
            );
        }
    }
}

#[tokio::test]
#[ignore]
async fn bundled_ffmpeg_fit_within_decodes_marked_corners_upright_for_all_rotations() {
    let tmp = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(links.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let encoders = goop_converter::detect_encoders(&resolver).await;
    let base = tmp.path().join("marked-corners.mp4");
    let generated = Command::new(&ffmpeg)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=black:size=320x180:rate=24:duration=1",
            "-vf",
            "drawbox=x=0:y=0:w=160:h=90:color=red:t=fill,drawbox=x=160:y=0:w=160:h=90:color=green:t=fill,drawbox=x=0:y=90:w=160:h=90:color=blue:t=fill,drawbox=x=160:y=90:w=160:h=90:color=yellow:t=fill",
            "-c:v",
            "libx264",
            "-crf",
            "0",
            "-pix_fmt",
            "yuv420p",
        ])
        .arg(&base)
        .output()
        .unwrap();
    assert!(
        generated.status.success(),
        "{}",
        String::from_utf8_lossy(&generated.stderr)
    );

    for (rotation, expected_size, expected_corners) in [
        (90, (90, 160), ['G', 'Y', 'R', 'B']),
        (180, (160, 90), ['Y', 'B', 'G', 'R']),
        (270, (90, 160), ['B', 'R', 'Y', 'G']),
    ] {
        let marked = tmp.path().join(format!("marked-{rotation}.mp4"));
        let copied = Command::new(&ffmpeg)
            .args([
                "-v",
                "error",
                "-display_rotation",
                &rotation.to_string(),
                "-i",
            ])
            .arg(&base)
            .args(["-c", "copy"])
            .arg(&marked)
            .output()
            .unwrap();
        assert!(
            copied.status.success(),
            "{}",
            String::from_utf8_lossy(&copied.stderr)
        );
        let mut req = request();
        req.input_path = marked.to_string_lossy().into_owned();
        req.output_path = tmp
            .path()
            .join(format!("upright-{rotation}.mp4"))
            .to_string_lossy()
            .into_owned();
        req.video_options = Some(encode_with(
            Some(VideoResize::FitWithin {
                width: 160,
                height: 160,
            }),
            Some(VideoFrameRate::Preserve),
        ));
        let converted = run_explicit(&resolver, &req, &encoders).await.unwrap();
        let output = Path::new(&converted.output_path);
        let facts = FfmpegBackend::probe(&resolver, output).await.unwrap();
        assert_eq!((facts.width.unwrap(), facts.height.unwrap()), expected_size);
        assert_eq!(
            decoded_corner_kinds(
                &ffmpeg,
                output,
                expected_size.0 as usize,
                expected_size.1 as usize
            ),
            expected_corners
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
                resize: None,
                frame_rate: None,
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
                    resize: None,
                    frame_rate: None,
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
