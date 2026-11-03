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
/// `gs_resource_dir` points at the bundled Resource/lib/iccprofiles tree;
/// `gs_env::apply_gs_resources` turns it into gs's search path. `None` is
/// acceptable for dev environments where gs is on PATH with its compile-time
/// resource dir intact.
///
/// `pids` and `job_id` together enable v0.2.0 pause/resume: when both are
/// `Some`, the spawned gs PID is registered for the duration of the call
/// via an RAII guard. Pass `None` for either to disable pause support
/// (e.g. tests, or call sites that don't go through the queue).
///
/// Ghostscript writes everything to a single output file — no incremental
/// output, so no streamed progress is available. Cancellation interrupts and
/// reaps the child; completed output is published without replacing files.
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
    if cancel.is_cancelled() {
        return Err(PdfError::Cancelled);
    }
    let bin = resolver
        .resolve("gs")
        .map_err(|e| PdfError::Ghostscript(format!("gs binary not found: {e}")))?;

    if cancel.is_cancelled() {
        return Err(PdfError::Cancelled);
    }

    let mut cmd = Command::new(&bin.path);
    if let Some(dir) = gs_resource_dir {
        crate::gs_env::apply_gs_resources(&mut cmd, dir).map_err(|e| {
            PdfError::Ghostscript(format!("Ghostscript can't search {}: {e}", dir.display()))
        })?;
    }

    let destination = goop_core::output::OutputDestination::explicit(output.to_path_buf());
    let staged = goop_core::output::StagedOutput::new(output)?;
    let output = staged.path();
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    cmd.arg("-sDEVICE=pdfwrite")
        .arg("-dCompatibilityLevel=1.4")
        .arg(format!("-dPDFSETTINGS={}", pdf_settings_flag(quality)))
        .arg("-dNOPAUSE")
        .arg("-dQUIET")
        .arg("-dBATCH")
        .arg(gs_output_arg(output))
        .arg(input)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = cmd.kill_on_drop(true).spawn().map_err(PdfError::Io)?;
    // Phase G: register the gs child PID for pause/resume. RAII guard
    // unregisters on Drop (covers success, error, cancel, panic).
    let _pid_guard = match (pids.as_ref(), job_id, child.id()) {
        (Some(reg), Some(id), Some(pid)) => Some(PidGuard::new(reg.clone(), id, pid)),
        _ => None,
    };

    use tokio::io::AsyncReadExt;
    let mut stderr = child.stderr.take().expect("stderr was piped");
    let mut tail = Vec::new();
    let mut buffer = [0u8; 4096];
    let mut stderr_done = false;
    let status = loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                let _ = child.start_kill(); let _ = child.wait().await;
                return Err(PdfError::Cancelled);
            }
            status = child.wait() => break status?,
            count = stderr.read(&mut buffer), if !stderr_done => {
                let count = count?;
                stderr_done = count == 0;
                append_tail(&mut tail, &buffer[..count]);
            }
        }
    };
    let drain = async {
        while !stderr_done {
            let count = stderr.read(&mut buffer).await?;
            stderr_done = count == 0;
            if stderr_done {
                break;
            }
            append_tail(&mut tail, &buffer[..count]);
        }
        Ok::<(), std::io::Error>(())
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(PdfError::Cancelled),
        _ = tokio::time::timeout(std::time::Duration::from_secs(1), drain) => {},
    }
    if !status.success() {
        return Err(PdfError::Ghostscript(
            String::from_utf8_lossy(&tail).into_owned(),
        ));
    }
    staged.publish(&destination, None, false, &cancel)?;
    Ok(())
}

fn gs_output_arg(output: &Path) -> String {
    let escaped = output.display().to_string().replace('%', "%%");
    format!("-sOutputFile={escaped}")
}

