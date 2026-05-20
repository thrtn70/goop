//! PDF page rasterization to a folder of PNG / JPEG images via mutool.
//! Wraps `mutool draw -F {png|jpg} -o <dir>/page-%d.{ext} -r <dpi> -- <in>`.
//!
//! Distinct from `page_thumbs` (which writes small fixed-DPI PNGs to the
//! app's cache for grid UI): this is the user-facing "extract every page
//! as an image" operation that lets the user pick format + DPI + output
//! folder. Output filenames are `page-1.{ext}` … `page-N.{ext}`.
//!
//! AGPL stays subprocess-only — same boundary as page_thumbs.

use crate::PdfError;
use goop_core::{pdf::PdfImageFormat, JobId, PidGuard, PidRegistry};
use goop_sidecar::BinaryResolver;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

/// Rasterize every page of `input` into `output_dir` as `format` at
/// `dpi`. Returns the list of written paths in page order.
///
/// Caller is responsible for picking a `dpi` that makes sense for the
/// use case: 72-96 dpi for screen, 150-300 for archival/print. The
/// flow UI default of 150 is a reasonable middle ground.
#[allow(clippy::too_many_arguments)]
pub async fn extract_images(
    resolver: &BinaryResolver,
    input: &Path,
    output_dir: &Path,
    format: PdfImageFormat,
    dpi: u32,
    cancel: CancellationToken,
    pids: Option<Arc<dyn PidRegistry>>,
    job_id: Option<JobId>,
) -> Result<Vec<PathBuf>, PdfError> {
    if dpi == 0 {
        return Err(PdfError::Range("dpi must be >= 1".into()));
    }
    let bin = resolver
        .resolve("mutool")
        .map_err(|e| PdfError::MutoolMissing(format!("mutool: {e}")))?;
    tokio::fs::create_dir_all(output_dir)
        .await
        .map_err(PdfError::Io)?;
    if cancel.is_cancelled() {
        return Err(PdfError::Mutool("cancelled before start".into()));
    }

    let ext = format.file_extension();
    let output_template = output_dir.join(format!("page-%d.{ext}"));

    let mut cmd = Command::new(&bin.path);
    cmd.arg("draw")
        .arg("-F")
        .arg(format.mutool_flag())
        .arg("-o")
        .arg(&output_template)
        .arg("-r")
        .arg(dpi.to_string())
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
                    "mutool draw exited with status {status}"
                )));
            }
        }
        _ = cancel.cancelled() => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(PdfError::Mutool("cancelled".into()));
        }
    }

    // mutool's `-o <dir>/page-%d.ext` is page-number substitution. Collect
    // the written files in order. We don't know the page count up-front
    // (the worker has it from probe but doesn't pass it here), so we
    // walk the dir for the matching pattern. The walk is a blocking
    // syscall — offload to the blocking pool so the runtime stays free.
    let out_dir_owned = output_dir.to_path_buf();
    let ext_owned = ext.to_string();
    let out_paths: Vec<PathBuf> = tokio::task::spawn_blocking(move || {
        let mut paths: Vec<PathBuf> = std::fs::read_dir(&out_dir_owned)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                name.starts_with("page-") && name.ends_with(&format!(".{ext_owned}"))
            })
            .collect();
        paths.sort_by_key(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .and_then(|s| s.strip_prefix("page-"))
                .and_then(|s| s.split('.').next())
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(u32::MAX)
        });
        Ok::<_, std::io::Error>(paths)
    })
    .await
    .map_err(|e| PdfError::Mutool(e.to_string()))?
    .map_err(PdfError::Io)?;
    if out_paths.is_empty() {
        return Err(PdfError::Mutool(
            "mutool ran but no image files were written".into(),
        ));
    }
    Ok(out_paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixture::write_blank_pdf;

    #[tokio::test]
    async fn rejects_zero_dpi() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("a.pdf");
        write_blank_pdf(&pdf, 1);
        let resolver = BinaryResolver::new(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("src-tauri/bin"),
        );
        let err = extract_images(
            &resolver,
            &pdf,
            &tmp.path().join("out"),
            PdfImageFormat::Png,
            0,
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PdfError::Range(_)));
    }

    #[tokio::test]
    #[ignore = "requires mutool on PATH or in src-tauri/bin"]
    async fn writes_one_png_per_page() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("three.pdf");
        write_blank_pdf(&pdf, 3);
        let out_dir = tmp.path().join("imgs");
        let resolver = BinaryResolver::new(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("src-tauri/bin"),
        );
        let outs = extract_images(
            &resolver,
            &pdf,
            &out_dir,
            PdfImageFormat::Png,
            72,
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .expect("mutool required");
        assert_eq!(outs.len(), 3);
        for (i, p) in outs.iter().enumerate() {
            let want_name = format!("page-{}.png", i + 1);
            assert_eq!(p.file_name().unwrap(), want_name.as_str());
            assert!(std::fs::metadata(p).unwrap().len() > 0);
        }
    }
}
