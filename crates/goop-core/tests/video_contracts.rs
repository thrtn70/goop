use goop_core::*;
use serde_json::{json, Value};

fn encode(rate: Value) -> Value {
    json!({"kind":"encode","codec":"h264","rate_control":rate,"speed":"medium","processor":"software"})
}
fn encode_with(rate: Value, resize: Value, frame_rate: Value) -> Value {
    json!({
        "kind":"encode",
        "codec":"h264",
        "rate_control":rate,
        "speed":"medium",
        "processor":"software",
        "resize":resize,
        "frame_rate":frame_rate
    })
}
fn request(options: Value) -> ConvertRequest {
    serde_json::from_value(json!({"input_path":"in.mp4","output_path":"out.mp4","target":"mp4","video_options":options})).unwrap()
}
#[test]
fn exact_wire_forms_roundtrip_and_reject_unknown_nested_fields() {
    for value in [
        json!({"kind":"copy"}),
        encode(json!({"kind":"constant_quality","crf":23})),
        json!({"kind":"encode","codec":"hevc","rate_control":{"kind":"average_bitrate","kbps":5000},"speed":"slow","processor":"software"}),
    ] {
        let options: VideoConvertOptions = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&options).unwrap(), value);
        assert!(validate_video_options(&options).is_ok());
    }
    for value in [
        json!({"kind":"copy","codec":"h264"}),
        encode(json!({"kind":"constant_quality","crf":23,"kbps":5000})),
        encode(json!({"kind":"average_bitrate","kbps":5000,"crf":23})),
        json!({"kind":"encode","codec":"h264","rate_control":{"kind":"constant_quality","crf":23},"speed":"medium","processor":"software","extra":true}),
    ] {
        assert!(serde_json::from_value::<VideoConvertOptions>(value).is_err());
    }
}
#[test]
fn ranges_are_inclusive_and_reject_floats() {
    for (kind, key, good, bad) in [
        ("constant_quality", "crf", vec![1, 23, 51], vec![0, 52, 255]),
        (
            "average_bitrate",
            "kbps",
            vec![100, 5000, 200000],
            vec![0, 99, 200001],
        ),
    ] {
        for number in good {
            let opts = serde_json::from_value(encode(json!({"kind":kind,key:number}))).unwrap();
            assert!(validate_video_options(&opts).is_ok());
        }
        for number in bad {
            let opts = serde_json::from_value(encode(json!({"kind":kind,key:number}))).unwrap();
            assert!(validate_video_options(&opts).is_err());
        }
        for number in [json!(1.5), json!(23.0), json!(-1), json!("23")] {
            assert!(serde_json::from_value::<VideoConvertOptions>(encode(
                json!({"kind":kind,key:number})
            ))
            .is_err());
        }
    }
}

#[test]
fn resize_and_frame_rate_wire_forms_are_strict_and_exact() {
    let rate = json!({"kind":"constant_quality","crf":23});
    for (resize, frame_rate) in [
        (json!({"kind":"original"}), json!({"kind":"preserve"})),
        (
            json!({"kind":"fit_within","width":1920,"height":1080}),
            json!({"kind":"constant","numerator":30000,"denominator":1001}),
        ),
    ] {
        let value = encode_with(rate.clone(), resize, frame_rate);
        let options: VideoConvertOptions = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&options).unwrap(), value);
        assert!(validate_video_options(&options).is_ok());
    }

    for (resize, frame_rate) in [
        (
            json!({"kind":"original","width":1920}),
            json!({"kind":"preserve"}),
        ),
        (
            json!({"kind":"original"}),
            json!({"kind":"preserve","extra":true}),
        ),
        (
            json!({"kind":"fit_within","width":1920,"height":1080,"extra":true}),
            json!({"kind":"preserve"}),
        ),
        (
            json!({"kind":"original"}),
            json!({"kind":"constant","numerator":30,"denominator":1,"extra":true}),
        ),
    ] {
        assert!(serde_json::from_value::<VideoConvertOptions>(encode_with(
            rate.clone(),
            resize,
            frame_rate
        ))
        .is_err());
    }
    assert!(
        serde_json::from_value::<VideoRationalFact>(json!({"kind":"malformed","extra":true}))
            .is_err()
    );
}

