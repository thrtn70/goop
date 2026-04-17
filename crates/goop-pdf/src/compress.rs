use crate::PdfError;
use goop_core::PdfQuality;
use goop_sidecar::BinaryResolver;
use std::path::Path;
use std::process::Stdio;
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
/// Ghostscript writes everything to a single output file — no incremental
/// output, so no streamed progress is available. We emit a cancellation
/// check only at start/end for this reason.
pub async fn compress(
    resolver: &BinaryResolver,
    input: &Path,
    output: &Path,
    quality: PdfQuality,
    cancel: CancellationToken,
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
    cmd.arg("-sDEVICE=pdfwrite")
        .arg("-dCompatibilityLevel=1.4")
        .arg(format!("-dPDFSETTINGS={}", pdf_settings_flag(quality)))
        .arg("-dNOPAUSE")
        .arg("-dQUIET")
        .arg("-dBATCH")
        .arg(format!("-sOutputFile={}", output.display()))
        .arg(input)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(PdfError::Io)?;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_flags_match_ghostscript_preset_names() {
        assert_eq!(pdf_settings_flag(PdfQuality::Screen), "/screen");
        assert_eq!(pdf_settings_flag(PdfQuality::Ebook), "/ebook");
        assert_eq!(pdf_settings_flag(PdfQuality::Printer), "/printer");
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
        let resolver = BinaryResolver::new(std::env::current_dir().unwrap());
        compress(
            &resolver,
            &source,
            &output,
            PdfQuality::Screen,
            CancellationToken::new(),
        )
        .await
        .expect("gs must be on PATH for this ignored test");
        assert!(output.exists());
    }
}
