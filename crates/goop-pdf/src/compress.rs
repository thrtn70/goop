use crate::PdfError;
use goop_core::{JobId, PdfQuality, PidGuard, PidRegistry};
use goop_sidecar::BinaryResolver;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

fn pdf_settings_flag(q: PdfQuality) -> &'static str {
    match q {
        PdfQuality::Screen => "/screen",
        PdfQuality::Ebook => "/ebook",
        PdfQuality::Printer => "/printer",
    }
}

/// Compress a PDF by running it through Ghostscript's `pdfwrite` device.
/// The `resolver` must be able to locate the bundled `gs` binary (same
/// pattern used for ffmpeg/yt-dlp).
///
/// `gs_resource_dir` points at the bundled Resource/lib/iccprofiles tree
/// and is exported as the `GS_LIB` env var so gs can find its init
/// scripts. `None` is acceptable for dev environments where gs is on
/// PATH with its compile-time resource dir intact.
///
/// `pids` and `job_id` together enable v0.2.0 pause/resume: when both are
/// `Some`, the spawned gs PID is registered for the duration of the call
/// via an RAII guard. Pass `None` for either to disable pause support
/// (e.g. tests, or call sites that don't go through the queue).
///
/// Ghostscript writes everything to a single output file — no incremental
/// output, so no streamed progress is available. We emit a cancellation
/// check only at start/end for this reason.
#[allow(clippy::too_many_arguments)]
pub async fn compress(
    resolver: &BinaryResolver,
    gs_resource_dir: Option<&Path>,
    input: &Path,
    output: &Path,
    quality: PdfQuality,
    cancel: CancellationToken,
    pids: Option<Arc<dyn PidRegistry>>,
    job_id: Option<JobId>,
) -> Result<(), PdfError> {
    let bin = resolver
        .resolve("gs")
        .map_err(|e| PdfError::Ghostscript(format!("gs binary not found: {e}")))?;

    if cancel.is_cancelled() {
        return Err(PdfError::Ghostscript("cancelled before start".into()));
    }

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut cmd = Command::new(&bin.path);
    if let Some(dir) = gs_resource_dir {
        cmd.env("GS_LIB", dir);
        cmd.arg(gs_generic_resource_dir_arg(dir));
    }
    cmd.arg("-sDEVICE=pdfwrite")
        .arg("-dCompatibilityLevel=1.4")
        .arg(format!("-dPDFSETTINGS={}", pdf_settings_flag(quality)))
        .arg("-dNOPAUSE")
        .arg("-dQUIET")
        .arg("-dBATCH")
        .arg(gs_output_arg(output))
        .arg(input)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(PdfError::Io)?;
    // Phase G: register the gs child PID for pause/resume. RAII guard
    // unregisters on Drop (covers success, error, cancel, panic).
    let _pid_guard = match (pids.as_ref(), job_id, child.id()) {
        (Some(reg), Some(id), Some(pid)) => Some(PidGuard::new(reg.clone(), id, pid)),
        _ => None,
    };

    tokio::select! {
        status = child.wait() => {
            let status = status.map_err(PdfError::Io)?;
            if !status.success() {
                let stderr = match child.stderr.take() {
                    Some(mut s) => {
                        use tokio::io::AsyncReadExt;
                        let mut buf = Vec::new();
                        let _ = s.read_to_end(&mut buf).await;
                        String::from_utf8_lossy(&buf).into_owned()
                    }
                    None => String::new(),
                };
                return Err(PdfError::Ghostscript(stderr));
            }
        }
        _ = cancel.cancelled() => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(PdfError::Ghostscript("cancelled".into()));
        }
    }
    Ok(())
}

fn gs_output_arg(output: &Path) -> String {
    let escaped = output.display().to_string().replace('%', "%%");
    format!("-sOutputFile={escaped}")
}

