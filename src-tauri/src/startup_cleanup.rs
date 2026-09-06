use goop_config as cfg;
use goop_core::{GoopError, Job, JobId, JobState};
use goop_extractor::debrid::{DebridPartialArtifact, PARTIAL_ARTIFACTS_PAYLOAD_KEY};
use goop_extractor::ytdlp::ExtractRequest;
use goop_queue::QueueStore;
use std::path::{Component, Path, PathBuf};

const PARTIAL_STALE_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);

struct PartialSweepInputs {
    output_dirs: Vec<PathBuf>,
    protected_requests: Vec<ExtractRequest>,
    malformed_jobs: usize,
    preserve_current_artifacts: bool,
}

fn partial_sweep_inputs(settings: &cfg::Settings, jobs: &[Job]) -> PartialSweepInputs {
    let mut output_dirs = vec![PathBuf::from(&settings.output_dir)];
    if let Some(dir) = &settings.output_dir_extract {
        output_dirs.push(PathBuf::from(dir));
    }
    let mut protected_requests = Vec::new();
    let mut malformed_jobs = 0;
    let mut preserve_current_artifacts = false;

    for job in jobs {
        let retryable = matches!(
            &job.state,
            JobState::Queued | JobState::Running | JobState::Paused | JobState::Error { .. }
        );
        let request: ExtractRequest = match serde_json::from_value(job.payload.clone()) {
            Ok(request) => request,
            Err(_) => {
                malformed_jobs += 1;
                preserve_current_artifacts |= retryable;
                continue;
            }
        };
        output_dirs.push(PathBuf::from(&request.output_dir));
        let debrid_capable = request.debrid
            || request.debrid_item.is_some()
            || goop_extractor::debrid::is_magnet(&request.url);
        match job.payload.get(PARTIAL_ARTIFACTS_PAYLOAD_KEY) {
            Some(raw_artifacts) => {
                match serde_json::from_value::<Vec<DebridPartialArtifact>>(raw_artifacts.clone()) {
                    Ok(artifacts) if artifacts.is_empty() && retryable && debrid_capable => {
                        malformed_jobs += 1;
                        preserve_current_artifacts = true;
                    }
                    Ok(artifacts) => {
                        for artifact in artifacts {
                            let Some(child) = partial_child_request(&request, artifact) else {
                                malformed_jobs += 1;
                                preserve_current_artifacts |= retryable;
                                continue;
                            };
                            output_dirs.push(PathBuf::from(&child.output_dir));
                            if retryable {
                                protected_requests.push(child);
                            }
                        }
                    }
                    Err(_) => {
                        malformed_jobs += 1;
                        preserve_current_artifacts |= retryable;
                    }
                }
            }
            None if retryable && debrid_capable => {
                // Jobs created before exact child metadata was introduced may
                // own multi-file partials whose hashes include unpersisted
                // TorBox file IDs. Preserve every current artifact this pass.
                malformed_jobs += 1;
                preserve_current_artifacts = true;
            }
            None => {}
        }
        if retryable {
            protected_requests.push(request);
        }
    }

    PartialSweepInputs {
        output_dirs,
        protected_requests,
        malformed_jobs,
        preserve_current_artifacts,
    }
}

