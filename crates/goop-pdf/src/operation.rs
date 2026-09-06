//! Staged PDF job execution.
use crate::{
    compress as pdf_compress, delete_pages as pdf_delete_pages,
    extract_images as pdf_extract_images, extract_pages as pdf_extract_pages,
    extract_text as pdf_extract_text, images_to_pdf as pdf_images_to_pdf,
    insert_blank as pdf_insert_blank, merge as pdf_merge, metadata as pdf_metadata,
    ocr as pdf_ocr_mod, ocr_image as pdf_ocr_image, recognize as pdf_recognize,
    reorder as pdf_reorder, rotate as pdf_rotate, split as pdf_split,
};
use goop_core::output::{source_bytes, OutputDestination, StagedOutput};
use goop_core::{GoopError, JobId, JobResult, PdfOperation, PidRegistry};
use goop_sidecar::BinaryResolver;
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

pub struct Context {
    pub resolver: Arc<BinaryResolver>,
    pub gs_dir: Option<PathBuf>,
    pub tessdata_user: PathBuf,
    pub tessdata_bundled: Option<PathBuf>,
    pub pids: Arc<dyn PidRegistry>,
    pub id: JobId,
}

pub async fn run(
    mut op: PdfOperation,
    context: Context,
    cancel: CancellationToken,
) -> Result<JobResult, GoopError> {
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    let started = std::time::Instant::now();
    let allow_empty = matches!(
        &op,
        PdfOperation::ExtractText { .. }
            | PdfOperation::ImageOcr {
                output_kind: goop_core::pdf::ImageOcrOutput::Text,
                ..
            }
            | PdfOperation::RecognizeText {
                output_kind: goop_core::pdf::ImageOcrOutput::Text,
                ..
            }
    );
    let (inputs, output, folder) = match &mut op {
        PdfOperation::Merge {
            inputs,
            output_path,
        }
        | PdfOperation::ImagesToPdf {
            inputs,
            output_path,
        }
        | PdfOperation::ImageOcr {
            inputs,
            output_path,
            ..
        } => (
            inputs.iter().map(PathBuf::from).collect::<Vec<_>>(),
            output_path,
            false,
        ),
        PdfOperation::Split {
            input, output_dir, ..
        }
        | PdfOperation::ExtractImages {
            input, output_dir, ..
        } => (vec![PathBuf::from(&*input)], output_dir, true),
        PdfOperation::Compress {
            input, output_path, ..
        }
        | PdfOperation::ExtractPages {
            input, output_path, ..
        }
        | PdfOperation::Rotate {
            input, output_path, ..
        }
        | PdfOperation::Reorder {
            input, output_path, ..
        }
        | PdfOperation::DeletePages {
            input, output_path, ..
        }
        | PdfOperation::InsertBlank {
            input, output_path, ..
        }
        | PdfOperation::SetMetadata {
            input, output_path, ..
        }
        | PdfOperation::ExtractText {
            input, output_path, ..
        }
        | PdfOperation::PdfOcr {
            input, output_path, ..
        }
        | PdfOperation::RecognizeText {
            input, output_path, ..
        } => (vec![PathBuf::from(&*input)], output_path, false),
    };
    let source_bytes = source_bytes(&inputs)?;
    let requested = goop_core::path::expand(output);
    let destination = if folder {
        let stem = inputs
            .first()
            .and_then(|p| p.file_stem())
            .and_then(|s| s.to_str())
            .unwrap_or("pdf");
        let name = format!("{stem}-results");
        OutputDestination::automatic(requested.join(&name), name, String::new())
    } else {
        OutputDestination::explicit(requested)
    };
    let staged = StagedOutput::new(&destination.path)?;
    *output = staged.path().to_string_lossy().into_owned();
    let worker_cancel = cancel.clone();
    // The detached task retains staging until any blocking renderer finishes.
    // Only this awaiting caller has the destination and can publish.
    let mut worker = tokio::spawn(async move {
        let manifest = execute(op, context, worker_cancel.clone()).await?;
        if worker_cancel.is_cancelled() {
            return Err(GoopError::Cancelled);
        }
        if folder {
            staged.validate_manifest(&manifest)?;
        } else {
            staged.validate(None, allow_empty)?;
        }
        Ok::<_, GoopError>(staged)
    });
    let staged = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(GoopError::Cancelled),
        result = &mut worker => result.map_err(|e| GoopError::Queue(format!("PDF worker failed: {e}")))??,
    };
    let output = staged.publish(&destination, None, allow_empty, &cancel)?;
    Ok(JobResult {
        output_path: Some(output.path.to_string_lossy().into_owned()),
        bytes: Some(output.bytes),
        duration_ms: started.elapsed().as_millis() as u64,
        result_kind: output.result_kind,
        file_count: output.file_count,
        source_bytes: Some(source_bytes),
        target_bytes: None,
        reencoded: None,
    })
}