fn append_tail(tail: &mut Vec<u8>, bytes: &[u8]) {
    tail.extend_from_slice(bytes);
    if tail.len() > 8192 {
        tail.drain(..tail.len() - 8192);
    }
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
        // reason `gs_env::apply_gs_resources` exists — was built by a unit
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

#[cfg(all(test, unix))]
mod reliability_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const EXEC_PROBE_ARG: &str = "--goop-exec-probe";

    /// Linux refuses to run a file another process holds open for writing,
    /// and a sibling test's fork can inherit this script's write handle until
    /// its own exec. Probe the script, retrying only that refusal, so the
    /// test's own spawn never sees "Text file busy".
    fn fixture(body: &str) -> (tempfile::TempDir, BinaryResolver) {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("gs");
        std::fs::write(
            &binary,
            format!("#!/bin/sh\n[ \"$1\" = {EXEC_PROBE_ARG} ] && exit 0\n{body}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        wait_until_executable(&binary);
        let resolver = BinaryResolver::new(dir.path().to_path_buf());
        (dir, resolver)
    }

    fn wait_until_executable(path: &Path) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match std::process::Command::new(path)
                .arg(EXEC_PROBE_ARG)
                .status()
            {
                Ok(status) => {
                    assert!(status.success(), "readiness probe exited {status}");
                    return;
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::ExecutableFileBusy
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(e) => panic!("{} never became runnable: {e}", path.display()),
            }
        }
    }
    #[tokio::test]
    async fn ghostscript_failure_keeps_original() {
        let (dir,resolver)=fixture("for arg do case $arg in -sOutputFile=*) out=${arg#-sOutputFile=};; esac; done; printf partial > \"$out\"; exit 1");
        let output = dir.path().join("out.pdf");
        std::fs::write(&output, b"original").unwrap();
        assert!(compress(
            &resolver,
            None,
            &dir.path().join("input.pdf"),
            &output,
            PdfQuality::Screen,
            CancellationToken::new(),
            None,
            None
        )
        .await
        .is_err());
        assert_eq!(std::fs::read(output).unwrap(), b"original");
    }
    #[tokio::test]
    async fn ghostscript_large_stderr_does_not_deadlock() {
        // 512 KiB on stderr overfills the pipe, so a reader that waits for exit
        // before draining deadlocks. The watchdog only has to outlast a slow
        // spawn on a loaded runner: a deadlock never finishes at all.
        let (dir, resolver) = fixture("dd if=/dev/zero bs=65536 count=8 >&2 2>/dev/null; exit 1");
        let output = dir.path().join("out.pdf");
        let started = std::time::Instant::now();
        let result = tokio::time::timeout(
            DEADLOCK_WATCHDOG,
            compress(
                &resolver,
                None,
                &dir.path().join("input.pdf"),
                &output,
                PdfQuality::Screen,
                CancellationToken::new(),
                None,
                None,
            ),
        )
        .await;
        let elapsed = started.elapsed();
        // gs keeps the last 8 KiB of stderr, and this one wrote 512 KiB.
        let outcome = match &result {
            Ok(Err(PdfError::Ghostscript(tail))) if tail.len() == 8192 => None,
            Ok(Err(PdfError::Ghostscript(tail))) => Some(format!(
                "Ghostscript error with a {}-byte stderr tail",
                tail.len()
            )),
            Ok(other) => Some(format!("{other:?}")),
            Err(_) => Some(format!("no result within {DEADLOCK_WATCHDOG:?}")),
        };
        assert!(
            outcome.is_none(),
            "after {elapsed:?}: {}",
            outcome.unwrap_or_default()
        );
        assert!(!output.exists());
    }

    const DEADLOCK_WATCHDOG: std::time::Duration = std::time::Duration::from_secs(30);

    #[tokio::test]
    async fn ghostscript_gets_the_bundled_search_path_in_gs_lib() {
        let (dir, resolver) = fixture(
            "for arg do case $arg in -sOutputFile=*) out=${arg#-sOutputFile=};; esac; done; printf '%s' \"$GS_LIB\" > \"$out\"",
        );
        let resources = dir.path().join("gs-resources");
        let output = dir.path().join("out.pdf");
        compress(
            &resolver,
            Some(resources.as_path()),
            &dir.path().join("input.pdf"),
            &output,
            PdfQuality::Screen,
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .unwrap();
        let r = resources.display();
        assert_eq!(
            std::fs::read_to_string(output).unwrap(),
            format!("{r}/Resource/Init:{r}/lib:{r}/Resource/Font:{r}/iccprofiles")
        );
    }

    #[tokio::test]
    async fn a_resource_dir_gs_cannot_search_fails_before_spawning() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("gs"), b"not executable").unwrap();
        let resolver = BinaryResolver::new(dir.path().to_path_buf());
        let resources = dir.path().join("a:b").join("gs-resources");
        let output = dir.path().join("out.pdf");
        let result = compress(
            &resolver,
            Some(resources.as_path()),
            &dir.path().join("input.pdf"),
            &output,
            PdfQuality::Screen,
            CancellationToken::new(),
            None,
            None,
        )
        .await;
        assert!(
            matches!(result, Err(PdfError::Ghostscript(ref m)) if m.contains("gs-resources")),
            "{result:?}"
        );
        assert!(!output.exists());
    }
}
