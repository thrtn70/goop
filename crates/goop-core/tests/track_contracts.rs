use goop_core::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn text(value: &str) -> Value {
    json!({"kind": "value", "value": value})
}

fn stream(index: u32, codec_type: &str, title: &str) -> Value {
    let codec_name = match codec_type {
        "audio" => "aac",
        "subtitle" => "mov_text",
        _ => "h264",
    };
    json!({
        "index": index,
        "codec_type": codec_type,
        "codec_name": text(codec_name),
        "container_stream_id": {"kind": "missing"},
        "language": text("eng"),
        "title": text(title),
        "disposition": {
            "default": index == 1,
            "forced": false,
            "attached_pic": false,
            "other": {},
            "malformed": false
        }
    })
}

fn inventory(streams: Vec<Value>) -> Value {
    json!({"version": 1, "streams": streams})
}

fn binding(streams: Vec<Value>) -> Value {
    json!({
        "version": 1,
        "canonical_path": "/tmp/input.mkv",
        "size_bytes": "42",
        "modified_unix_ns": "1700000000000000000",
        "inventory": inventory(streams)
    })
}

fn track_options(stream_index: u32) -> Value {
    json!({
        "kind": "audio",
        "source": binding(vec![stream(0, "video", "Picture"), stream(1, "audio", "Main")]),
        "stream_index": stream_index
    })
}

fn video_track_options(audio: Value, subtitles: Value) -> Value {
    json!({
        "kind": "video",
        "source": binding(vec![
            stream(0, "video", "Picture"),
            stream(1, "audio", "Main"),
            stream(2, "audio", "Commentary"),
            stream(3, "subtitle", "English")
        ]),
        "audio": audio,
        "subtitles": subtitles
    })
}

fn request(target: &str, audio_options: Value, tracks: Value) -> ConvertRequest {
    serde_json::from_value(json!({
        "input_path": "/tmp/input.mkv",
        "output_path": "/tmp/output",
        "target": target,
        "audio_options": audio_options,
        "track_options": tracks
    }))
    .unwrap()
}

#[test]
fn strict_track_wire_forms_round_trip() {
    for value in [
        json!({"kind": "missing"}),
        text("eng"),
        json!({"kind": "malformed"}),
    ] {
        let parsed: TrackTextFact = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }

    let source_value = binding(vec![
        stream(0, "video", "Picture"),
        stream(1, "audio", "Main"),
    ]);
    let source: TrackSourceBinding = serde_json::from_value(source_value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&source).unwrap(), source_value);

    let options_value = track_options(1);
    let options: TrackConvertOptions = serde_json::from_value(options_value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&options).unwrap(), options_value);

    let policy_value = json!({
        "kind": "audio",
        "selection": {"kind": "choose_per_file"}
    });
    let policy: TrackPresetPolicy = serde_json::from_value(policy_value.clone()).unwrap();
    assert_eq!(serde_json::to_value(policy).unwrap(), policy_value);

    let summary_value = json!({
        "requested": options_value,
        "selected": stream(1, "audio", "Main"),
        "dropped_audio": [stream(2, "audio", "Commentary")],
        "dropped_other": [stream(0, "video", "Picture")],
        "output_stream_index": 0,
        "notices": ["Omitted one additional audio stream."]
    });
    let summary: TrackExecutionSummary = serde_json::from_value(summary_value.clone()).unwrap();
    assert_eq!(serde_json::to_value(summary).unwrap(), summary_value);

    let choice = TrackChoiceCapability {
        track: serde_json::from_value(stream(1, "audio", "Main")).unwrap(),
        copy: AudioModeAvailability {
            available: true,
            reason: None,
        },
        encode: AudioModeAvailability {
            available: false,
            reason: Some("Encoder unavailable".into()),
        },
    };
    let capabilities = TrackSettingsCapabilities {
        source,
        audio_choices: vec![choice],
    };
    assert_eq!(
        serde_json::from_value::<TrackSettingsCapabilities>(
            serde_json::to_value(&capabilities).unwrap()
        )
        .unwrap(),
        capabilities
    );
}

