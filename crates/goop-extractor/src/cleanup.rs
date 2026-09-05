use crate::direct::url_hash;
use crate::ytdlp::ExtractRequest;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartialSweepFailure {
    pub path: PathBuf,
    pub error: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PartialSweepReport {
    pub removed_files: usize,
    pub removed_bytes: u64,
    pub failures: Vec<PartialSweepFailure>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtifactKind {
    LegacyMarker,
    CurrentPartial,
}

/// The stable basename key used by direct-download `.part` and `.meta` files.
/// Debrid downloads prefer their original-link `resume_key` because their CDN
/// URL can rotate between attempts.
pub fn partial_artifact_hash(request: &ExtractRequest) -> String {
    url_hash(request.resume_key.as_deref().unwrap_or(&request.url))
}

/// Remove Goop-owned partial-download debris from known output directories.
///
/// Obsolete `.goopdl.tN` marker files are never read by current Goop and can
/// be removed immediately. Current `.goopdl.part`/`.meta` files are removed
/// only when `stale_before` is `Some`, older than that cutoff, and not
/// associated with a retryable request. Each known directory is inspected
/// shallowly; multi-file callers supply their persisted child directories.
/// Unrelated `.part` files and symlinks are never touched.
///
/// Cleanup is best-effort: one unreadable directory or file is reported but
/// does not prevent the remaining known directories from being swept.
pub fn sweep_orphaned_partials(
    output_dirs: &[PathBuf],
    protected_requests: &[ExtractRequest],
    stale_before: Option<SystemTime>,
) -> PartialSweepReport {
    let mut report = PartialSweepReport::default();
    let protected = protected_paths(protected_requests);
    let mut seen_dirs = HashSet::new();

    for requested_dir in output_dirs {
        if requested_dir.as_os_str().is_empty() {
            continue;
        }
        let dir = normalize_dir(requested_dir);
        if !seen_dirs.insert(dir.clone()) {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                report.failures.push(PartialSweepFailure {
                    path: dir,
                    error: e.to_string(),
                });
                continue;
            }
        };

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    report.failures.push(PartialSweepFailure {
                        path: dir.clone(),
                        error: e.to_string(),
                    });
                    continue;
                }
            };
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(e) => {
                    report.failures.push(PartialSweepFailure {
                        path,
                        error: e.to_string(),
                    });
                    continue;
                }
            };
            if file_type.is_dir() {
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(kind) = artifact_kind(&name) else {
                continue;
            };
            if kind == ArtifactKind::CurrentPartial && protected.contains(&path) {
                continue;
            }

            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(e) => {
                    report.failures.push(PartialSweepFailure {
                        path,
                        error: e.to_string(),
                    });
                    continue;
                }
            };
            if kind == ArtifactKind::CurrentPartial {
                let Some(stale_before) = stale_before else {
                    continue;
                };
                let modified = match metadata.modified() {
                    Ok(modified) => modified,
                    Err(e) => {
                        report.failures.push(PartialSweepFailure {
                            path,
                            error: e.to_string(),
                        });
                        continue;
                    }
                };
                if modified > stale_before {
                    continue;
                }
            }

            match std::fs::remove_file(&path) {
                Ok(()) => {
                    report.removed_files += 1;
                    report.removed_bytes = report.removed_bytes.saturating_add(metadata.len());
                }
                Err(e) => report.failures.push(PartialSweepFailure {
                    path,
                    error: e.to_string(),
                }),
            }
        }
    }

    report
}

fn protected_paths(requests: &[ExtractRequest]) -> HashSet<PathBuf> {
    let mut protected = HashSet::new();
    for request in requests {
        let raw_dir = Path::new(&request.output_dir);
        if raw_dir.as_os_str().is_empty() {
            continue;
        }
        let dir = normalize_dir(raw_dir);
        let hash = partial_artifact_hash(request);
        protected.insert(dir.join(format!(".{hash}.goopdl.part")));
        protected.insert(dir.join(format!(".{hash}.goopdl.meta")));
    }
    protected
}

fn normalize_dir(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn artifact_kind(name: &str) -> Option<ArtifactKind> {
    let rest = name.strip_prefix('.')?;
    let (hash, suffix) = rest.split_at_checked(16)?;
    if !hash
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    match suffix {
        ".goopdl.part" | ".goopdl.meta" => Some(ArtifactKind::CurrentPartial),
        _ => suffix
            .strip_prefix(".goopdl.t")
            .filter(|tail| !tail.is_empty() && tail.bytes().all(|byte| byte.is_ascii_digit()))
            .map(|_| ArtifactKind::LegacyMarker),
    }
}
