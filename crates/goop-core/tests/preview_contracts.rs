use goop_core::{
    is_canonical_preview_session_id, new_preview_session_id, ImagePreviewDetails, ImageSampleKind,
    PreviewRequest, PreviewResult,
};

#[test]
fn preview_session_identifiers_are_canonical_uuid_v4() {
    let id = new_preview_session_id();
    assert!(is_canonical_preview_session_id(&id));
    assert!(!is_canonical_preview_session_id(&id.to_uppercase()));
    assert!(!is_canonical_preview_session_id(
        "018f47ef-655f-7f8a-8000-000000000000"
    ));
}

#[test]
fn legacy_preview_contracts_default_new_fields() {
    let request: PreviewRequest = serde_json::from_value(serde_json::json!({
        "request_id": "legacy",
        "input_path": "/tmp/source.jpg",
        "source_revision": "one",
        "target": "jpeg"
    }))
    .unwrap();
    assert!(request.preview_session_id.is_none());
    assert!(request.pinned_jpeg_quality.is_none());

    let result: PreviewResult = serde_json::from_value(serde_json::json!({
        "request_id": "legacy",
        "source_revision": "one",
        "kind": "image",
        "before_path": "/tmp/before.png",
        "after_path": "/tmp/after.png",
        "width": 1280,
        "height": 960,
        "sample_bytes": 1024,
        "duration_ms": null,
        "max_edge": 1280,
        "max_duration_ms": 3000
    }))
    .unwrap();
    assert!(result.image_details.is_none());
}

#[test]
fn heic_preview_contract_round_trips_with_stable_wire_names() {
    let request: PreviewRequest = serde_json::from_value(serde_json::json!({
        "request_id": "current",
        "preview_session_id": "123e4567-e89b-42d3-a456-426614174000",
        "pinned_jpeg_quality": 90,
        "input_path": "/tmp/source.heic",
        "source_revision": "two",
        "target": "jpeg",
        "image_options": {"jpeg_quality": 72, "resize": {"kind": "original"}}
    }))
    .unwrap();
    assert_eq!(request.pinned_jpeg_quality, Some(90));

    let details = ImagePreviewDetails {
        sample_kind: ImageSampleKind::EmbeddedHeicThumbnail,
        admitted_sample_width: 1600,
        admitted_sample_height: 1200,
        comparison_frame_width: 1280,
        comparison_frame_height: 960,
        planned_output_width: 8064,
        planned_output_height: 6048,
        current_jpeg_quality: 72,
        pinned_jpeg_quality: Some(90),
        pinned_path: Some("/tmp/pinned.png".into()),
    };
    let value = serde_json::to_value(details).unwrap();
    assert_eq!(value["sample_kind"], "embedded_heic_thumbnail");
    assert_eq!(value["comparison_frame_width"], 1280);
    assert_eq!(value["pinned_path"], "/tmp/pinned.png");
}

#[test]
fn absent_nested_preview_options_are_omitted() {
    let details = ImagePreviewDetails {
        sample_kind: ImageSampleKind::EmbeddedHeicThumbnail,
        admitted_sample_width: 640,
        admitted_sample_height: 480,
        comparison_frame_width: 640,
        comparison_frame_height: 480,
        planned_output_width: 640,
        planned_output_height: 480,
        current_jpeg_quality: 75,
        pinned_jpeg_quality: None,
        pinned_path: None,
    };
    let object = serde_json::to_value(details).unwrap();
    assert!(object.get("pinned_jpeg_quality").is_none());
    assert!(object.get("pinned_path").is_none());
}