#[test]
fn strict_track_types_reject_unknown_keys_and_variants() {
    for value in [
        json!({"kind": "missing", "value": "surprise"}),
        json!({"kind": "value", "value": "eng", "extra": true}),
        json!({"kind": "unknown"}),
    ] {
        assert!(serde_json::from_value::<TrackTextFact>(value).is_err());
    }

    let mut identity = stream(1, "audio", "Main");
    identity["extra"] = json!(true);
    assert!(serde_json::from_value::<TrackIdentity>(identity).is_err());

    let mut dispositions = stream(1, "audio", "Main");
    dispositions["disposition"]["extra"] = json!(true);
    assert!(serde_json::from_value::<TrackIdentity>(dispositions).is_err());

    let oversized_disposition_name = format!("x{}", "y".repeat(512));
    assert!(serde_json::from_value::<TrackDispositionFacts>(json!({
        "default": null,
        "forced": null,
        "attached_pic": null,
        "other": {oversized_disposition_name: true},
        "malformed": false
    }))
    .is_err());

    let mut source = binding(vec![stream(1, "audio", "Main")]);
    source["extra"] = json!(true);
    assert!(serde_json::from_value::<TrackSourceBinding>(source).is_err());

    let mut options = track_options(1);
    options["extra"] = json!(true);
    assert!(serde_json::from_value::<TrackConvertOptions>(options).is_err());
    assert!(serde_json::from_value::<TrackPresetPolicy>(json!({
        "kind": "video",
        "selection": {"kind": "choose_per_file"}
    }))
    .is_err());

    let mut capability = json!({
        "source": binding(vec![stream(1, "audio", "Main")]),
        "audio_choices": []
    });
    capability["extra"] = json!(true);
    assert!(serde_json::from_value::<TrackSettingsCapabilities>(capability).is_err());
}

#[test]
fn versions_decimal_facts_and_inventory_identity_are_validated() {
    for version_path in ["inventory", "binding"] {
        let mut value = binding(vec![stream(1, "audio", "Main")]);
        if version_path == "inventory" {
            value["inventory"]["version"] = json!(2);
        } else {
            value["version"] = json!(2);
        }
        assert!(serde_json::from_value::<TrackSourceBinding>(value).is_err());
    }

    for decimal in [
        "",
        "00",
        "01",
        "+1",
        "-1",
        " 1",
        "1 ",
        "١",
        "18446744073709551616",
    ] {
        for field in ["size_bytes", "modified_unix_ns"] {
            let mut value = binding(vec![stream(1, "audio", "Main")]);
            value[field] = json!(decimal);
            assert!(
                serde_json::from_value::<TrackSourceBinding>(value).is_err(),
                "accepted {field}={decimal:?}"
            );
        }
    }

    let duplicate = binding(vec![stream(1, "audio", "Main"), stream(1, "audio", "Alt")]);
    assert!(serde_json::from_value::<TrackSourceBinding>(duplicate).is_err());
    let noncanonical_order = binding(vec![
        stream(2, "audio", "Second"),
        stream(1, "audio", "First"),
    ]);
    assert!(serde_json::from_value::<TrackSourceBinding>(noncanonical_order).is_err());
    assert!(serde_json::from_value::<TrackConvertOptions>(track_options(0)).is_err());

    let mut missing = track_options(1);
    missing["stream_index"] = json!(99);
    assert!(serde_json::from_value::<TrackConvertOptions>(missing).is_err());
}

#[test]
fn track_identity_limits_are_enforced_without_truncation() {
    let too_many = (0..129)
        .map(|index| stream(index, "audio", "Track"))
        .collect();
    assert!(serde_json::from_value::<TrackSourceBinding>(binding(too_many)).is_err());

    let mut oversized_label = stream(1, "audio", "Main");
    oversized_label["title"] = text(&"é".repeat(257));
    assert!(serde_json::from_value::<TrackIdentity>(oversized_label).is_err());

    let mut oversized_binding = binding(vec![stream(1, "audio", "Main")]);
    oversized_binding["canonical_path"] = json!(format!("/tmp/{}", "x".repeat(66_000)));
    assert!(serde_json::from_value::<TrackSourceBinding>(oversized_binding).is_err());

    let exactly_bounded = TrackTextFact::Value {
        value: "é".repeat(256),
    };
    assert!(validate_track_text_fact(&exactly_bounded).is_ok());
    let too_large = TrackTextFact::Value {
        value: "é".repeat(257),
    };
    assert!(validate_track_text_fact(&too_large).is_err());
}

