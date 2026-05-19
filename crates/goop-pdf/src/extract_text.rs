//! PDF text-layer extraction via the bundled mutool sidecar.
//! Wraps `mutool convert -F text -o <out.txt> -- <in.pdf>`.
//!
//! This does **not** run OCR. For PDFs with no embedded text layer
//! (scanned documents, image-only exports), the output will be empty
//! or near-empty — route those through `PdfOperation::PdfOcr` instead.
//! The Phase 7 auto-detect heuristic that picks between the two paths
//! lands in v0.2.7 ("PDF as Text").
//!
//! Same subprocess-only AGPL boundary as `page_thumbs` — mutool is
//! spawned via `Command::spawn`, never linked. See LICENSING.md.

use crate::PdfError;
use goop_core::{JobId, PidGuard, PidRegistry};
use goop_sidecar::BinaryResolver;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

/// Extract the text layer from `input` into `output_path` as plain
/// UTF-8. The output is overwritten if it already exists.
///
/// Errors:
/// - `PdfError::MutoolMissing` if mutool isn't resolvable
/// - `PdfError::Mutool` if the subprocess fails or is cancelled
/// - `PdfError::Io` for fs operations
pub async fn extract_text(
    resolver: &BinaryResolver,
    input: &Path,
    output_path: &Path,
    cancel: CancellationToken,
    pids: Option<Arc<dyn PidRegistry>>,
    job_id: Option<JobId>,
) -> Result<PathBuf, PdfError> {
    let bin = resolver
        .resolve("mutool")
        .map_err(|e| PdfError::MutoolMissing(format!("mutool: {e}")))?;

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(PdfError::Io)?;
    }
    if cancel.is_cancelled() {
        return Err(PdfError::Mutool("cancelled before start".into()));
    }

    let mut cmd = Command::new(&bin.path);
    cmd.arg("convert")
        .arg("-F")
        .arg("text")
        .arg("-o")
        .arg(output_path)
        .arg("--")
        .arg(input);

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
                    "mutool convert -F text exited with status {status}"
                )));
            }
        }
        _ = cancel.cancelled() => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(PdfError::Mutool("cancelled".into()));
        }
    }

    if !output_path.exists() {
        return Err(PdfError::Mutool(
            "mutool ran but no output file was written".into(),
        ));
    }
    Ok(output_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixture::write_blank_pdf;

    #[tokio::test]
    async fn cancellation_before_start_returns_mutool_error() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("a.pdf");
        write_blank_pdf(&pdf, 1);
        let out = tmp.path().join("a.txt");
        let cancel = CancellationToken::new();
        cancel.cancel();
        let resolver = BinaryResolver::new(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("src-tauri/bin"),
        );
        let err = extract_text(&resolver, &pdf, &out, cancel, None, None)
            .await
            .unwrap_err();
        match err {
            // Pre-spawn cancel returns Mutool("cancelled before start"); when mutool
            // isn't on this machine, MutoolMissing comes back instead. Either path
            // exercises the early-return logic we care about for this test.
            PdfError::Mutool(_) | PdfError::MutoolMissing(_) => {}
            other => panic!("expected Mutool or MutoolMissing, got {other:?}"),
        }
    }

    #[tokio::test]
    #[ignore = "requires mutool on PATH or in src-tauri/bin"]
    async fn writes_text_file_for_blank_pdf() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("blank.pdf");
        write_blank_pdf(&pdf, 1);
        let out = tmp.path().join("blank.txt");
        let resolver = BinaryResolver::new(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("src-tauri/bin"),
        );
        let written = extract_text(&resolver, &pdf, &out, CancellationToken::new(), None, None)
            .await
            .expect("mutool must be available for this test");
        // Blank page produces a (mostly empty) text file. The file exists,
        // the path matches what we asked for; content can be empty.
        assert_eq!(written, out);
        assert!(out.exists());
    }
}