#[test]
fn resize_and_frame_rate_validation_enforces_supported_bounds() {
    let rate = json!({"kind":"constant_quality","crf":23});
    for dimension in [2, 32768] {
        let options: VideoConvertOptions = serde_json::from_value(encode_with(
            rate.clone(),
            json!({"kind":"fit_within","width":dimension,"height":dimension}),
            json!({"kind":"constant","numerator":24000,"denominator":1001}),
        ))
        .unwrap();
        assert!(validate_video_options(&options).is_ok());
    }
    for dimension in [0, 1, 32769] {
        let options: VideoConvertOptions = serde_json::from_value(encode_with(
            rate.clone(),
            json!({"kind":"fit_within","width":dimension,"height":100}),
            json!({"kind":"preserve"}),
        ))
        .unwrap();
        assert!(validate_video_options(&options).is_err());
    }
    for frame_rate in [
        json!({"kind":"constant","numerator":0,"denominator":1}),
        json!({"kind":"constant","numerator":30,"denominator":0}),
        json!({"kind":"constant","numerator":60000,"denominator":2002}),
        json!({"kind":"constant","numerator":120,"denominator":1}),
    ] {
        let options: VideoConvertOptions = serde_json::from_value(encode_with(
            rate.clone(),
            json!({"kind":"original"}),
            frame_rate,
        ))
        .unwrap();
        assert!(validate_video_options(&options).is_err());
    }
    for malformed in [
        json!({"kind":"fit_within","width":1.5,"height":100}),
        json!({"kind":"fit_within","width":-1,"height":100}),
        json!({"kind":"fit_within","width":"1920","height":1080}),
    ] {
        assert!(serde_json::from_value::<VideoConvertOptions>(encode_with(
            rate.clone(),
            malformed,
            json!({"kind":"preserve"})
        ))
        .is_err());
    }
}

#[test]
fn resize_conflicts_with_legacy_cap_but_frame_rate_alone_does_not() {
    let mut req = request(encode(json!({"kind":"constant_quality","crf":23})));
    req.resolution_cap = Some(ResolutionCap::R720p);
    let VideoConvertOptions::Encode {
        codec,
        rate_control,
        speed,
        processor,
        ..
    } = req.video_options.clone().unwrap()
    else {
        unreachable!()
    };
    req.video_options = Some(VideoConvertOptions::Encode {
        codec,
        rate_control: rate_control.clone(),
        speed,
        processor,
        resize: None,
        frame_rate: Some(VideoFrameRate::Preserve),
    });
    assert!(validate_video_request(&req).is_ok());

    for resize in [
        VideoResize::Original,
        VideoResize::FitWithin {
            width: 1280,
            height: 720,
        },
    ] {
        req.video_options = Some(VideoConvertOptions::Encode {
            codec,
            rate_control: rate_control.clone(),
            speed,
            processor,
            resize: Some(resize),
            frame_rate: None,
        });
        assert!(validate_video_request(&req).is_err());
    }
}
#[test]
fn request_validation_checks_target_conflicts_and_copy_transforms() {
    let options = encode(json!({"kind":"constant_quality","crf":23}));
    for target in [TargetFormat::Mp4, TargetFormat::Mov, TargetFormat::Mkv] {
        let mut req = request(options.clone());
        req.target = target;
        assert!(validate_video_request(&req).is_ok());
    }
    let mut req = request(options.clone());
    req.target = TargetFormat::Webm;
    assert!(validate_video_request(&req).is_err());
    for (field, value) in [
        ("quality_preset", json!("original")),
        ("compress_mode", json!({"kind":"quality","value":80})),
        (
            "image_options",
            json!({"jpeg_quality":80,"resize":{"kind":"original"}}),
        ),
        (
            "gif_options",
            json!({"size_preset":"small","trim_start_ms":null,"trim_end_ms":null}),
        ),
        ("subtitle", json!({"source_path":"sub.srt","mode":"soft"})),
    ] {
        let mut value_req = serde_json::to_value(request(options.clone())).unwrap();
        value_req[field] = value;
        let req = serde_json::from_value(value_req).unwrap();
        assert!(validate_video_request(&req).is_err(), "{field}");
    }
    for cap in [
        None,
        Some(ResolutionCap::Original),
        Some(ResolutionCap::R1080p),
        Some(ResolutionCap::R720p),
        Some(ResolutionCap::R480p),
    ] {
        let mut req = request(json!({"kind":"copy"}));
        req.resolution_cap = cap;
        assert_eq!(
            validate_video_request(&req).is_ok(),
            matches!(cap, None | Some(ResolutionCap::Original))
        );
        req.video_options = Some(serde_json::from_value(options.clone()).unwrap());
        assert!(validate_video_request(&req).is_ok());
    }
    let mut legacy = request(Value::Null);
    legacy.target = TargetFormat::Webm;
    legacy.quality_preset = Some(QualityPreset::Balanced);
    assert!(validate_video_request(&legacy).is_ok());
}
#[test]
fn legacy_absent_and_null_contracts_load() {
    let payloads = [
        (
            "request",
            json!({"input_path":"in","output_path":"out","target":"mp4"}),
            "video_options",
        ),
        (
            "preset",
            json!({"id":"old","name":"Old","target":"mp4","is_builtin":false,"created_at":0}),
            "video_options",
        ),
        (
            "preview",
            json!({"request_id":"old","input_path":"in","source_revision":"1","target":"mp4"}),
            "video_options",
        ),
        (
            "probe",
            json!({"duration_ms":1,"file_size":1,"has_video":true,"has_audio":false,"source_kind":"video"}),
            "video_details",
        ),
        (
            "convert",
            json!({"output_path":"out","bytes":1,"duration_ms":1,"reencoded":false}),
            "video_execution",
        ),
        ("job", json!({"duration_ms":1}), "video_execution"),
        (
            "capability",
            json!({"target":"mp4","available":true,"preserves_metadata":false}),
            "video_settings",
        ),
    ];
    for (kind, payload, field) in payloads {
        for null in [false, true] {
            let mut value = payload.clone();
            if null {
                value[field] = Value::Null;
            }
            match kind {
                "request" => assert!(serde_json::from_value::<ConvertRequest>(value)
                    .unwrap()
                    .video_options
                    .is_none()),
                "preset" => assert!(serde_json::from_value::<Preset>(value)
                    .unwrap()
                    .video_options
                    .is_none()),
                "preview" => assert!(serde_json::from_value::<PreviewRequest>(value)
                    .unwrap()
                    .video_options
                    .is_none()),
                "probe" => assert!(serde_json::from_value::<ProbeResult>(value)
                    .unwrap()
                    .video_details
                    .is_none()),
                "convert" => assert!(serde_json::from_value::<ConvertResult>(value)
                    .unwrap()
                    .video_execution
                    .is_none()),
                "job" => assert!(serde_json::from_value::<JobResult>(value)
                    .unwrap()
                    .video_execution
                    .is_none()),
                _ => assert!(serde_json::from_value::<TargetCapability>(value)
                    .unwrap()
                    .video_settings
                    .is_none()),
            }
        }
    }
}