#[test]
fn track_selection_requires_supported_audio_target_and_explicit_processing() {
    for target in ["mp3", "m4a", "aac", "wav", "flac"] {
        for processing in [
            json!({"kind": "copy"}),
            json!({
                "kind": "encode",
                "bitrate": if matches!(target, "wav" | "flac") { Value::Null } else { json!({"kind": "target", "kbps": 192}) },
                "channels": {"kind": "preserve"},
                "sample_rate": {"kind": "preserve"}
            }),
        ] {
            let request = request(target, processing, track_options(1));
            assert!(validate_track_request(&request).is_ok(), "{target}");
        }
    }

    let automatic: ConvertRequest = serde_json::from_value(json!({
        "input_path": "/tmp/input.mkv",
        "output_path": "/tmp/out.mp3",
        "target": "mp3",
        "track_options": track_options(1)
    }))
    .unwrap();
    assert!(validate_track_request(&automatic).is_err());

    let video = request("mp4", json!({"kind": "copy"}), track_options(1));
    assert!(validate_track_request(&video).is_err());

    let mut conflicting = request("mp3", json!({"kind": "copy"}), track_options(1));
    conflicting.quality_preset = Some(QualityPreset::Balanced);
    assert!(validate_track_request(&conflicting).is_err());
}

#[test]
fn absent_and_null_track_fields_preserve_legacy_contracts() {
    for mut payload in [
        json!({"input_path":"in","output_path":"out","target":"mp3"}),
        json!({"input_path":"in","output_path":"out","target":"mp3","track_options":null}),
    ] {
        let request: ConvertRequest = serde_json::from_value(payload.take()).unwrap();
        assert_eq!(request.track_options, None);
    }

    for payload in [
        json!({"duration_ms":1,"file_size":1,"has_video":false,"has_audio":true,"source_kind":"audio"}),
        json!({"duration_ms":1,"file_size":1,"has_video":false,"has_audio":true,"source_kind":"audio","track_inventory":null}),
    ] {
        let probe: ProbeResult = serde_json::from_value(payload).unwrap();
        assert_eq!(probe.track_inventory, None);
    }

    for payload in [
        json!({"probe":{"duration_ms":1,"file_size":1,"has_video":false,"has_audio":true,"source_kind":"audio"},"capabilities":{"targets":[],"compression":{"quality":false,"target_size":false,"lossless":false,"reason":null}}}),
        json!({"probe":{"duration_ms":1,"file_size":1,"has_video":false,"has_audio":true,"source_kind":"audio"},"capabilities":{"targets":[],"compression":{"quality":false,"target_size":false,"lossless":false,"reason":null}},"track_source":null}),
    ] {
        let inspection: ConversionInspection = serde_json::from_value(payload).unwrap();
        assert_eq!(inspection.track_source, None);
        assert_eq!(inspection.track_source_unavailable_reason, None);
    }

    let unavailable: ConversionInspection = serde_json::from_value(json!({
        "probe":{"duration_ms":1,"file_size":1,"has_video":false,"has_audio":true,"source_kind":"audio"},
        "capabilities":{"targets":[],"compression":{"quality":false,"target_size":false,"lossless":false,"reason":null}},
        "track_source_unavailable_reason":"Complete stream identity is unavailable"
    }))
    .unwrap();
    assert_eq!(
        unavailable.track_source_unavailable_reason.as_deref(),
        Some("Complete stream identity is unavailable")
    );

    for payload in [
        json!({"id":"old","name":"Old","target":"mp3","quality_preset":null,"resolution_cap":null,"compress_mode":null,"is_builtin":false,"created_at":0}),
        json!({"id":"old","name":"Old","target":"mp3","quality_preset":null,"resolution_cap":null,"compress_mode":null,"is_builtin":false,"created_at":0,"track_policy":null}),
    ] {
        let preset: Preset = serde_json::from_value(payload).unwrap();
        assert_eq!(preset.track_policy, None);
    }

    for payload in [
        json!({"output_path":"out","bytes":1,"duration_ms":1,"reencoded":false}),
        json!({"output_path":"out","bytes":1,"duration_ms":1,"reencoded":false,"video_track_execution":null}),
    ] {
        let result: ConvertResult = serde_json::from_value(payload).unwrap();
        assert_eq!(result.track_execution, None);
        assert_eq!(result.video_track_execution, None);
        assert_eq!(
            serde_json::to_value(&result).unwrap()["video_track_execution"],
            Value::Null
        );
    }

    for payload in [
        json!({"output_path":"out","bytes":1,"duration_ms":1}),
        json!({"output_path":"out","bytes":1,"duration_ms":1,"video_track_execution":null}),
    ] {
        let result: JobResult = serde_json::from_value(payload).unwrap();
        assert_eq!(result.video_track_execution, None);
        assert_eq!(
            serde_json::to_value(&result).unwrap()["video_track_execution"],
            Value::Null
        );
    }

    for payload in [
        json!({"target":"mp3","available":true,"reason":null,"preserves_metadata":false,"metadata_warning":null}),
        json!({"target":"mp3","available":true,"reason":null,"preserves_metadata":false,"metadata_warning":null,"video_track_settings":null}),
    ] {
        let capability: TargetCapability = serde_json::from_value(payload).unwrap();
        assert_eq!(capability.track_settings, None);
        assert_eq!(capability.video_track_settings, None);
        assert_eq!(
            serde_json::to_value(&capability).unwrap()["video_track_settings"],
            Value::Null
        );
    }
}

