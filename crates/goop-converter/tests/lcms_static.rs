use lcms2::{CIExyY, Intent, PixelFormat, Profile, ToneCurve, Transform};

#[test]
fn bundled_little_cms_executes_rgb_profile_transform() {
    let source_profile = Profile::new_srgb();
    let serialized = source_profile.icc().expect("serialize sRGB profile");
    let reparsed = Profile::new_icc(&serialized).expect("parse serialized sRGB profile");
    let destination = Profile::new_srgb();
    let transform = Transform::new(
        &reparsed,
        PixelFormat::RGB_8,
        &destination,
        PixelFormat::RGB_8,
        Intent::Perceptual,
    )
    .expect("create RGB transform");

    let source = [[0_u8, 0, 0], [32, 96, 192], [255, 255, 255]];
    let mut output = [[0_u8; 3]; 3];
    transform.transform_pixels(&source, &mut output);

    assert_eq!(source, output);
    assert_eq!(lcms2::version(), 2_190);
}

#[test]
fn bundled_little_cms_executes_gray_to_srgb_transform() {
    let d50 = CIExyY {
        x: 0.3457,
        y: 0.3585,
        Y: 1.0,
    };
    let gamma = ToneCurve::new(2.2);
    let source_profile = Profile::new_gray(&d50, &gamma).expect("create gray profile");
    let destination = Profile::new_srgb();
    let transform = Transform::new(
        &source_profile,
        PixelFormat::GRAY_8,
        &destination,
        PixelFormat::RGB_8,
        Intent::Perceptual,
    )
    .expect("create gray to RGB transform");

    let source = [0_u8, 64, 128, 192, 255];
    let mut output = [[0_u8; 3]; 5];
    transform.transform_pixels(&source, &mut output);

    assert_eq!(output[0], [0, 0, 0]);
    assert_eq!(output[4], [255, 255, 255]);
    assert!(output.windows(2).all(|pair| pair[0][0] < pair[1][0]));
    assert!(output
        .iter()
        .all(|pixel| pixel[0] == pixel[1] && pixel[1] == pixel[2]));
}

#[test]
fn bundled_little_cms_rejects_truncated_profiles() {
    let profile = Profile::new_srgb().icc().expect("serialize sRGB profile");
    let mut truncated = profile.clone();
    truncated.truncate(128);
    let mut wrong_signature = profile.clone();
    wrong_signature[36..40].copy_from_slice(b"nope");
    for (name, malformed) in [
        ("empty", &[][..]),
        ("truncated", truncated.as_slice()),
        ("wrong signature", wrong_signature.as_slice()),
    ] {
        assert!(
            Profile::new_icc(malformed).is_err(),
            "Little CMS accepted {name} profile"
        );
    }
}

#[test]
fn native_parser_does_not_replace_goop_profile_size_validation() {
    let mut profile = Profile::new_srgb().icc().expect("serialize sRGB profile");
    let oversized = u32::try_from(profile.len() + 16).expect("profile size fits u32");
    profile[..4].copy_from_slice(&oversized.to_be_bytes());

    // Little CMS accepts this mismatched header. The product path must retain
    // Goop's exact declared-length check before handing bytes to native code.
    assert!(Profile::new_icc(&profile).is_ok());
}

#[test]
fn bounded_malformed_profile_corpus_does_not_panic() {
    let profile = Profile::new_srgb().icc().expect("serialize sRGB profile");
    let mut cases = Vec::new();

    for cutoff in [0, 1, 3, 4, 15, 35, 39, 64, 127, 128, profile.len() - 1] {
        cases.push(profile[..cutoff].to_vec());
    }
    for offset in [0, 3, 16, 19, 36, 39, 64, 127, profile.len() - 1] {
        let mut mutated = profile.clone();
        mutated[offset] ^= 0xff;
        cases.push(mutated);
    }
    for declared in [0, 1, 127, 128, profile.len() - 1, profile.len() + 1] {
        let mut mutated = profile.clone();
        mutated[..4].copy_from_slice(
            &u32::try_from(declared)
                .expect("declared corpus size fits u32")
                .to_be_bytes(),
        );
        cases.push(mutated);
    }

    for (index, candidate) in cases.into_iter().enumerate() {
        let result = std::panic::catch_unwind(|| Profile::new_icc(&candidate));
        assert!(result.is_ok(), "profile mutation {index} panicked");
    }
}