#[test]
fn probe_and_execution_contracts_preserve_stream_facts_and_requested_settings() {
    let details = json!({"streams":[{"index":2,"codec_type":"video","codec_name":"hevc","pixel_format":"yuv420p10le","color_transfer":"smpte2084","color_primaries":"bt2020","color_space":"bt2020nc","color_range":"tv","field_order":"progressive","sample_aspect_ratio":"1:1","rotation_degrees":90,"rotation_ambiguous":false,"attached_pic":false}]});
    let parsed: VideoProbeDetails = serde_json::from_value(details.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), details);
    let mut invalid = details.clone();
    invalid["streams"][0]["rotation_degrees"] = json!(90.5);
    assert!(serde_json::from_value::<VideoProbeDetails>(invalid).is_err());
    let mut invalid = details;
    invalid["streams"][0]["extra"] = json!(true);
    assert!(serde_json::from_value::<VideoProbeDetails>(invalid).is_err());
    for requested in [
        json!({"kind":"copy"}),
        encode(json!({"kind":"average_bitrate","kbps":5000})),
    ] {
        let summary = json!({"requested":requested,"encoder":if requested["kind"]=="copy" {Value::Null} else {json!("libx264")},"video_codec":"h264","video_stream_index":2,"audio_stream_index":3,"audio_codec":"aac","audio_copied":true,"width":1920,"height":1080,"notices":[]});
        let parsed: VideoExecutionSummary = serde_json::from_value(summary.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), summary);
    }
}

#[test]
fn capability_wire_contract_rejects_unknown_nested_settings() {
    let capability = json!({"copy":{"available":true,"reason":null},"encode":{"available":true,"reason":null},"codecs":[{"codec":"h264","encoder":"libx264","available":true,"reason":null,"recommended_crf":23}],"crf_min":1,"crf_max":51,"default_crf":23,"bitrate_min_kbps":100,"bitrate_max_kbps":200000,"default_bitrate_kbps":5000,"speeds":["fast","medium","slow"],"default_speed":"medium","processor":"software","preview_available":false,"preview_unavailable_reason":"Explicit video previews are unavailable"});
    let parsed: VideoSettingsCapabilities = serde_json::from_value(capability.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), capability);
    for path in ["copy", "encode"] {
        let mut invalid = capability.clone();
        invalid[path]["extra"] = json!(true);
        assert!(serde_json::from_value::<VideoSettingsCapabilities>(invalid).is_err());
    }
    let mut invalid = capability;
    invalid["codecs"][0]["extra"] = json!(true);
    assert!(serde_json::from_value::<VideoSettingsCapabilities>(invalid).is_err());
}

#[test]
fn generated_tagged_unions_match_the_json_wire_contract() {
    use ts_rs::TS;
    let options = VideoConvertOptions::decl();
    assert!(options.contains("\"kind\": \"copy\""), "{options}");
    assert!(options.contains("\"kind\": \"encode\""), "{options}");
    let rate = VideoRateControl::decl();
    assert!(rate.contains("\"kind\": \"constant_quality\""), "{rate}");
    assert!(rate.contains("\"kind\": \"average_bitrate\""), "{rate}");
}
