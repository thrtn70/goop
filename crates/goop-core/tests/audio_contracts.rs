use goop_core::*;
use serde_json::{json, Value};

fn request(target: &str, options: Value) -> ConvertRequest {
    serde_json::from_value(json!({
        "input_path": "in.wav",
        "output_path": "out",
        "target": target,
        "audio_options": options
    }))
    .unwrap()
}

#[test]
fn exact_audio_wire_forms_round_trip_and_reject_unknown_fields() {
    for value in [
        json!({"kind":"copy"}),
        json!({
            "kind":"encode",
            "bitrate":{"kind":"target","kbps":192},
            "channels":{"kind":"preserve"},
            "sample_rate":{"kind":"exact","hz":48000}
        }),
        json!({
            "kind":"encode",
            "bitrate":null,
            "channels":{"kind":"mono"},
            "sample_rate":{"kind":"preserve"}
        }),
    ] {
        let parsed: AudioConvertOptions = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }

    for value in [
        json!({"kind":"copy","channels":{"kind":"preserve"}}),
        json!({
            "kind":"encode",
            "bitrate":{"kind":"target","kbps":192,"extra":true},
            "channels":{"kind":"preserve"},
            "sample_rate":{"kind":"exact","hz":48000}
        }),
        json!({
            "kind":"encode",
            "bitrate":null,
            "channels":{"kind":"mono","extra":true},
            "sample_rate":{"kind":"preserve"}
        }),
    ] {
        assert!(serde_json::from_value::<AudioConvertOptions>(value).is_err());
    }
}

#[test]
fn request_validation_is_target_specific_and_conflict_strict() {
    let mp3_rates = [64, 96, 128, 160, 192, 256, 320];
    for kbps in mp3_rates {
        let req = request(
            "mp3",
            json!({"kind":"encode","bitrate":{"kind":"target","kbps":kbps},"channels":{"kind":"stereo"},"sample_rate":{"kind":"exact","hz":44100}}),
        );
        assert!(validate_audio_request(&req).is_ok(), "{kbps}");
    }
    let aac_320 = request(
        "aac",
        json!({"kind":"encode","bitrate":{"kind":"target","kbps":320},"channels":{"kind":"stereo"},"sample_rate":{"kind":"exact","hz":48000}}),
    );
    assert!(validate_audio_request(&aac_320).is_err());

    let lossy_without_bitrate = request(
        "m4a",
        json!({"kind":"encode","bitrate":null,"channels":{"kind":"preserve"},"sample_rate":{"kind":"exact","hz":48000}}),
    );
    assert!(validate_audio_request(&lossy_without_bitrate).is_err());

    let lossless_with_bitrate = request(
        "flac",
        json!({"kind":"encode","bitrate":{"kind":"target","kbps":192},"channels":{"kind":"preserve"},"sample_rate":{"kind":"exact","hz":48000}}),
    );
    assert!(validate_audio_request(&lossless_with_bitrate).is_err());

    let mut conflicting = request("wav", json!({"kind":"copy"}));
    conflicting.quality_preset = Some(QualityPreset::Balanced);
    assert!(validate_audio_request(&conflicting).is_err());
}

#[test]
fn absent_and_null_audio_contracts_are_backward_compatible() {
    for mut payload in [
        json!({"input_path":"in","output_path":"out","target":"mp3"}),
        json!({"input_path":"in","output_path":"out","target":"mp3","audio_options":null}),
    ] {
        let request: ConvertRequest = serde_json::from_value(payload.take()).unwrap();
        assert_eq!(request.audio_options, None);
    }
    for payload in [
        json!({"duration_ms":1,"file_size":1,"has_video":false,"has_audio":true,"source_kind":"audio"}),
        json!({"duration_ms":1,"file_size":1,"has_video":false,"has_audio":true,"source_kind":"audio","audio_details":null}),
    ] {
        let probe: ProbeResult = serde_json::from_value(payload).unwrap();
        assert_eq!(probe.audio_details, None);
    }
    let result: ConvertResult = serde_json::from_value(json!({
        "output_path":"out","bytes":1,"duration_ms":1,"reencoded":false
    }))
    .unwrap();
    assert_eq!(result.audio_execution, None);
}

#[test]
fn generated_audio_tagged_unions_match_the_wire_contract() {
    use ts_rs::TS;
    assert!(AudioConvertOptions::decl().contains("\"kind\": \"copy\""));
    assert!(AudioConvertOptions::decl().contains("\"kind\": \"encode\""));
    assert!(AudioBitrate::decl().contains("\"kind\": \"target\""));
    assert!(AudioSampleRate::decl().contains("\"kind\": \"exact\""));
}
