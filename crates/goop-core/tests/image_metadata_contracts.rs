use goop_core::{
    CompressMode, CompressionExecution, ConvertRequest, ConvertResult, ImageColorHandling,
    ImageMetadataCapabilities, ImageMetadataExecution, ImageOrientationStatus, JobResult,
    MetadataPolicy, MetadataPolicyAvailability, TargetCapability,
};
use serde_json::{json, Value};

#[test]
fn metadata_policy_wire_values_are_additive_and_strict() {
    for (policy, wire) in [
        (MetadataPolicy::Preserve, "preserve"),
        (MetadataPolicy::RemovePersonal, "remove_personal"),
        (MetadataPolicy::StripAll, "strip_all"),
    ] {
        assert_eq!(serde_json::to_value(policy).unwrap(), json!(wire));
        assert_eq!(
            serde_json::from_value::<MetadataPolicy>(json!(wire)).unwrap(),
            policy
        );
    }
    assert_eq!(MetadataPolicy::default(), MetadataPolicy::Preserve);
    assert!(serde_json::from_value::<MetadataPolicy>(json!("remove_exif")).is_err());
}

#[test]
fn metadata_capabilities_round_trip_strictly() {
    let capability = ImageMetadataCapabilities {
        preserve: MetadataPolicyAvailability {
            available: true,
            reason: None,
            summary: "Supported EXIF and ICC metadata will be retained.".into(),
        },
        rgb_reencode_preserve: MetadataPolicyAvailability {
            available: true,
            reason: None,
            summary: "Supported EXIF and RGB ICC metadata will be retained.".into(),
        },
        remove_personal: MetadataPolicyAvailability {
            available: true,
            reason: None,
            summary: "Personal metadata will be removed; the exact ICC profile will be retained."
                .into(),
        },
        strip_all: MetadataPolicyAvailability {
            available: true,
            reason: None,
            summary: "All source metadata and the ICC profile will be removed.".into(),
        },
        source_has_exif: Some(true),
        source_has_icc: Some(true),
        orientation: ImageOrientationStatus::Valid,
    };
    let value = serde_json::to_value(&capability).unwrap();
    assert_eq!(value["orientation"], json!("valid"));
    assert_eq!(value["rgb_reencode_preserve"]["available"], json!(true));
    assert_eq!(
        serde_json::from_value::<ImageMetadataCapabilities>(value.clone()).unwrap(),
        capability
    );

    let mut unknown = value;
    unknown["invented"] = json!(true);
    assert!(serde_json::from_value::<ImageMetadataCapabilities>(unknown).is_err());
    assert_eq!(
        serde_json::to_value(ImageOrientationStatus::Uninspected).unwrap(),
        json!("uninspected")
    );
    assert!(serde_json::from_value::<ImageOrientationStatus>(json!("unknown")).is_err());
}

#[test]
fn target_capability_defaults_absent_image_metadata_for_legacy_payloads() {
    let capability: TargetCapability = serde_json::from_value(json!({
        "target": "jpeg",
        "available": true,
        "reason": null,
        "preserves_metadata": true,
        "metadata_warning": null
    }))
    .unwrap();
    assert_eq!(capability.image_metadata, None);
}

#[test]
fn image_and_compression_execution_round_trip_strictly() {
    let image = ImageMetadataExecution {
        requested_policy: MetadataPolicy::RemovePersonal,
        exif_retained: false,
        icc_retained: true,
        orientation_normalized: true,
        color_handling: ImageColorHandling::ExactProfileRetained,
        notices: vec!["Personal metadata removed; color profile retained.".into()],
    };
    let compression = CompressionExecution {
        requested_mode: CompressMode::TargetSizeBytes(25_000),
        attempts: 8,
        selected_quality: Some(73),
        target_bytes: Some(25_000),
        final_bytes: 24_912,
        target_met: true,
        metadata_policy: MetadataPolicy::RemovePersonal,
    };

    let image_value = serde_json::to_value(&image).unwrap();
    assert_eq!(
        image_value["color_handling"],
        json!("exact_profile_retained")
    );
    assert_eq!(
        serde_json::from_value::<ImageMetadataExecution>(image_value.clone()).unwrap(),
        image
    );
    let compression_value = serde_json::to_value(&compression).unwrap();
    assert_eq!(
        serde_json::from_value::<CompressionExecution>(compression_value.clone()).unwrap(),
        compression
    );

    let mut unknown_image = image_value;
    unknown_image["invented"] = json!(true);
    assert!(serde_json::from_value::<ImageMetadataExecution>(unknown_image).is_err());
    let mut unknown_compression = compression_value;
    unknown_compression["invented"] = json!(true);
    assert!(serde_json::from_value::<CompressionExecution>(unknown_compression).is_err());
    assert!(serde_json::from_value::<ImageColorHandling>(json!("converted")).is_err());
}

#[test]
fn legacy_requests_and_results_keep_absent_fields() {
    let request: ConvertRequest = serde_json::from_value(json!({
        "input_path": "in.jpg",
        "output_path": "out.jpg",
        "target": "jpeg",
        "quality_preset": null,
        "resolution_cap": null,
        "gif_options": null,
        "compress_mode": null,
        "batch_id": null
    }))
    .unwrap();
    assert_eq!(request.metadata_policy, None);

    let result: ConvertResult = serde_json::from_value(json!({
        "output_path": "out.jpg",
        "bytes": 100,
        "duration_ms": 1,
        "reencoded": true
    }))
    .unwrap();
    assert_eq!(result.image_metadata_execution, None);
    assert_eq!(result.compression_execution, None);

    let serialized = serde_json::to_value(result).unwrap();
    assert_eq!(serialized["image_metadata_execution"], Value::Null);
    assert_eq!(serialized["compression_execution"], Value::Null);

    let job_result: JobResult = serde_json::from_value(json!({
        "output_path": "out.jpg",
        "bytes": 100,
        "duration_ms": 1
    }))
    .unwrap();
    assert_eq!(job_result.image_metadata_execution, None);
    assert_eq!(job_result.compression_execution, None);
}
