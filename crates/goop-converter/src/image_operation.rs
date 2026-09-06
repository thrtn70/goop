//! Cancellation-aware publication of secondary image operations.
use goop_core::output::{source_bytes, OutputDestination, StagedOutput};
use goop_core::{GoopError, ImageOperation, JobResult};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

pub async fn run(
    mut op: ImageOperation,
    cancel: CancellationToken,
) -> Result<JobResult, GoopError> {
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    let started = std::time::Instant::now();
    let (inputs, output, folder) = match &mut op {
        ImageOperation::Rotate {
            input, output_path, ..
        }
        | ImageOperation::Resize {
            input, output_path, ..
        }
        | ImageOperation::Crop {
            input, output_path, ..
        }
        | ImageOperation::Watermark {
            input, output_path, ..
        } => (vec![PathBuf::from(&*input)], output_path, false),
        ImageOperation::Recompress {
            inputs, output_dir, ..
        } => (inputs.iter().map(PathBuf::from).collect(), output_dir, true),
        ImageOperation::AppIcon {
            input, output_dir, ..
        } => (vec![PathBuf::from(&*input)], output_dir, true),
    };
    let source_bytes = source_bytes(&inputs)?;
    let requested = goop_core::path::expand(output);
    let destination = if folder {
        let stem = inputs
            .first()
            .and_then(|p| p.file_stem())
            .and_then(|s| s.to_str())
            .unwrap_or("images");
        let name = format!("{stem}-results");
        OutputDestination::automatic(requested.join(&name), name, String::new())
    } else {
        OutputDestination::explicit(requested)
    };
    let staged = StagedOutput::new(&destination.path)?;
    *output = staged.path().to_string_lossy().into_owned();
    let worker_cancel = cancel.clone();
    let worker = tokio::task::spawn_blocking(move || {
        if worker_cancel.is_cancelled() {
            return Err(GoopError::Cancelled);
        }
        let manifest = render(op, &worker_cancel)?;
        if worker_cancel.is_cancelled() {
            return Err(GoopError::Cancelled);
        }
        if folder {
            staged.validate_manifest(&manifest)?;
        } else {
            staged.validate(None, false)?;
        }
        Ok::<_, GoopError>(staged)
    });
    let output = publish_worker(worker, destination, cancel).await?;
    Ok(JobResult {
        output_path: Some(output.path.to_string_lossy().into_owned()),
        bytes: Some(output.bytes),
        duration_ms: started.elapsed().as_millis() as u64,
        result_kind: output.result_kind,
        file_count: output.file_count,
        source_bytes: Some(source_bytes),
        target_bytes: None,
        reencoded: Some(true),
    })
}

async fn publish_worker(
    mut worker: tokio::task::JoinHandle<Result<StagedOutput, GoopError>>,
    destination: OutputDestination,
    cancel: CancellationToken,
) -> Result<goop_core::output::PublishedOutput, GoopError> {
    // The blocking closure owns staging and can never publish it. A cancelled
    // await can leave work finishing privately, but no late output appears.
    let staged = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(GoopError::Cancelled),
        result = &mut worker => result.map_err(|e| GoopError::Queue(format!("image worker failed: {e}")))??,
    };
    staged.publish(&destination, None, false, &cancel)
}