#[test]
fn audio_processing_and_track_selection_remain_distinct_fields() {
    let request = request(
        "mp3",
        json!({
            "kind": "encode",
            "bitrate": {"kind": "target", "kbps": 192},
            "channels": {"kind": "stereo"},
            "sample_rate": {"kind": "exact", "hz": 48000}
        }),
        track_options(1),
    );
    assert!(matches!(
        request.audio_options,
        Some(AudioConvertOptions::Encode { .. })
    ));
    assert!(matches!(
        request.track_options,
        Some(TrackConvertOptions::Audio {
            stream_index: 1,
            ..
        })
    ));

    let mut other = BTreeMap::new();
    other.insert("hearing_impaired".to_string(), true);
    let disposition = TrackDispositionFacts {
        default: None,
        forced: Some(false),
        attached_pic: Some(false),
        other,
        malformed: false,
    };
    assert!(validate_track_disposition(&disposition).is_ok());
}

#[test]
fn generated_track_unions_match_the_wire_contract() {
    use ts_rs::TS;
    assert!(TrackTextFact::decl().contains("\"kind\": \"value\""));
    assert!(TrackConvertOptions::decl().contains("\"kind\": \"audio\""));
    assert!(TrackConvertOptions::decl().contains("\"kind\": \"video\""));
    assert!(TrackPresetPolicy::decl().contains("\"kind\": \"audio\""));
    assert!(TrackPresetPolicy::decl().contains("\"kind\": \"video\""));
    assert!(TrackPresetSelection::decl().contains("\"kind\": \"choose_per_file\""));
    assert!(TrackStreamPolicy::decl().contains("\"kind\": \"keep_all\""));
    assert!(TrackStreamPolicy::decl().contains("\"kind\": \"choose\""));
    assert!(TrackStreamPolicy::decl().contains("\"kind\": \"none\""));
    assert!(TrackPresetStreamPolicy::decl().contains("\"kind\": \"choose_per_file\""));
}

#[test]
fn video_track_policies_roundtrip_with_strict_wire_shapes() {
    let policies = [
        json!({"kind": "keep_all"}),
        json!({"kind": "choose", "stream_indices": [1, 2]}),
        json!({"kind": "none"}),
    ];
    for value in policies {
        let parsed: TrackStreamPolicy = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }

    let options_value = video_track_options(
        json!({"kind": "choose", "stream_indices": [1, 2]}),
        json!({"kind": "choose", "stream_indices": [3]}),
    );
    let options: TrackConvertOptions = serde_json::from_value(options_value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&options).unwrap(), options_value);
    assert!(validate_track_options(&options).is_ok());

    for value in [
        json!({"kind": "keep_all"}),
        json!({"kind": "choose_per_file"}),
        json!({"kind": "none"}),
    ] {
        let parsed: TrackPresetStreamPolicy = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }

    let preset_value = json!({
        "kind": "video",
        "audio": {"kind": "keep_all"},
        "subtitles": {"kind": "choose_per_file"}
    });
    let preset: TrackPresetPolicy = serde_json::from_value(preset_value.clone()).unwrap();
    assert_eq!(serde_json::to_value(preset).unwrap(), preset_value);
}

