use goop_core::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn text(value: &str) -> Value {
    json!({"kind": "value", "value": value})
}

fn stream(index: u32, codec_type: &str, title: &str) -> Value {
    json!({
        "index": index,
        "codec_type": codec_type,
        "codec_name": text(if codec_type == "audio" { "aac" } else { "h264" }),
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
    }

    for payload in [
        json!({"id":"old","name":"Old","target":"mp3","quality_preset":null,"resolution_cap":null,"compress_mode":null,"is_builtin":false,"created_at":0}),
        json!({"id":"old","name":"Old","target":"mp3","quality_preset":null,"resolution_cap":null,"compress_mode":null,"is_builtin":false,"created_at":0,"track_policy":null}),
    ] {
        let preset: Preset = serde_json::from_value(payload).unwrap();
        assert_eq!(preset.track_policy, None);
    }

    let result: ConvertResult = serde_json::from_value(json!({
        "output_path":"out","bytes":1,"duration_ms":1,"reencoded":false
    }))
    .unwrap();
    assert_eq!(result.track_execution, None);

    let capability: TargetCapability = serde_json::from_value(json!({
        "target":"mp3","available":true,"reason":null,"preserves_metadata":false,"metadata_warning":null
    }))
    .unwrap();
    assert_eq!(capability.track_settings, None);
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
    assert!(TrackPresetPolicy::decl().contains("\"kind\": \"audio\""));
    assert!(TrackPresetSelection::decl().contains("\"kind\": \"choose_per_file\""));
}