async fn execute(
    op: PdfOperation,
    context: Context,
    cancel: CancellationToken,
) -> Result<Vec<PathBuf>, GoopError> {
    let Context {
        resolver: r,
        gs_dir,
        tessdata_user,
        tessdata_bundled,
        pids,
        id,
    } = context;
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    match op {
        PdfOperation::Merge {
            inputs,
            output_path,
        } => {
            let out = PathBuf::from(output_path);
            let out_for_task = out.clone();
            tokio::task::spawn_blocking(move || {
                let input_paths: Vec<PathBuf> = inputs.into_iter().map(PathBuf::from).collect();
                let input_refs: Vec<&std::path::Path> =
                    input_paths.iter().map(|p| p.as_path()).collect();
                pdf_merge::merge(&input_refs, &out_for_task)
            })
            .await
            .map_err(|e| GoopError::Queue(e.to_string()))?
            .map_err(GoopError::from)?;
            Ok(vec![out])
        }
        PdfOperation::Split {
            input,
            ranges,
            output_dir,
        } => {
            let in_path = PathBuf::from(input);
            let dir = PathBuf::from(output_dir);
            let dir_for_task = dir.clone();
            let outputs = tokio::task::spawn_blocking(move || {
                pdf_split::split_cancellable(&in_path, &ranges, &dir_for_task, &cancel)
            })
            .await
            .map_err(|e| GoopError::Queue(e.to_string()))?
            .map_err(GoopError::from)?;
            Ok(outputs)
        }
        PdfOperation::Compress {
            input,
            output_path,
            quality,
        } => {
            let in_path = PathBuf::from(input);
            let out = PathBuf::from(output_path);
            pdf_compress::compress(
                &r,
                gs_dir.as_deref(),
                &in_path,
                &out,
                quality,
                cancel,
                Some(pids),
                Some(id),
            )
            .await
            .map_err(GoopError::from)?;
            Ok(vec![out])
        }
        PdfOperation::ExtractPages {
            input,
            ranges,
            output_path,
        } => {
            let in_path = PathBuf::from(input);
            let out = PathBuf::from(output_path);
            let out_for_task = out.clone();
            tokio::task::spawn_blocking(move || {
                pdf_extract_pages::extract_pages(&in_path, &ranges, &out_for_task)
            })
            .await
            .map_err(|e| GoopError::Queue(e.to_string()))?
            .map_err(GoopError::from)?;
            Ok(vec![out])
        }
        PdfOperation::DeletePages {
            input,
            pages,
            output_path,
        } => {
            let in_path = PathBuf::from(input);
            let out = PathBuf::from(output_path);
            let out_for_task = out.clone();
            tokio::task::spawn_blocking(move || {
                pdf_delete_pages::delete_pages(&in_path, &pages, &out_for_task)
            })
            .await
            .map_err(|e| GoopError::Queue(e.to_string()))?
            .map_err(GoopError::from)?;
            Ok(vec![out])
        }
        PdfOperation::InsertBlank {
            input,
            positions,
            output_path,
        } => {
            let in_path = PathBuf::from(input);
            let out = PathBuf::from(output_path);
            let out_for_task = out.clone();
            tokio::task::spawn_blocking(move || {
                pdf_insert_blank::insert_blank(&in_path, &positions, &out_for_task)
            })
            .await
            .map_err(|e| GoopError::Queue(e.to_string()))?
            .map_err(GoopError::from)?;
            Ok(vec![out])
        }
        PdfOperation::SetMetadata {
            input,
            metadata,
            output_path,
        } => {
            let in_path = PathBuf::from(input);
            let out = PathBuf::from(output_path);
            let out_for_task = out.clone();
            tokio::task::spawn_blocking(move || {
                pdf_metadata::set_metadata(&in_path, &metadata, &out_for_task)
            })
            .await
            .map_err(|e| GoopError::Queue(e.to_string()))?
            .map_err(GoopError::from)?;
            Ok(vec![out])
        }
        PdfOperation::Rotate {
            input,
            rotations,
            output_path,
        } => {
            let in_path = PathBuf::from(input);
            let out = PathBuf::from(output_path);
            let out_for_task = out.clone();
            tokio::task::spawn_blocking(move || {
                pdf_rotate::rotate(&in_path, &rotations, &out_for_task)
            })
            .await
            .map_err(|e| GoopError::Queue(e.to_string()))?
            .map_err(GoopError::from)?;
            Ok(vec![out])
        }
        PdfOperation::Reorder {
            input,
            order,
            output_path,
        } => {
            let in_path = PathBuf::from(input);
            let out = PathBuf::from(output_path);
            let out_for_task = out.clone();
            tokio::task::spawn_blocking(move || {
                pdf_reorder::reorder(&in_path, &order, &out_for_task)
            })
            .await
            .map_err(|e| GoopError::Queue(e.to_string()))?
            .map_err(GoopError::from)?;
            Ok(vec![out])
        }
        // Remaining v0.2.4 stubs — replaced in Phases 4-7.
        // Error messages use the snake_case wire discriminator so log
        // scrapers can match against the same string they see on the IPC.
        PdfOperation::ExtractText { input, output_path } => {
            let in_path = PathBuf::from(input);
            let out = PathBuf::from(output_path);
            pdf_extract_text::extract_text(&r, &in_path, &out, cancel, Some(pids), Some(id))
                .await
                .map_err(GoopError::from)?;
            Ok(vec![out])
        }
        PdfOperation::ExtractImages {
            input,
            output_dir,
            format,
            dpi,
        } => {
            let in_path = PathBuf::from(input);
            let out_dir = PathBuf::from(output_dir);
            let probe_input = in_path.clone();
            let expected_pages =
                tokio::task::spawn_blocking(move || crate::probe::probe(&probe_input))
                    .await
                    .map_err(|e| GoopError::Queue(e.to_string()))??
                    .pages;
            let outs = pdf_extract_images::extract_images(
                &r,
                &in_path,
                &out_dir,
                format,
                dpi,
                cancel,
                Some(pids),
                Some(id),
            )
            .await
            .map_err(GoopError::from)?;
            if outs.len() != expected_pages as usize
                || outs.iter().enumerate().any(|(index, path)| {
                    path.file_name().and_then(|name| name.to_str())
                        != Some(format!("page-{}.{}", index + 1, format.file_extension()).as_str())
                })
            {
                return Err(GoopError::InvalidRequest(
                    "PDF renderer did not produce every expected page".into(),
                ));
            }
            Ok(outs)
        }
        PdfOperation::ImagesToPdf {
            inputs,
            output_path,
        } => {
            let out = PathBuf::from(output_path);
            let out_for_task = out.clone();
            tokio::task::spawn_blocking(move || {
                let in_paths: Vec<PathBuf> = inputs.into_iter().map(PathBuf::from).collect();
                let refs: Vec<&std::path::Path> = in_paths.iter().map(|p| p.as_path()).collect();
                pdf_images_to_pdf::images_to_pdf(&refs, &out_for_task)
            })
            .await
            .map_err(|e| GoopError::Queue(e.to_string()))?
            .map_err(GoopError::from)?;
            Ok(vec![out])
        }
        PdfOperation::PdfOcr {
            input,
            output_path,
            lang,
        } => {
            let in_path = PathBuf::from(input);
            let out = PathBuf::from(output_path);
            let mut dirs: Vec<&std::path::Path> = vec![tessdata_user.as_path()];
            if let Some(b) = tessdata_bundled.as_ref() {
                dirs.push(b.as_path());
            }
            pdf_ocr_mod::ocr(
                &r,
                &dirs,
                &in_path,
                &out,
                &lang,
                cancel,
                Some(pids),
                Some(id),
            )
            .await
            .map_err(GoopError::from)?;
            Ok(vec![out])
        }
        PdfOperation::ImageOcr {
            inputs,
            output_path,
            output_kind,
            lang,
        } => {
            let out = PathBuf::from(output_path);
            let in_paths: Vec<PathBuf> = inputs.into_iter().map(PathBuf::from).collect();
            let in_refs: Vec<&std::path::Path> = in_paths.iter().map(|p| p.as_path()).collect();
            let mut dirs: Vec<&std::path::Path> = vec![tessdata_user.as_path()];
            if let Some(b) = tessdata_bundled.as_ref() {
                dirs.push(b.as_path());
            }
            pdf_ocr_image::ocr_image(
                &r,
                &dirs,
                &in_refs,
                &out,
                output_kind,
                &lang,
                cancel,
                Some(pids),
                Some(id),
            )
            .await
            .map_err(GoopError::from)?;
            Ok(vec![out])
        }
        PdfOperation::RecognizeText {
            input,
            output_path,
            output_kind,
            lang,
        } => {
            let in_path = PathBuf::from(input);
            let out = PathBuf::from(output_path);
            let mut dirs: Vec<&std::path::Path> = vec![tessdata_user.as_path()];
            if let Some(b) = tessdata_bundled.as_ref() {
                dirs.push(b.as_path());
            }
            let (_out, method) = pdf_recognize::recognize_text(
                &r,
                &dirs,
                &in_path,
                &out,
                output_kind,
                &lang,
                cancel,
                Some(pids),
                Some(id),
            )
            .await
            .map_err(GoopError::from)?;
            tracing::info!(?method, "recognize_text routed input");
            Ok(vec![out])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context(dir: &std::path::Path) -> Context {
        Context {
            resolver: Arc::new(BinaryResolver::new(dir.join("bin"))),
            gs_dir: None,
            tessdata_user: dir.join("tessdata"),
            tessdata_bundled: None,
            pids: Arc::new(goop_core::NoopRegistry),
            id: goop_core::JobId::new(),
        }
    }
    #[tokio::test]
    async fn failed_split_exposes_no_partial_batch() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.pdf");
        crate::test_fixture::write_blank_pdf(&input, 2);
        let output = dir.path().join("out");
        let op = PdfOperation::Split {
            input: input.display().to_string(),
            output_dir: output.display().to_string(),
            ranges: vec![
                goop_core::PageRange { start: 1, end: 1 },
                goop_core::PageRange { start: 9, end: 9 },
            ],
        };
        assert!(run(op, context(dir.path()), CancellationToken::new())
            .await
            .is_err());
        assert_eq!(std::fs::read_dir(output).unwrap().count(), 0);
    }
    #[tokio::test]
    async fn rotate_preserves_existing_output() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.pdf");
        crate::test_fixture::write_blank_pdf(&input, 1);
        let output = dir.path().join("out.pdf");
        std::fs::write(&output, b"original").unwrap();
        let op = PdfOperation::Rotate {
            input: input.display().to_string(),
            output_path: output.display().to_string(),
            rotations: vec![],
        };
        assert!(run(op, context(dir.path()), CancellationToken::new())
            .await
            .is_err());
        assert_eq!(std::fs::read(output).unwrap(), b"original");
    }
}
