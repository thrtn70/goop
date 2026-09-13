fn assert_webp_container(bytes: &[u8]) {
    assert!(bytes.len() >= 12);
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WEBP");
}

fn mean_squared_rgb_error(expected: &[u8], encoded: &[u8]) -> f64 {
    let decoded = image::load_from_memory_with_format(encoded, image::ImageFormat::WebP)
        .unwrap()
        .into_rgb8();
    assert_eq!(decoded.dimensions(), (64, 64));
    let squared_error: u64 = expected
        .iter()
        .zip(decoded.as_raw())
        .map(|(left, right)| {
            let delta = i32::from(*left) - i32::from(*right);
            (delta * delta) as u64
        })
        .sum();
    squared_error as f64 / expected.len() as f64
}

#[test]
fn candidate_encoder_encodes_lossy_rgb_and_preserves_rgba_alpha() {
    let rgb: Vec<u8> = (0..64)
        .flat_map(|y| (0..64).flat_map(move |x| [x as u8 * 4, y as u8 * 4, (x ^ y) as u8 * 4]))
        .collect();
    let low = webp::Encoder::from_rgb(&rgb, 64, 64)
        .encode_simple(false, 1.0)
        .unwrap();
    let high = webp::Encoder::from_rgb(&rgb, 64, 64)
        .encode_simple(false, 100.0)
        .unwrap();
    assert_webp_container(&low);
    assert_webp_container(&high);
    assert_ne!(low.len(), high.len());
    assert!(
        mean_squared_rgb_error(&rgb, &high) < mean_squared_rgb_error(&rgb, &low),
        "quality 100 should preserve more RGB detail than quality 1"
    );

    let rgba: Vec<u8> = (0..64)
        .flat_map(|y| {
            (0..64).flat_map(move |x| {
                [
                    x as u8 * 4,
                    y as u8 * 4,
                    (x ^ y) as u8 * 4,
                    (x + y) as u8 * 2,
                ]
            })
        })
        .collect();
    let alpha = webp::Encoder::from_rgba(&rgba, 64, 64)
        .encode_simple(false, 50.0)
        .unwrap();
    assert_webp_container(&alpha);
    let decoded = image::load_from_memory_with_format(&alpha, image::ImageFormat::WebP)
        .unwrap()
        .into_rgba8();
    assert_eq!(decoded.dimensions(), (64, 64));
    assert!(
        rgba.chunks_exact(4)
            .zip(decoded.as_raw().chunks_exact(4))
            .all(|(expected, actual)| expected[3] == actual[3]),
        "lossy WebP must preserve the source alpha plane exactly"
    );
}
