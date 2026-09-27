#![cfg(any(target_os = "macos", target_os = "windows"))]
mod common;

use common::{request, SilentSink};
use goop_converter::{ConversionBackend, FfmpegBackend, ImageMagickBackend};
use goop_core::publication::PublicationObserver;
use goop_core::{ConvertRequest, GoopError, Job, JobKind, JobResult, JobState, TargetFormat};
use goop_queue::QueueStore;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct StopAtBoundary {
    observer: Arc<dyn PublicationObserver>,
    phase: String,
    marker: PathBuf,
}

fn wait_for_termination(marker: &Path, result: &JobResult) -> ! {
    let temporary = marker.with_extension("writing");
    let mut file = std::fs::File::create_new(&temporary).unwrap();
    file.write_all(&serde_json::to_vec(result).unwrap())
        .unwrap();
    file.sync_all().unwrap();
    drop(file);
    std::fs::rename(temporary, marker).unwrap();
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}

impl PublicationObserver for StopAtBoundary {
    fn before_publish(
        &self,
        staged: &Path,
        destination: &Path,
        result: &JobResult,
    ) -> Result<(), GoopError> {
        self.observer.before_publish(staged, destination, result)?;
        if self.phase == "intent" {
            wait_for_termination(&self.marker, result);
        }
        Ok(())
    }
    fn published(&self, destination: &Path, result: &JobResult) -> Result<(), GoopError> {
        if self.phase == "move" {
            wait_for_termination(&self.marker, result);
        }
        self.observer.published(destination, result)?;
        if self.phase == "receipt" {
            wait_for_termination(&self.marker, result);
        }
        Ok(())
    }
}

#[test]
#[ignore = "subprocess driver; invoked with an owned fixture by the parent tests"]
fn publication_child() {
    let Some(directory) = std::env::var_os("GOOP_PUBLICATION_TEST_DIRECTORY") else {
        return;
    };
    let directory = PathBuf::from(directory);
    let phase = std::env::var("GOOP_PUBLICATION_TEST_PHASE").unwrap();
    let store = QueueStore::open(&directory.join("queue.sqlite")).unwrap();
    let job = store.list().unwrap().pop().unwrap();
    let req: ConvertRequest = serde_json::from_value(job.payload.clone()).unwrap();
    let observer = Arc::new(StopAtBoundary {
        observer: store.begin_publication(job.id, &job.payload).unwrap(),
        phase,
        marker: directory.join("boundary.json"),
    });
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let resolver = common::bundled_resolver(&directory.join("bin"));
    let result = runtime
        .block_on(async {
            if req.target.is_image() {
                ImageMagickBackend::new(&resolver, Arc::new(SilentSink))
                    .with_publication_observer(observer.clone())
                    .convert(job.id, &req, CancellationToken::new())
                    .await
            } else {
                common::ffmpeg_path(&resolver);
                common::ffprobe_path(&resolver);
                FfmpegBackend::new(&resolver, Arc::new(SilentSink))
                    .with_publication_observer(observer.clone())
                    .convert(job.id, &req, CancellationToken::new())
                    .await
            }
        })
        .unwrap();
    let result = goop_converter::backend::conversion_job_result(&result);
    let committed = store
        .finalize_worker(job.id, &job.payload, &JobState::Done, Some(&result), 123)
        .unwrap();
    assert_eq!(committed.state, JobState::Done);
    wait_for_termination(&observer.marker, &result);
}

fn exercise_restart(image: bool) {
    for phase in ["intent", "move", "receipt", "done"] {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let input = dir.path().join(if image { "in.jpg" } else { "in.mp4" });
        let output = dir.path().join(if image { "out.jpg" } else { "out.mp4" });
        if image {
            image::RgbImage::from_pixel(24, 16, image::Rgb([42, 100, 180]))
                .save(&input)
                .unwrap();
        } else {
            let resolver = common::bundled_resolver(&bin);
            let status = Command::new(common::ffmpeg_path(&resolver))
                .args([
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=size=32x24:rate=5",
                    "-t",
                    "0.4",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:v",
                    "libx264",
                ])
                .arg(&input)
                .status()
                .unwrap();
            assert!(status.success());
        }
        let mut req = request(
            &input,
            &output,
            if image {
                TargetFormat::Jpeg
            } else {
                TargetFormat::Mp4
            },
            None,
        );
        if image {
            req.compress_mode = Some(goop_core::CompressMode::TargetSizeBytes(100_000));
        }
        let db = dir.path().join("queue.sqlite");
        let store = QueueStore::open(&db).unwrap();
        let job = Job::new(JobKind::Convert, serde_json::to_value(req).unwrap());
        store.insert(&job).unwrap();
        store
            .update_state(job.id, &JobState::Running, None, 1)
            .unwrap();
        drop(store);
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "publication_child", "--ignored", "--nocapture"])
            .env("GOOP_PUBLICATION_TEST_DIRECTORY", dir.path())
            .env("GOOP_PUBLICATION_TEST_PHASE", phase)
            .spawn()
            .unwrap();
        let mut child = OwnedChild(child);
        let marker = dir.path().join("boundary.json");
        let deadline = Instant::now() + Duration::from_secs(30);
        while !marker.exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "child exited before {phase}"
            );
            assert!(Instant::now() < deadline, "timed out waiting for {phase}");
            std::thread::sleep(Duration::from_millis(10));
        }
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let expected: JobResult = serde_json::from_slice(&std::fs::read(marker).unwrap()).unwrap();
        let saved_output = std::fs::read(&output).ok();
        assert_eq!(saved_output.is_some(), phase != "intent");
        // Recovery cannot substitute another encode when the source is gone.
        std::fs::remove_file(&input).unwrap();
        for _ in 0..2 {
            let reopened = QueueStore::open(&db).unwrap();
            reopened.reconcile_publications().unwrap();
            reopened.reconcile().unwrap();
            reopened.recover_paused().unwrap();
            let row = reopened.get_by_id(job.id).unwrap().unwrap();
            if matches!(phase, "receipt" | "done") {
                assert_eq!(row.state, JobState::Done);
                assert_eq!(row.result, Some(expected.clone()));
                assert!(!reopened.has_publication_journal(job.id).unwrap());
            } else {
                assert!(matches!(row.state, JobState::Error { .. }));
                assert!(row.result.is_none());
                assert!(reopened.has_publication_journal(job.id).unwrap());
                assert!(reopened.retry_errored(job.id).is_err());
            }
            assert_eq!(std::fs::read(&output).ok(), saved_output);
        }
        if phase != "intent" && image {
            assert_eq!(image::image_dimensions(&output).unwrap(), (24, 16));
        }
        // The owned temporary directory, including preserved evidence, is
        // removed only after the child has exited and both reopens passed.
    }
}

#[test]
fn image_process_termination_reconciles_all_publication_boundaries() {
    exercise_restart(true);
}

#[test]
#[ignore = "requires the bundled ffmpeg; executed on both shipping platforms"]
fn ffmpeg_process_termination_reconciles_all_publication_boundaries() {
    exercise_restart(false);
}
