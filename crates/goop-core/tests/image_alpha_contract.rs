use goop_core::{
    validate_image_alpha_request_shape, AlphaCompositing, ConvertRequest, ImageAlphaExecution,
    ImageAlphaPolicy, ImageColorPolicy, ImageConvertOptions, ImageResize, SrgbColor, TargetFormat,
};
use serde_json::json;
use ts_rs::TS;

fn request() -> ConvertRequest {
    serde_json::from_value(json!({
        "input_path": "/input.png",
        "output_path": "/output.jpg",
        "target": "jpeg",
        "quality_preset": null,
        "resolution_cap": null,
        "gif_options": null,
        "compress_mode": null,
        "batch_id": null,
        "metadata_policy": "strip_all",
        "image_color_policy": "assume_srgb",
        "image_alpha_policy": {
            "kind": "flatten",
            "background": { "red": 12, "green": 34, "blue": 56 }
        }
    }))
    .unwrap()
}

#[test]
fn legacy_request_defaults_alpha_policy_to_none() {
    let request: ConvertRequest = serde_json::from_value(json!({
        "input_path": "/input.png",
        "output_path": "/output.jpg",
        "target": "jpeg",
        "quality_preset": null,
        "resolution_cap": null,
        "gif_options": null,
        "compress_mode": null,
        "batch_id": null
    }))
    .unwrap();

    assert_eq!(request.image_alpha_policy, None);
}

#[test]
fn alpha_policy_and_receipt_round_trip_exact_rgb_bytes() {
    let request = request();
    assert_eq!(
        request.image_alpha_policy,
        Some(ImageAlphaPolicy::Flatten {
            background: SrgbColor {
                red: 12,
                green: 34,
                blue: 56,
            },
        })
    );

    let receipt = ImageAlphaExecution {
        requested_policy: request.image_alpha_policy.unwrap(),
        source_had_alpha: true,
        flattened: true,
        background: SrgbColor {
            red: 12,
            green: 34,
            blue: 56,
        },
        compositing: AlphaCompositing::LinearSrgb,
    };
    assert_eq!(
        serde_json::to_value(receipt).unwrap(),
        json!({
            "requested_policy": {
                "kind": "flatten",
                "background": { "red": 12, "green": 34, "blue": 56 }
            },
            "source_had_alpha": true,
            "flattened": true,
            "background": { "red": 12, "green": 34, "blue": 56 },
            "compositing": "linear_srgb"
        })
    );
}

#[test]
fn alpha_shape_is_jpeg_convert_only_and_requires_explicit_color_handling() {
    let mut request = request();
    assert!(validate_image_alpha_request_shape(&request).is_ok());

    request.target = TargetFormat::Png;
    assert!(validate_image_alpha_request_shape(&request).is_err());
    request.target = TargetFormat::Jpeg;

    request.image_color_policy = Some(ImageColorPolicy::Preserve);
    assert!(validate_image_alpha_request_shape(&request).is_err());
    request.image_color_policy = Some(ImageColorPolicy::AssumeSrgb);

    request.compress_mode = Some(goop_core::CompressMode::Quality(80));
    assert!(validate_image_alpha_request_shape(&request).is_err());
    request.compress_mode = None;

    request.image_options = Some(ImageConvertOptions {
        jpeg_quality: 90,
        resize: ImageResize::Original,
    });
    assert!(validate_image_alpha_request_shape(&request).is_ok());
}

#[test]
fn alpha_policy_rejects_unknown_nested_fields() {
    let mut value = serde_json::to_value(request()).unwrap();
    value["image_alpha_policy"]["background"]["alpha"] = json!(255);
    assert!(serde_json::from_value::<ConvertRequest>(value).is_err());
}

#[test]
fn generated_alpha_policy_binding_matches_the_serde_wire_shape() {
    let binding = ImageAlphaPolicy::decl();

    assert!(
        binding.contains(r#"{ "kind": "flatten", background: SrgbColor, }"#),
        "generated TypeScript must use the same internally tagged shape as serde: {binding}"
    );
    assert!(!binding.contains(r#"{ "Flatten":"#));
}
