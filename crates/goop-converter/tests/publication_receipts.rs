mod common;

use common::{request, SilentSink};
use goop_converter::{ConversionBackend, ImageMagickBackend};
use goop_core::publication::PublicationObserver;
use goop_core::{CompressMode, GoopError, JobId, JobResult, TargetFormat};
use goop_sidecar::BinaryResolver;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Observer {
    intents: Mutex<Vec<JobResult>>,
    receipts: Mutex<Vec<JobResult>>,
    fail_intent: bool,
    fail_receipt: bool,
    cancel_after_intent: Option<CancellationToken>,
    cancel_after_receipt: Option<CancellationToken>,
}

impl PublicationObserver for Observer {
    fn before_publish(
        &self,
        staged: &Path,
        destination: &Path,
        result: &JobResult,
    ) -> Result<(), GoopError> {
        assert!(staged.is_file());
        assert_eq!(result.output_path.as_deref(), destination.to_str());
        assert_eq!(result.bytes, Some(std::fs::metadata(staged)?.len()));
        self.intents.lock().unwrap().push(result.clone());
        if let Some(cancel) = &self.cancel_after_intent {
            cancel.cancel();
        }
        if self.fail_intent {
            return Err(GoopError::Queue("intent write refused".into()));
        }
        Ok(())
    }

    fn published(&self, destination: &Path, result: &JobResult) -> Result<(), GoopError> {
        assert!(destination.is_file());
        assert_eq!(result.output_path.as_deref(), destination.to_str());
        assert_eq!(result.bytes, Some(std::fs::metadata(destination)?.len()));
        self.receipts.lock().unwrap().push(result.clone());
        if let Some(cancel) = &self.cancel_after_receipt {
            cancel.cancel();
        }
        if self.fail_receipt {
            return Err(GoopError::Queue("receipt write refused".into()));
        }
        Ok(())
    }
}

#[tokio::test(flavor = "current_thread")]
async fn publication_verification_does_not_block_async_timers() {
    struct SlowObserver(Mutex<Option<tokio::sync::oneshot::Sender<std::time::Instant>>>);
    impl PublicationObserver for SlowObserver {
        fn before_publish(&self, _: &Path, _: &Path, _: &JobResult) -> Result<(), GoopError> {
            self.0
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .send(std::time::Instant::now())
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(250));
            Ok(())
        }
        fn published(&self, _: &Path, _: &JobResult) -> Result<(), GoopError> {
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.png");
    let output = dir.path().join("out.webp");
    image::RgbImage::new(8, 8).save(&input).unwrap();
    let req = request(&input, &output, TargetFormat::Webp, None);
    let resolver = BinaryResolver::new(dir.path().to_owned());
    let (entered, started) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        ImageMagickBackend::new(&resolver, Arc::new(SilentSink))
            .with_publication_observer(Arc::new(SlowObserver(Mutex::new(Some(entered)))))
            .convert(JobId::new(), &req, CancellationToken::new())
            .await
    });
    let started = started.await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let elapsed = started.elapsed();
    task.await.unwrap().unwrap();
    assert!(
        elapsed < std::time::Duration::from_millis(150),
        "async timer was blocked for {elapsed:?}"
    );
    assert!(output.is_file());
}

#[tokio::test]
async fn image_receipt_has_complete_compression_result_before_publication() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.jpg");
    let output = dir.path().join("out.jpg");
    image::RgbImage::new(24, 16).save(&input).unwrap();
    let resolver = BinaryResolver::new(dir.path().to_owned());
    let observer = Arc::new(Observer::default());
    let mut req = request(&input, &output, TargetFormat::Jpeg, None);
    req.compress_mode = Some(CompressMode::TargetSizeBytes(100_000));
    let result = ImageMagickBackend::new(&resolver, Arc::new(SilentSink))
        .with_publication_observer(observer.clone())
        .convert(JobId::new(), &req, CancellationToken::new())
        .await
        .unwrap();
    let receipt = observer.receipts.lock().unwrap()[0].clone();
    assert_eq!(
        receipt,
        goop_converter::backend::conversion_job_result(&result)
    );
    assert!(receipt.compression_execution.is_some());
    assert_eq!(observer.intents.lock().unwrap()[0], receipt);
}

