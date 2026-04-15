use goop_sidecar::BinaryResolver;

#[test]
fn resolves_from_path_when_bundled_missing() {
    // Create resolver pointed at a nonexistent sidecar dir — it should fall back to $PATH.
    let resolver = BinaryResolver::new("/nonexistent/sidecar/dir".into());
    // `cargo` is guaranteed on PATH in CI and dev.
    let r = resolver.resolve("cargo").expect("cargo should be on PATH");
    assert!(r.path.exists(), "resolved path must exist");
    assert!(
        r.source_is_path,
        "expected PATH fallback to set source_is_path=true"
    );
}

#[test]
fn returns_err_when_nowhere() {
    let resolver = BinaryResolver::new("/nonexistent".into());
    let r = resolver.resolve("definitely-not-a-real-binary-xyz123");
    assert!(r.is_err());
}