fn render(op: ImageOperation, cancel: &CancellationToken) -> Result<Vec<PathBuf>, GoopError> {
    match op {
        ImageOperation::Rotate {
            input,
            output_path,
            degrees,
        } => {
            crate::image_rotate::rotate(Path::new(&input), degrees, Path::new(&output_path))?;
            Ok(vec![output_path.into()])
        }
        ImageOperation::Resize {
            input,
            output_path,
            width,
            height,
            mode,
        } => {
            crate::image_resize::resize(
                Path::new(&input),
                width,
                height,
                mode,
                Path::new(&output_path),
            )?;
            Ok(vec![output_path.into()])
        }
        ImageOperation::Crop {
            input,
            output_path,
            rect,
        } => {
            crate::image_crop::crop(Path::new(&input), rect, Path::new(&output_path))?;
            Ok(vec![output_path.into()])
        }
        ImageOperation::Watermark {
            input,
            output_path,
            spec,
        } => {
            crate::image_watermark::watermark(Path::new(&input), &spec, Path::new(&output_path))?;
            Ok(vec![output_path.into()])
        }
        ImageOperation::Recompress {
            inputs,
            output_dir,
            quality,
        } => {
            let mut names = std::collections::HashSet::new();
            for input in &inputs {
                let name = Path::new(input)
                    .file_name()
                    .ok_or_else(|| GoopError::InvalidRequest("input has no filename".into()))?
                    .to_string_lossy()
                    .to_lowercase();
                if !names.insert(name) {
                    return Err(GoopError::InvalidRequest("Images have duplicate filenames. Rename them before recompressing together.".into()));
                }
            }
            let refs: Vec<&Path> = inputs.iter().map(Path::new).collect();
            crate::image_recompress::recompress_cancellable(
                &refs,
                Path::new(&output_dir),
                quality,
                cancel,
            )
        }
        ImageOperation::AppIcon {
            input,
            output_dir,
            platforms,
        } => crate::image_app_icon::app_icon_cancellable(
            Path::new(&input),
            Path::new(&output_dir),
            &platforms,
            cancel,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelled_blocking_image_cannot_publish_later() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("out.png");
        let staged = StagedOutput::new(&destination).unwrap();
        let (release, wait) = std::sync::mpsc::channel();
        let worker = tokio::task::spawn_blocking(move || {
            wait.recv().unwrap();
            std::fs::write(staged.path(), b"finished privately").unwrap();
            Ok(staged)
        });
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            publish_worker(
                worker,
                OutputDestination::explicit(destination.clone()),
                cancel
            )
            .await,
            Err(GoopError::Cancelled)
        ));
        release.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while std::fs::read_dir(dir.path()).unwrap().count() != 0 {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!destination.exists());
    }
    #[tokio::test]
    async fn recompress_reports_actual_unique_folder_and_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("source.png");
        image::RgbImage::new(8, 8).save(&input).unwrap();
        let out = dir.path().join("out");
        std::fs::create_dir_all(out.join("source-results")).unwrap();
        std::fs::write(out.join("source-results/original"), b"original").unwrap();
        let result = run(
            ImageOperation::Recompress {
                inputs: vec![input.display().to_string()],
                output_dir: out.display().to_string(),
                quality: 50,
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let actual = PathBuf::from(result.output_path.unwrap());
        assert_eq!(actual, out.join("source-results (1)"));
        assert_eq!(
            result.bytes,
            Some(std::fs::metadata(actual.join("source.png")).unwrap().len())
        );
        assert_eq!(
            result.source_bytes,
            Some(std::fs::metadata(input).unwrap().len())
        );
        assert_eq!(result.file_count, 1);
    }
    #[tokio::test]
    async fn batch_failure_withholds_all_outputs() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("good.png");
        image::RgbImage::new(8, 8).save(&input).unwrap();
        let bad = dir.path().join("bad.png");
        std::fs::write(&bad, b"invalid").unwrap();
        let out = dir.path().join("out");
        let op = ImageOperation::Recompress {
            inputs: vec![input.display().to_string(), bad.display().to_string()],
            output_dir: out.display().to_string(),
            quality: 50,
        };
        assert!(run(op, CancellationToken::new()).await.is_err());
        assert_eq!(std::fs::read_dir(out).unwrap().count(), 0);
    }
    #[tokio::test]
    async fn cancelled_image_preserves_destination() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("good.png");
        image::RgbImage::new(8, 8).save(&input).unwrap();
        let out = dir.path().join("out.png");
        std::fs::write(&out, b"original").unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let op = ImageOperation::Rotate {
            input: input.display().to_string(),
            output_path: out.display().to_string(),
            degrees: goop_core::RotationDegrees::Cw90,
        };
        assert!(matches!(run(op, cancel).await, Err(GoopError::Cancelled)));
        assert_eq!(std::fs::read(out).unwrap(), b"original");
    }
}