#[tokio::test]
async fn image_journal_failure_before_move_withholds_output() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.png");
    let output = dir.path().join("out.webp");
    image::RgbImage::new(8, 8).save(&input).unwrap();
    let resolver = BinaryResolver::new(dir.path().to_owned());
    let observer = Arc::new(Observer {
        fail_intent: true,
        ..Observer::default()
    });
    let result = ImageMagickBackend::new(&resolver, Arc::new(SilentSink))
        .with_publication_observer(observer.clone())
        .convert(
            JobId::new(),
            &request(&input, &output, TargetFormat::Webp, None),
            CancellationToken::new(),
        )
        .await;
    assert!(result.is_err());
    assert!(!output.exists());
    assert!(observer.receipts.lock().unwrap().is_empty());
}

#[tokio::test]
async fn image_receipt_failure_retains_published_output() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.png");
    let output = dir.path().join("out.webp");
    image::RgbImage::new(8, 8).save(&input).unwrap();
    let resolver = BinaryResolver::new(dir.path().to_owned());
    let observer = Arc::new(Observer {
        fail_receipt: true,
        ..Observer::default()
    });
    let result = ImageMagickBackend::new(&resolver, Arc::new(SilentSink))
        .with_publication_observer(observer)
        .convert(
            JobId::new(),
            &request(&input, &output, TargetFormat::Webp, None),
            CancellationToken::new(),
        )
        .await;
    assert!(result.is_err());
    assert_eq!(image::image_dimensions(&output).unwrap(), (8, 8));
}

#[tokio::test]
async fn image_cancellation_after_intent_withholds_move_but_after_receipt_is_done() {
    for before_move in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.png");
        let output = dir.path().join("out.webp");
        image::RgbImage::new(8, 8).save(&input).unwrap();
        let resolver = BinaryResolver::new(dir.path().to_owned());
        let cancel = CancellationToken::new();
        let observer = Arc::new(Observer {
            cancel_after_intent: before_move.then(|| cancel.clone()),
            cancel_after_receipt: (!before_move).then(|| cancel.clone()),
            ..Observer::default()
        });
        let result = ImageMagickBackend::new(&resolver, Arc::new(SilentSink))
            .with_publication_observer(observer)
            .convert(
                JobId::new(),
                &request(&input, &output, TargetFormat::Webp, None),
                cancel,
            )
            .await;
        assert_eq!(result.is_ok(), !before_move);
        assert_eq!(output.exists(), !before_move);
    }
}

#[tokio::test]
#[cfg(unix)]
async fn ffmpeg_receipt_matches_returned_result_and_post_move_failure_preserves_file() {
    use std::os::unix::fs::PermissionsExt;
    for fail_receipt in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        for (name, body) in [
            ("ffmpeg", "for out do :; done; printf 'encoded media' > \"$out\""),
            ("ffprobe", "printf '%s' '{\"format\":{\"duration\":\"1\",\"size\":\"6\"},\"streams\":[{\"codec_type\":\"video\",\"codec_name\":\"h264\",\"width\":16,\"height\":16}]}'"),
        ] {
            let path = bin.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let input = dir.path().join("in.mp4");
        let output = dir.path().join("out.mp4");
        std::fs::write(&input, b"source").unwrap();
        let resolver = BinaryResolver::new(bin);
        let observer = Arc::new(Observer {
            fail_receipt,
            ..Observer::default()
        });
        let result = goop_converter::FfmpegBackend::new(&resolver, Arc::new(SilentSink))
            .with_publication_observer(observer.clone())
            .convert(
                JobId::new(),
                &request(&input, &output, TargetFormat::Mp4, None),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(std::fs::read(&output).unwrap(), b"encoded media");
        if fail_receipt {
            assert!(result.is_err());
        } else {
            assert_eq!(
                observer.receipts.lock().unwrap()[0],
                goop_converter::backend::conversion_job_result(&result.unwrap())
            );
        }
    }
}
