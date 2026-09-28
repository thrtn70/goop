use goop_core::{ConvertResult, JobResult, VideoAttempt, VideoEncoder, VideoSelectionContext};
use serde_json::{json, Value};
use ts_rs::TS;

#[test]
fn video_attempt_typescript_shape_matches_tagged_json() {
    assert!(
        VideoAttempt::inline().contains("\"kind\": \"copy\""),
        "{}",
        VideoAttempt::inline()
    );
    assert!(
        VideoSelectionContext::inline().contains("\"kind\": \"explicit_software\""),
        "{}",
        VideoSelectionContext::inline()
    );
    assert!(
        VideoSelectionContext::inline().contains("\"kind\": \"explicit_hardware_required\""),
        "{}",
        VideoSelectionContext::inline()
    );
}

fn encode() -> Value {
    json!({"kind":"encode","encoder":"libx264","encode_attempt_ordinal":2,
        "selection_context":{"kind":"legacy_global_at_execution","hw_acceleration_enabled":true},
        "fallback":{"from_encoder":"h264_videotoolbox","reason":"hardware_attempt_subprocess_failed"}})
}

#[test]
fn video_attempt_valid_receipts_roundtrip() {
    for value in [
        json!({"kind":"copy"}),
        encode(),
        json!({"kind":"encode", "encoder":"libx265",
        "encode_attempt_ordinal":1,"selection_context":{"kind":"explicit_software"}}),
        json!({"kind":"encode", "encoder":"h264_videotoolbox",
        "encode_attempt_ordinal":1,"selection_context":{"kind":"explicit_hardware_required"}}),
    ] {
        let receipt: VideoAttempt = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(receipt).unwrap(), value);
    }
    let receipt: VideoAttempt = serde_json::from_value(encode()).unwrap();
    assert!(matches!(
        receipt,
        VideoAttempt::Encode {
            encoder: VideoEncoder::Libx264,
            encode_attempt_ordinal: 2,
            selection_context: VideoSelectionContext::LegacyGlobalAtExecution {
                hw_acceleration_enabled: true
            },
            ..
        }
    ));
}

#[test]
fn hardware_required_attempt_rejects_substitution_retry_and_fallback() {
    let valid = json!({"kind":"encode","encoder":"h264_videotoolbox","encode_attempt_ordinal":1,
        "selection_context":{"kind":"explicit_hardware_required"}});
    for (field, replacement) in [
        ("encoder", json!("libx264")),
        ("encoder", json!("h264_nvenc")),
        ("encode_attempt_ordinal", json!(2)),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = replacement;
        assert!(serde_json::from_value::<VideoAttempt>(invalid).is_err());
    }
    let mut invalid = valid;
    invalid["fallback"] =
        json!({"from_encoder":"h264_videotoolbox","reason":"hardware_attempt_subprocess_failed"});
    assert!(serde_json::from_value::<VideoAttempt>(invalid).is_err());
}

#[test]
fn video_attempt_rejects_impossible_and_unbounded_records() {
    let mut invalid = vec![
        json!({"kind":"copy","encoder":"libx264"}),
        json!({"kind":"copy","fallback":null}),
    ];
    for ordinal in [0, 1, 3, 255] {
        let mut value = encode();
        value["encode_attempt_ordinal"] = json!(ordinal);
        invalid.push(value);
    }
    let mut value = encode();
    value["selection_context"]["hw_acceleration_enabled"] = json!(false);
    invalid.push(value);
    let mut value = encode();
    value["selection_context"] = json!({"kind":"explicit_software"});
    invalid.push(value);
    let mut value = encode();
    value["fallback"]["from_encoder"] = json!("libx264");
    invalid.push(value);
    let mut value = encode();
    value["encoder"] = json!("h264_nvenc");
    invalid.push(value);
    let mut value = encode();
    value["stderr"] = json!("private source path");
    invalid.push(value);
    let mut value = encode();
    value["fallback"]["reason"] = json!("gpu_fault");
    invalid.push(value);
    let mut value = encode();
    value["encoder"] = json!("unknown");
    invalid.push(value);
    let mut value = encode();
    value.as_object_mut().unwrap().remove("fallback");
    invalid.push(value);
    for value in invalid {
        assert!(
            serde_json::from_value::<VideoAttempt>(value.clone()).is_err(),
            "{value}"
        );
    }
}

#[test]
fn video_attempt_results_accept_missing_null_and_preserve_receipt() {
    let conversion =
        json!({"output_path":"output.mp4","bytes":42,"duration_ms":3,"reencoded":true});
    let job = json!({"output_path":"output.mp4","bytes":42,"duration_ms":3});
    for receipt in [None, Some(Value::Null), Some(encode())] {
        let mut value = conversion.clone();
        if let Some(receipt) = &receipt {
            value["video_attempt"] = receipt.clone();
        }
        let result: ConvertResult = serde_json::from_value(value).unwrap();
        assert_eq!(
            serde_json::to_value(&result.video_attempt).unwrap(),
            receipt.clone().unwrap_or(Value::Null)
        );
        let mut value = job.clone();
        if let Some(receipt) = &receipt {
            value["video_attempt"] = receipt.clone();
        }
        let result: JobResult = serde_json::from_value(value).unwrap();
        assert_eq!(
            serde_json::to_value(&result.video_attempt).unwrap(),
            receipt.unwrap_or(Value::Null)
        );
    }
}
