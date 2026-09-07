use goop_core::{ConvertRequest, ImageResize};
use serde_json::json;

#[test]
fn old_requests_remain_legacy_and_explicit_settings_round_trip() {
    let old: ConvertRequest = serde_json::from_value(json!({
        "input_path":"/fixture.jpg", "output_path":"/out.jpg", "target":"jpeg"
    }))
    .unwrap();
    assert!(old.image_options.is_none());
    let mut wire = serde_json::to_value(&old).unwrap();
    wire["image_options"] = json!({"jpeg_quality":90,
        "resize":{"kind":"fit_within","width":2048,"height":2048}});
    let new: ConvertRequest = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(new.image_options.as_ref().unwrap().jpeg_quality, 90);
    assert_eq!(
        new.image_options.as_ref().unwrap().resize,
        ImageResize::FitWithin {
            width: 2048,
            height: 2048
        }
    );
    assert_eq!(serde_json::to_value(new).unwrap(), wire);
}

#[test]
fn image_settings_require_complete_fields_and_byte_sized_quality() {
    for image_options in [
        json!({"jpeg_quality": 75}),
        json!({"resize": {"kind": "original"}}),
        json!({"jpeg_quality": 256, "resize": {"kind": "original"}}),
    ] {
        let request = json!({
            "input_path": "/fixture.jpg",
            "output_path": "/out.jpg",
            "target": "jpeg",
            "image_options": image_options
        });
        assert!(serde_json::from_value::<ConvertRequest>(request).is_err());
    }
}
