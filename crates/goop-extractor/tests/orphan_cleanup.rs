use goop_extractor::ytdlp::ExtractRequest;
use goop_extractor::{partial_artifact_hash, sweep_orphaned_partials};
use std::time::{Duration, SystemTime};
use tempfile::tempdir;

fn request(url: &str, output_dir: &str) -> ExtractRequest {
    ExtractRequest {
        url: url.into(),
        output_dir: output_dir.into(),
        format: None,
        audio_only: false,
        cookies_from_browser: None,
        output_template: None,
        direct: true,
        debrid: false,
        debrid_item: None,
        resume_key: None,
        filename_hint: None,
        extractor_hint: None,
    }
}

fn debrid_request(url: &str, output_dir: &str) -> ExtractRequest {
    ExtractRequest {
        debrid: true,
        ..request(url, output_dir)
    }
}

#[test]
fn removes_obsolete_markers_without_touching_unrelated_partials() {
    let dir = tempdir().unwrap();
    let legacy_a = dir.path().join(".d46330664d54c682.goopdl.t0");
    let legacy_b = dir.path().join(".0123456789abcdef.goopdl.t12");
    let current = dir.path().join(".0123456789abcdef.goopdl.part");
    let generic = dir.path().join("another-app.part");
    let near_miss = dir.path().join(".0123456789abcdef.goopdl.tbad");
    std::fs::write(&legacy_a, b"legacy-marker").unwrap();
    std::fs::write(&legacy_b, b"legacy-marker").unwrap();
    std::fs::write(&current, b"current").unwrap();
    std::fs::write(&generic, b"generic").unwrap();
    std::fs::write(&near_miss, b"near-miss").unwrap();

    let report = sweep_orphaned_partials(
        &[dir.path().to_path_buf()],
        &[],
        Some(SystemTime::UNIX_EPOCH),
    );

    assert_eq!(report.removed_files, 2);
    assert_eq!(report.removed_bytes, 26);
    assert!(report.failures.is_empty());
    assert!(!legacy_a.exists());
    assert!(!legacy_b.exists());
    assert!(current.exists());
    assert!(generic.exists());
    assert!(near_miss.exists());
}

#[test]
fn removes_stale_current_artifacts_but_preserves_retryable_requests() {
    let dir = tempdir().unwrap();
    let protected = request(
        "https://example.test/protected",
        &dir.path().to_string_lossy(),
    );
    let protected_hash = partial_artifact_hash(&protected);
    let protected_part = dir.path().join(format!(".{protected_hash}.goopdl.part"));
    let protected_meta = dir.path().join(format!(".{protected_hash}.goopdl.meta"));
    let orphan_part = dir.path().join(".0123456789abcdef.goopdl.part");
    let orphan_meta = dir.path().join(".0123456789abcdef.goopdl.meta");
    for path in [&protected_part, &protected_meta, &orphan_part, &orphan_meta] {
        std::fs::write(path, b"payload").unwrap();
    }

    let report = sweep_orphaned_partials(
        &[dir.path().to_path_buf()],
        &[protected],
        Some(SystemTime::now() + Duration::from_secs(1)),
    );

    assert_eq!(report.removed_files, 2);
    assert!(report.failures.is_empty());
    assert!(protected_part.exists());
    assert!(protected_meta.exists());
    assert!(!orphan_part.exists());
    assert!(!orphan_meta.exists());
}

#[test]
fn keeps_fresh_current_artifacts_until_the_stale_cutoff() {
    let dir = tempdir().unwrap();
    let part = dir.path().join(".0123456789abcdef.goopdl.part");
    let meta = dir.path().join(".0123456789abcdef.goopdl.meta");
    std::fs::write(&part, b"partial").unwrap();
    std::fs::write(&meta, b"metadata").unwrap();

    let report = sweep_orphaned_partials(
        &[dir.path().to_path_buf()],
        &[],
        Some(SystemTime::UNIX_EPOCH),
    );

    assert_eq!(report.removed_files, 0);
    assert!(part.exists());
    assert!(meta.exists());
}

#[test]
fn an_absent_cutoff_preserves_current_artifacts_but_removes_legacy_markers() {
    let dir = tempdir().unwrap();
    let part = dir.path().join(".0123456789abcdef.goopdl.part");
    let marker = dir.path().join(".0123456789abcdef.goopdl.t0");
    std::fs::write(&part, b"current").unwrap();
    std::fs::write(&marker, b"legacy").unwrap();

    let report = sweep_orphaned_partials(&[dir.path().to_path_buf()], &[], None);

    assert_eq!(report.removed_files, 1);
    assert!(part.exists());
    assert!(!marker.exists());
}

#[test]
fn ordinary_output_roots_are_not_walked_recursively() {
    let dir = tempdir().unwrap();
    let nested = dir.path().join("unrelated/tree");
    std::fs::create_dir_all(&nested).unwrap();
    let part = nested.join(".0123456789abcdef.goopdl.part");
    std::fs::write(&part, b"nested").unwrap();

    let report = sweep_orphaned_partials(
        &[dir.path().to_path_buf()],
        &[],
        Some(SystemTime::now() + Duration::from_secs(1)),
    );

    assert_eq!(report.removed_files, 0);
    assert!(part.exists());
}

#[test]
fn sweeps_known_nested_debrid_dirs_but_preserves_retryable_artifacts() {
    let orphan_root = tempdir().unwrap();
    let orphan_dir = orphan_root.path().join("season/episode");
    std::fs::create_dir_all(&orphan_dir).unwrap();
    let orphan_part = orphan_dir.join(".0123456789abcdef.goopdl.part");
    let orphan_marker = orphan_dir.join(".0123456789abcdef.goopdl.t0");
    std::fs::write(&orphan_part, b"orphan").unwrap();
    std::fs::write(&orphan_marker, b"legacy").unwrap();

    let protected_root = tempdir().unwrap();
    let protected_dir = protected_root.path().join("album/disc");
    std::fs::create_dir_all(&protected_dir).unwrap();
    let mut protected = debrid_request(
        "magnet:?xt=urn:btih:protected",
        &protected_dir.to_string_lossy(),
    );
    protected.resume_key = Some("magnet:?xt=urn:btih:protected#42".into());
    let protected_hash = partial_artifact_hash(&protected);
    let protected_part = protected_dir.join(format!(".{protected_hash}.goopdl.part"));
    let protected_marker = protected_dir.join(".fedcba9876543210.goopdl.t1");
    std::fs::write(&protected_part, b"retryable").unwrap();
    std::fs::write(&protected_marker, b"legacy").unwrap();

    let report = sweep_orphaned_partials(
        &[orphan_dir.to_path_buf(), protected_dir.to_path_buf()],
        &[protected],
        Some(SystemTime::now() + Duration::from_secs(1)),
    );

    assert!(report.failures.is_empty());
    assert_eq!(report.removed_files, 3);
    assert!(!orphan_part.exists());
    assert!(!orphan_marker.exists());
    assert!(protected_part.exists());
    assert!(!protected_marker.exists());
}