#[test]
fn video_choose_rejects_empty_duplicate_unordered_missing_and_wrong_family_indices() {
    for audio in [
        json!({"kind": "choose", "stream_indices": []}),
        json!({"kind": "choose", "stream_indices": [1, 1]}),
        json!({"kind": "choose", "stream_indices": [2, 1]}),
        json!({"kind": "choose", "stream_indices": [99]}),
        json!({"kind": "choose", "stream_indices": [3]}),
    ] {
        assert!(
            serde_json::from_value::<TrackConvertOptions>(video_track_options(
                audio,
                json!({"kind": "none"})
            ))
            .is_err()
        );
    }
    assert!(
        serde_json::from_value::<TrackConvertOptions>(video_track_options(
            json!({"kind": "none"}),
            json!({"kind": "choose", "stream_indices": [1]})
        ))
        .is_err()
    );
}

#[test]
fn video_track_policy_requires_explicit_supported_video_processing() {
    let options = video_track_options(json!({"kind": "keep_all"}), json!({"kind": "none"}));
    for target in ["mp4", "mov", "mkv"] {
        let request: ConvertRequest = serde_json::from_value(json!({
            "input_path": "/tmp/input.mkv",
            "output_path": "/tmp/output",
            "target": target,
            "video_options": {"kind": "copy"},
            "track_options": options
        }))
        .unwrap();
        assert!(validate_track_request(&request).is_ok(), "{target}");
    }

    for target in ["webm", "avi", "mp3"] {
        let request: ConvertRequest = serde_json::from_value(json!({
            "input_path": "/tmp/input.mkv",
            "output_path": "/tmp/output",
            "target": target,
            "video_options": {"kind": "copy"},
            "track_options": options
        }))
        .unwrap();
        assert!(validate_track_request(&request).is_err(), "{target}");
    }

    for conflict in [
        json!({}),
        json!({"audio_options": {"kind": "copy"}}),
        json!({"subtitle": {"source_path": "sub.srt", "mode": "soft"}}),
    ] {
        let mut payload = json!({
            "input_path": "/tmp/input.mkv",
            "output_path": "/tmp/output.mp4",
            "target": "mp4",
            "track_options": options
        });
        for (key, value) in conflict.as_object().unwrap() {
            payload[key] = value.clone();
        }
        if conflict.as_object().unwrap().is_empty() {
            assert!(payload.get("video_options").is_none());
        } else {
            payload["video_options"] = json!({"kind": "copy"});
        }
        let request: ConvertRequest = serde_json::from_value(payload).unwrap();
        assert!(validate_track_request(&request).is_err());
    }

    let audio_only = json!({
        "kind": "video",
        "source": binding(vec![stream(0, "audio", "Main")]),
        "audio": {"kind": "keep_all"},
        "subtitles": {"kind": "none"}
    });
    assert!(serde_json::from_value::<TrackConvertOptions>(audio_only).is_err());
}

#[test]
fn video_track_types_reject_unknown_fields_without_changing_audio_wire_shape() {
    for invalid in [
        json!({"kind": "keep_all", "extra": true}),
        json!({"kind": "choose", "stream_indices": [1], "extra": true}),
        json!({"kind": "none", "stream_indices": []}),
    ] {
        assert!(serde_json::from_value::<TrackStreamPolicy>(invalid).is_err());
    }
    assert!(serde_json::from_value::<TrackPresetStreamPolicy>(json!({
        "kind": "choose_per_file",
        "stream_indices": [1]
    }))
    .is_err());

    let legacy = track_options(1);
    let parsed: TrackConvertOptions = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), legacy);

    for invalid in [
        TrackStreamPolicy::Choose {
            stream_indices: vec![],
        },
        TrackStreamPolicy::Choose {
            stream_indices: vec![2, 1],
        },
    ] {
        assert!(serde_json::to_value(invalid).is_err());
    }

    let source: TrackSourceBinding = serde_json::from_value(binding(vec![
        stream(0, "video", "Picture"),
        stream(1, "audio", "Main"),
    ]))
    .unwrap();
    assert!(serde_json::to_value(TrackConvertOptions::Video {
        source,
        audio: TrackStreamPolicy::Choose {
            stream_indices: vec![99],
        },
        subtitles: TrackStreamPolicy::None,
    })
    .is_err());
}