/// Ghostscript's `GenericResourceDir` is where it looks for CMaps, fonts,
/// and ICC profiles. With only `GS_LIB` set, gs still finds `gs_init.ps`
/// and renders, but it warns that GenericResourceDir is invalid and can
/// miss resources for exotic PDFs (CJK CMaps, non-embedded fonts, specific
/// color spaces). Point it at the bundled `<gs-resources>/Resource/` tree.
/// gs appends category subdirs (`Init/`, `Font/`, `CMap/`, …), so the value
/// must end in a separator. We use `/` (not `MAIN_SEPARATOR`): gs accepts
/// forward slashes on every platform, and a trailing `\` on Windows would be
/// swallowed by `CreateProcess` arg-quoting when the path contains spaces
/// (the `\"` escapes the closing quote and mangles the argument).
fn gs_generic_resource_dir_arg(gs_resource_dir: &Path) -> String {
    format!(
        "-sGenericResourceDir={}/",
        gs_resource_dir.join("Resource").display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_flags_match_ghostscript_preset_names() {
        assert_eq!(pdf_settings_flag(PdfQuality::Screen), "/screen");
        assert_eq!(pdf_settings_flag(PdfQuality::Ebook), "/ebook");
        assert_eq!(pdf_settings_flag(PdfQuality::Printer), "/printer");
    }

    #[test]
    fn output_arg_escapes_percent_for_ghostscript() {
        let path = Path::new("/tmp/goop 100%/out.pdf");
        assert_eq!(gs_output_arg(path), "-sOutputFile=/tmp/goop 100%%/out.pdf");
    }

    #[test]
    fn generic_resource_dir_arg_targets_resource_subdir_with_trailing_separator() {
        let arg = gs_generic_resource_dir_arg(Path::new("/opt/app/gs-resources"));
        assert!(arg.starts_with("-sGenericResourceDir="));
        assert!(arg.contains("gs-resources"));
        assert!(arg.contains("Resource"));
        // gs needs a trailing separator so it can append category dirs; we
        // always emit '/' (portable + safe under Windows arg-quoting).
        assert!(arg.ends_with('/'));
    }

    /// Ghostscript-gated: only runs when a gs binary is on PATH. CI without
    /// gs still passes because this test is `#[ignore]`.
    #[tokio::test]
    #[ignore]
    async fn compress_reduces_fixture_pdf() {
        let tmp = tempfile::tempdir().unwrap();
        // Build a multi-page fixture and compress it.
        let source = tmp.path().join("source.pdf");
        let mut doc = lopdf::Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut page_ids = Vec::new();
        for _ in 0..10 {
            let page_id = doc.new_object_id();
            let mut page = lopdf::Dictionary::new();
            page.set("Type", "Page");
            page.set("Parent", pages_id);
            page.set(
                "MediaBox",
                lopdf::Object::Array(vec![0.into(), 0.into(), 612.into(), 792.into()]),
            );
            doc.objects.insert(page_id, lopdf::Object::Dictionary(page));
            page_ids.push(lopdf::Object::Reference(page_id));
        }
        let mut pages = lopdf::Dictionary::new();
        pages.set("Type", "Pages");
        pages.set("Kids", lopdf::Object::Array(page_ids));
        pages.set("Count", 10i64);
        doc.objects
            .insert(pages_id, lopdf::Object::Dictionary(pages));
        let catalog_id = doc.new_object_id();
        let mut catalog = lopdf::Dictionary::new();
        catalog.set("Type", "Catalog");
        catalog.set("Pages", pages_id);
        doc.objects
            .insert(catalog_id, lopdf::Object::Dictionary(catalog));
        doc.trailer.set("Root", catalog_id);
        doc.save(&source).unwrap();

        let output = tmp.path().join("out.pdf");
        let links = tmp.path().join("bin");
        std::fs::create_dir_all(&links).unwrap();
        let resolver = crate::test_fixture::bundled_resolver(&links);
        crate::test_fixture::require_bundled(&resolver, "gs");
        // The resource dir is passed rather than left `None`. Only the packaged
        // app supplies it in production, so `-sGenericResourceDir` — the whole
        // reason `gs_generic_resource_dir_arg` exists — was built by a unit
        // test and never once handed to a real gs.
        let gs_resources = crate::test_fixture::bundled_gs_resource_dir();
        compress(
            &resolver,
            Some(gs_resources.as_path()),
            &source,
            &output,
            PdfQuality::Screen,
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .expect("the bundled gs must succeed for this ignored test");
        assert!(output.exists());
    }
}
