//! Per-page PNG thumbnails for a PDF, generated via the bundled mutool
//! sidecar (Artifex MuPDF). Used by the v0.2.3 page-grid UI for the
//! reorder / delete / rotate / insert flows.
//!
//! The mutool process is spawned via `Command::spawn` — no in-process
//! linking. AGPL stays on the subprocess side of the boundary; goop's
//! MIT license is preserved. See LICENSING.md.

use crate::PdfError;
use goop_core::{JobId, PidGuard, PidRegistry};
use goop_sidecar::BinaryResolver;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

/// Where to write thumbnails and at what density. Caller owns the cache
/// dir (typically `<data_dir>/page-thumbs/<key>/`); `generate_page_thumbnails`
/// only writes into the directory it's given.
pub struct PageThumbnailRequest {
    pub input: PathBuf,
    /// Total page count from a prior `probe` call. Used to size the
    /// returned Vec and to filter out any spurious extra files mutool
    /// might emit on edge-case inputs.
    pub pages: u32,
    pub output_dir: PathBuf,
    /// PNG density in dpi. 50 ≈ 100 px wide for Letter — adequate for
    /// grid display. Bump to 144+ for hover-zoom.
    pub dpi: u32,
}

/// Cache key for a (path, mtime) pair. Stable across runs as long as
/// neither the canonical path nor the file's mtime changes. Falls back
/// to hashing just the path if mtime is unavailable (very unusual).
pub fn cache_key(input: &Path) -> String {
    let canonical = std::fs::canonicalize(input)
        .unwrap_or_else(|_| input.to_path_buf())
        .to_string_lossy()
        .into_owned();
    let mtime_nanos: u128 = std::fs::metadata(input)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = DefaultHasher::new();
    canonical.hash(&mut hasher);
    mtime_nanos.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Generate one PNG per page of the input PDF under `output_dir`,
/// named `page-1.png` … `page-N.png`. Returns the list of written
/// paths in page order, plus any cached pages we found already valid.
///
/// Spawns `mutool draw -F png -o <dir>/page-%d.png -r <dpi> -- <input>`.
/// The `%d` in mutool's `-o` argument is mutool's own page-number
/// substitution; it produces one file per page automatically.
///
/// `PidGuard` wires the spawned mutool PID into the pause/resume
/// registry the same way Ghostscript compress does. Cancellation
/// kills the subprocess.
pub async fn generate_page_thumbnails(
    resolver: &BinaryResolver,
    req: PageThumbnailRequest,
    cancel: CancellationToken,
    pids: Option<Arc<dyn PidRegistry>>,
    job_id: Option<JobId>,
) -> Result<Vec<PathBuf>, PdfError> {
    if req.pages == 0 {
        return Err(PdfError::Range("input has zero pages".into()));
    }
    let bin = resolver
        .resolve("mutool")
        .map_err(|e| PdfError::MutoolMissing(format!("mutool: {e}")))?;
    std::fs::create_dir_all(&req.output_dir)?;
    if cancel.is_cancelled() {
        return Err(PdfError::Mutool("cancelled before start".into()));
    }

    let output_template = req.output_dir.join("page-%d.png");
    let mut cmd = Command::new(&bin.path);
    cmd.arg("draw")
        .arg("-F")
        .arg("png")
        .arg("-o")
        .arg(&output_template)
        .arg("-r")
        .arg(req.dpi.to_string())
        .arg("--")
        .arg(&req.input);

    let mut child = cmd.spawn().map_err(PdfError::Io)?;
    let _pid_guard = match (pids.as_ref(), job_id, child.id()) {
        (Some(reg), Some(id), Some(pid)) => Some(PidGuard::new(reg.clone(), id, pid)),
        _ => None,
    };

    tokio::select! {
        wait = child.wait() => {
            let status = wait.map_err(PdfError::Io)?;
            if !status.success() {
                return Err(PdfError::Mutool(format!(
                    "mutool exited with status {status}"
                )));
            }
        }
        _ = cancel.cancelled() => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(PdfError::Mutool("cancelled".into()));
        }
    }

    let mut out_paths = Vec::with_capacity(req.pages as usize);
    for p in 1..=req.pages {
        let path = req.output_dir.join(format!("page-{p}.png"));
        if path.exists() {
            out_paths.push(path);
        }
    }
    if out_paths.is_empty() {
        return Err(PdfError::Mutool(
            "mutool ran but no PNGs were written".into(),
        ));
    }
    Ok(out_paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixture::write_blank_pdf;
    use std::time::Duration;

    #[test]
    fn cache_key_stable_for_same_file_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("a.pdf");
        write_blank_pdf(&pdf, 1);
        let key1 = cache_key(&pdf);
        let key2 = cache_key(&pdf);
        assert_eq!(key1, key2);
        assert_eq!(key1.len(), 16, "expected 16-char hex digest");
    }

    #[test]
    fn cache_key_changes_when_file_mtime_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("a.pdf");
        write_blank_pdf(&pdf, 1);
        let key1 = cache_key(&pdf);
        std::thread::sleep(Duration::from_millis(20));
        write_blank_pdf(&pdf, 2); // rewrite with new mtime + new content
        let key2 = cache_key(&pdf);
        assert_ne!(key1, key2);
    }

    #[test]
    fn cache_key_distinguishes_different_files() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf_a = tmp.path().join("a.pdf");
        let pdf_b = tmp.path().join("b.pdf");
        write_blank_pdf(&pdf_a, 1);
        write_blank_pdf(&pdf_b, 1);
        assert_ne!(cache_key(&pdf_a), cache_key(&pdf_b));
    }

    #[test]
    fn cache_key_handles_nonexistent_path() {
        // If the file vanished between probe and key computation, fall
        // back to hashing just the path so we don't panic.
        let key = cache_key(Path::new("/nonexistent/path/to/file.pdf"));
        assert_eq!(key.len(), 16);
    }

    #[tokio::test]
    async fn rejects_zero_pages_input() {
        let tmp = tempfile::tempdir().unwrap();
        let resolver = BinaryResolver::new(std::env::current_dir().unwrap());
        let req = PageThumbnailRequest {
            input: tmp.path().join("nonexistent.pdf"),
            pages: 0,
            output_dir: tmp.path().join("out"),
            dpi: 50,
        };
        let err = generate_page_thumbnails(&resolver, req, CancellationToken::new(), None, None)
            .await
            .unwrap_err();
        assert!(matches!(err, PdfError::Range(_)));
    }

    #[tokio::test]
    #[ignore = "requires mutool on PATH or in src-tauri/bin"]
    async fn generates_three_thumbnails_for_three_page_pdf() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("three.pdf");
        write_blank_pdf(&pdf, 3);
        let out = tmp.path().join("thumbs");
        let resolver = BinaryResolver::new(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("src-tauri/bin"),
        );
        let outputs = generate_page_thumbnails(
            &resolver,
            PageThumbnailRequest {
                input: pdf,
                pages: 3,
                output_dir: out,
                dpi: 50,
            },
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .expect("mutool must be available for this test");
        assert_eq!(outputs.len(), 3);
        for p in &outputs {
            assert!(p.exists() && std::fs::metadata(p).unwrap().len() > 0);
        }
    }
}