#[test]
fn video_track_contract_refuses_incomplete_or_out_of_scope_inventory() {
    let make_options = |streams: Vec<Value>| {
        json!({
            "kind": "video",
            "source": binding(streams),
            "audio": {"kind": "keep_all"},
            "subtitles": {"kind": "keep_all"}
        })
    };

    let mut malformed_text = stream(1, "audio", "Main");
    malformed_text["language"] = json!({"kind": "malformed"});
    let mut active_disposition = stream(1, "audio", "Main");
    active_disposition["disposition"]["other"]["hearing_impaired"] = json!(true);
    let mut attached_picture = stream(2, "video", "Artwork");
    attached_picture["disposition"]["attached_pic"] = json!(true);

    for streams in [
        vec![stream(0, "video", "Picture"), malformed_text],
        vec![stream(0, "video", "Picture"), active_disposition],
        vec![stream(0, "video", "Picture"), attached_picture],
        vec![
            stream(0, "video", "Picture"),
            stream(1, "video", "Alternate"),
        ],
        vec![
            stream(0, "video", "Picture"),
            stream(1, "data", "Timed data"),
        ],
    ] {
        assert!(serde_json::from_value::<TrackConvertOptions>(make_options(streams)).is_err());
    }
}

#[test]
fn video_track_summary_and_capability_contracts_roundtrip_strictly() {
    let source: TrackSourceBinding = serde_json::from_value(binding(vec![
        stream(0, "video", "Picture"),
        stream(1, "audio", "Main"),
        stream(2, "subtitle", "English"),
    ]))
    .unwrap();
    let availability = TrackModeAvailability {
        available: true,
        reason: None,
    };
    let capability = VideoTrackSettingsCapabilities {
        source: source.clone(),
        audio_tracks: vec![VideoTrackChoiceCapability {
            track: serde_json::from_value(stream(1, "audio", "Main")).unwrap(),
            copy: availability.clone(),
            custom: availability.clone(),
        }],
        subtitle_tracks: vec![VideoTrackChoiceCapability {
            track: serde_json::from_value(stream(2, "subtitle", "English")).unwrap(),
            copy: availability.clone(),
            custom: availability.clone(),
        }],
        audio_policy: VideoTrackPolicyCapabilities {
            copy: VideoTrackPolicyModeCapabilities {
                keep_all: availability.clone(),
                choose: availability.clone(),
                none: availability.clone(),
            },
            custom: VideoTrackPolicyModeCapabilities {
                keep_all: availability.clone(),
                choose: availability.clone(),
                none: availability.clone(),
            },
        },
        subtitle_policy: VideoTrackPolicyCapabilities {
            copy: VideoTrackPolicyModeCapabilities {
                keep_all: availability.clone(),
                choose: availability.clone(),
                none: availability.clone(),
            },
            custom: VideoTrackPolicyModeCapabilities {
                keep_all: availability.clone(),
                choose: availability.clone(),
                none: availability,
            },
        },
    };
    let capability_value = serde_json::to_value(&capability).unwrap();
    assert_eq!(
        serde_json::from_value::<VideoTrackSettingsCapabilities>(capability_value.clone()).unwrap(),
        capability
    );
    let mut invalid_capability = capability_value;
    invalid_capability["extra"] = json!(true);
    assert!(serde_json::from_value::<VideoTrackSettingsCapabilities>(invalid_capability).is_err());

    let capability_value = serde_json::to_value(&capability).unwrap();
    let mut wrong_family = capability_value.clone();
    wrong_family["audio_tracks"][0]["track"] = stream(2, "subtitle", "English");
    assert!(serde_json::from_value::<VideoTrackSettingsCapabilities>(wrong_family).is_err());
    let mut fabricated = capability_value.clone();
    fabricated["audio_tracks"][0]["track"]["index"] = json!(9);
    assert!(serde_json::from_value::<VideoTrackSettingsCapabilities>(fabricated).is_err());
    let mut missing_choice = capability_value;
    missing_choice["subtitle_tracks"] = json!([]);
    assert!(serde_json::from_value::<VideoTrackSettingsCapabilities>(missing_choice).is_err());
    let mut invalid_capability = capability.clone();
    invalid_capability.audio_tracks.clear();
    assert!(serde_json::to_value(invalid_capability).is_err());
    let mut invalid_source_capability = capability.clone();
    invalid_source_capability.source.version = 2;
    assert!(serde_json::to_value(invalid_source_capability).is_err());

    let requested: TrackConvertOptions = serde_json::from_value(json!({
        "kind": "video",
        "source": source,
        "audio": {"kind": "choose", "stream_indices": [1]},
        "subtitles": {"kind": "none"}
    }))
    .unwrap();
    let summary = VideoTrackExecutionSummary {
        requested,
        retained: vec![VideoTrackStreamOutcome {
            source: serde_json::from_value(stream(1, "audio", "Main")).unwrap(),
            output_stream_index: 1,
            output_type_index: 0,
            processing: VideoTrackProcessing::Copied,
            source_codec_tag: text_fact("mp4a"),
            output_codec_name: text_fact("aac"),
            output_codec_tag: text_fact("mp4a"),
            output_language: text_fact("eng"),
            output_title: text_fact("Main"),
            output_default: Some(true),
            output_forced: Some(false),
        }],
        omitted_audio: vec![],
        omitted_subtitles: vec![serde_json::from_value(stream(2, "subtitle", "English")).unwrap()],
        notices: vec!["Omitted one subtitle stream by request.".into()],
    };
    let summary_value = serde_json::to_value(&summary).unwrap();
    assert_eq!(
        serde_json::from_value::<VideoTrackExecutionSummary>(summary_value.clone()).unwrap(),
        summary
    );
    let mut wrong_request = summary_value;
    wrong_request["requested"] = track_options(1);
    assert!(serde_json::from_value::<VideoTrackExecutionSummary>(wrong_request).is_err());

    let summary_value = serde_json::to_value(&summary).unwrap();
    let mut fabricated_outcome = summary_value.clone();
    fabricated_outcome["retained"][0]["source"]["index"] = json!(9);
    assert!(serde_json::from_value::<VideoTrackExecutionSummary>(fabricated_outcome).is_err());
    let mut wrong_output_order = summary_value.clone();
    wrong_output_order["retained"][0]["output_stream_index"] = json!(2);
    assert!(serde_json::from_value::<VideoTrackExecutionSummary>(wrong_output_order).is_err());
    let mut inconsistent_omission = summary_value;
    inconsistent_omission["omitted_audio"] = json!([stream(1, "audio", "Main")]);
    assert!(serde_json::from_value::<VideoTrackExecutionSummary>(inconsistent_omission).is_err());
    let mut invalid_summary = summary.clone();
    invalid_summary.retained[0].output_stream_index = 2;
    assert!(serde_json::to_value(invalid_summary).is_err());

    let drop_all_summary = VideoTrackExecutionSummary {
        requested: TrackConvertOptions::Video {
            source: capability.source.clone(),
            audio: TrackStreamPolicy::None,
            subtitles: TrackStreamPolicy::None,
        },
        retained: vec![],
        omitted_audio: vec![serde_json::from_value(stream(1, "audio", "Main")).unwrap()],
        omitted_subtitles: vec![serde_json::from_value(stream(2, "subtitle", "English")).unwrap()],
        notices: vec![],
    };
    let drop_all_value = serde_json::to_value(&drop_all_summary).unwrap();
    assert_eq!(
        serde_json::from_value::<VideoTrackExecutionSummary>(drop_all_value).unwrap(),
        drop_all_summary
    );

    let encoded = json!({"kind": "encoded_aac", "bitrate_kbps": 192});
    let parsed: VideoTrackProcessing = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), encoded);
    assert!(serde_json::from_value::<VideoTrackProcessing>(json!({
        "kind": "encoded_aac",
        "bitrate_kbps": 256
    }))
    .is_err());
    assert!(serde_json::to_value(VideoTrackProcessing::EncodedAac { bitrate_kbps: 256 }).is_err());
}

fn text_fact(value: &str) -> TrackTextFact {
    TrackTextFact::Value {
        value: value.to_owned(),
    }
}