fn partial_child_request(
    parent: &ExtractRequest,
    artifact: DebridPartialArtifact,
) -> Option<ExtractRequest> {
    let relative = Path::new(&artifact.relative_dir);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
        && !artifact.relative_dir.is_empty()
    {
        return None;
    }
    if artifact.resume_key.is_empty() {
        return None;
    }
    let root = PathBuf::from(&parent.output_dir);
    let mut output_dir = root.join(relative);
    match std::fs::symlink_metadata(&output_dir) {
        Ok(_) => {
            let canonical_root = std::fs::canonicalize(&root).ok()?;
            let canonical_child = std::fs::canonicalize(&output_dir).ok()?;
            if !canonical_child.starts_with(&canonical_root) {
                return None;
            }
            output_dir = canonical_child;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    let mut child = parent.clone();
    child.output_dir = output_dir.to_string_lossy().into_owned();
    child.resume_key = Some(artifact.resume_key);
    child.debrid = false;
    child.debrid_item = None;
    child.filename_hint = None;
    Some(child)
}

pub(crate) fn persist_job_payload_field(
    store: &QueueStore,
    id: JobId,
    key: &str,
    value: serde_json::Value,
) -> Result<(), GoopError> {
    store.patch_payload_field(id, key, value)
}

fn cleanup_completed_downloads(jobs: &[Job]) {
    for job in jobs {
        if let Err(error) = goop_extractor::recovery::cleanup_completed_recovery(job) {
            tracing::warn!(?job.id, %error, "completed Extract cleanup retained uncertain artifacts");
        }
    }
}

pub(crate) fn cleanup_orphaned_downloads(store: &QueueStore, settings: &cfg::Settings) {
    let jobs = match store.list_extract_jobs() {
        Ok(jobs) => jobs,
        Err(e) => {
            tracing::warn!(error = %e, "could not inspect extract jobs for partial cleanup");
            return;
        }
    };
    // Serial background catch-up: no media hashing or traversal of output roots.
    // Each candidate is an exact persisted Done row already loaded for this pass.
    let completed: Vec<_> = jobs
        .iter()
        .filter(|job| {
            job.state == JobState::Done
                && job
                    .payload
                    .get(goop_extractor::recovery::RECOVERY_PAYLOAD_KEY)
                    .is_some()
        })
        .cloned()
        .collect();
    tauri::async_runtime::spawn_blocking(move || cleanup_completed_downloads(&completed));
    let inputs = partial_sweep_inputs(settings, &jobs);
    if inputs.malformed_jobs > 0 {
        tracing::warn!(
            count = inputs.malformed_jobs,
            preserving_current_artifacts = inputs.preserve_current_artifacts,
            "ignored malformed extract rows during partial cleanup"
        );
    }
    // A malformed retryable payload may own a current partial whose output
    // path/hash cannot be reconstructed. Fail closed for modern artifacts in
    // that case; obsolete `.goopdl.tN` markers are still removed.
    let stale_before = if inputs.preserve_current_artifacts {
        None
    } else {
        Some(
            std::time::SystemTime::now()
                .checked_sub(PARTIAL_STALE_AGE)
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        )
    };
    let report = goop_extractor::sweep_orphaned_partials(
        &inputs.output_dirs,
        &inputs.protected_requests,
        stale_before,
    );
    for failure in &report.failures {
        tracing::warn!(
            path = %failure.path.display(),
            error = %failure.error,
            "could not remove orphaned download artifact"
        );
    }
    if report.removed_files > 0 || !report.failures.is_empty() {
        tracing::info!(
            removed_files = report.removed_files,
            removed_bytes = report.removed_bytes,
            failures = report.failures.len(),
            "startup partial cleanup finished"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use goop_core::{JobKind, JobState};

    fn extract_job(url: &str, output_dir: &str, state: JobState) -> Job {
        let request = ExtractRequest {
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
        };
        let mut job = Job::new(JobKind::Extract, serde_json::to_value(request).unwrap());
        job.state = state;
        job
    }

    #[test]
    fn completed_catchup_cleans_only_exact_safe_done_rows() {
        use goop_extractor::recovery::{ExtractRecovery, RECOVERY_PAYLOAD_KEY};
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let store = QueueStore::open(&root.join("queue.db")).unwrap();
        let mut directories = Vec::new();
        for (index, state) in [
            JobState::Done,
            JobState::Paused,
            JobState::Done,
            JobState::Done,
        ]
        .into_iter()
        .enumerate()
        {
            let mut job = extract_job("https://example.test/video", root.to_str().unwrap(), state);
            let req: ExtractRequest = serde_json::from_value(job.payload.clone()).unwrap();
            let recovery = ExtractRecovery::ephemeral();
            let cp = recovery.allocate(job.id, &req).unwrap();
            let workspace = cp.root.join(cp.workspace);
            std::fs::write(workspace.join("source.mp4"), b"source").unwrap();
            let output = root.join(format!("output-{index}.mp4"));
            std::fs::write(&output, b"public").unwrap();
            recovery.receipt(output.clone()).unwrap();
            if index == 2 {
                recovery.set_writer(true).unwrap();
            }
            let mut cp = recovery.checkpoint().unwrap();
            if index == 3 {
                cp.fingerprint = "forged".into();
            }
            job.payload[RECOVERY_PAYLOAD_KEY] = serde_json::to_value(cp).unwrap();
            job.result = Some(goop_core::JobResult {
                output_path: Some(output.to_string_lossy().into()),
                bytes: Some(6),
                duration_ms: 0,
                result_kind: goop_core::ResultKind::File,
                file_count: 1,
                source_bytes: None,
                target_bytes: None,
                reencoded: None,
            });
            store.insert(&job).unwrap();
            directories.push(workspace);
        }
        let jobs = store.list_extract_jobs().unwrap();
        cleanup_completed_downloads(&jobs);
        cleanup_completed_downloads(&jobs);
        assert!(!directories[0].exists());
        assert!(directories[1..].iter().all(|path| path.exists()));
        for index in 0..4 {
            assert_eq!(
                std::fs::read(root.join(format!("output-{index}.mp4"))).unwrap(),
                b"public"
            );
        }
    }

    #[test]
    fn discovers_history_dirs_and_protects_retryable_states() {
        let settings = cfg::Settings {
            output_dir: "/global".into(),
            output_dir_extract: Some("/current-extract".into()),
            ..cfg::Settings::default()
        };
        let jobs = vec![
            extract_job("https://paused", "/old-paused", JobState::Paused),
            extract_job(
                "https://error",
                "/old-error",
                JobState::Error {
                    message: "interrupted".into(),
                    detail: None,
                },
            ),
            extract_job("https://done", "/old-done", JobState::Done),
            {
                let mut job =
                    extract_job("magnet:?xt=urn:btih:done", "/old-debrid", JobState::Done);
                job.payload["debrid"] = serde_json::Value::Bool(true);
                job.payload[PARTIAL_ARTIFACTS_PAYLOAD_KEY] = serde_json::json!([{
                    "relative_dir": "album/disc",
                    "resume_key": "magnet:?xt=urn:btih:done#42"
                }]);
                job
            },
            Job::new(JobKind::Extract, serde_json::Value::Null),
        ];

        let inputs = partial_sweep_inputs(&settings, &jobs);

        for expected in [
            "/global",
            "/current-extract",
            "/old-paused",
            "/old-error",
            "/old-done",
            "/old-debrid",
            "/old-debrid/album/disc",
        ] {
            assert!(inputs.output_dirs.contains(&PathBuf::from(expected)));
        }
        let protected_urls: Vec<_> = inputs
            .protected_requests
            .iter()
            .map(|request| request.url.as_str())
            .collect();
        assert_eq!(protected_urls, vec!["https://paused", "https://error"]);
        assert_eq!(inputs.malformed_jobs, 1);
        assert!(inputs.preserve_current_artifacts);
    }

    #[test]
    fn debrid_partial_metadata_rejects_paths_outside_the_output_root() {
        let parent = extract_job("magnet:?xt=urn:btih:x", "/downloads", JobState::Paused);
        let request: ExtractRequest = serde_json::from_value(parent.payload).unwrap();

        assert!(partial_child_request(
            &request,
            DebridPartialArtifact {
                relative_dir: "../elsewhere".into(),
                resume_key: "magnet:?xt=urn:btih:x#1".into(),
            }
        )
        .is_none());
        assert!(partial_child_request(
            &request,
            DebridPartialArtifact {
                relative_dir: "/absolute".into(),
                resume_key: "magnet:?xt=urn:btih:x#1".into(),
            }
        )
        .is_none());
    }

    #[test]
    fn legacy_retryable_debrid_without_child_metadata_fails_closed() {
        let settings = cfg::Settings::default();
        let mut job = extract_job("magnet:?xt=urn:btih:legacy", "/downloads", JobState::Paused);
        job.payload["debrid"] = serde_json::Value::Bool(true);

        let inputs = partial_sweep_inputs(&settings, &[job]);

        assert!(inputs.preserve_current_artifacts);
        assert_eq!(inputs.malformed_jobs, 1);
    }

    #[cfg(unix)]
    #[test]
    fn debrid_partial_metadata_rejects_a_symlink_outside_the_output_root() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        let parent = extract_job(
            "magnet:?xt=urn:btih:x",
            &root.path().to_string_lossy(),
            JobState::Paused,
        );
        let request: ExtractRequest = serde_json::from_value(parent.payload).unwrap();

        assert!(partial_child_request(
            &request,
            DebridPartialArtifact {
                relative_dir: "escape".into(),
                resume_key: "magnet:?xt=urn:btih:x#1".into(),
            }
        )
        .is_none());
    }

    #[test]
    fn payload_field_updates_preserve_existing_debrid_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let store = QueueStore::open(&dir.path().join("queue.db")).unwrap();
        let job = extract_job("magnet:?xt=urn:btih:x", "/downloads", JobState::Queued);
        store.insert(&job).unwrap();

        persist_job_payload_field(
            &store,
            job.id,
            "debrid_item",
            serde_json::Value::String("torrent:42".into()),
        )
        .unwrap();
        persist_job_payload_field(
            &store,
            job.id,
            PARTIAL_ARTIFACTS_PAYLOAD_KEY,
            serde_json::json!([{
                "relative_dir": "album",
                "resume_key": "magnet:?xt=urn:btih:x#1"
            }]),
        )
        .unwrap();

        let payload = store.get_by_id(job.id).unwrap().unwrap().payload;
        assert_eq!(payload["debrid_item"], "torrent:42");
        assert_eq!(
            payload[PARTIAL_ARTIFACTS_PAYLOAD_KEY][0]["relative_dir"],
            "album"
        );
    }
}
