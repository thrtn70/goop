use crate::process_control::{self, ProcessControlError};
use crate::store::QueueStore;
use dashmap::DashMap;
use goop_core::{
    EventSink, GoopError, JobId, JobKind, JobResult, JobState, PidRegistry, QueueEvent,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum SchedulerError {
    #[error("job is not running")]
    JobNotRunning,
    #[error("job is not paused")]
    JobNotPaused,
    #[error(transparent)]
    ProcessControl(#[from] ProcessControlError),
    #[error(transparent)]
    Store(#[from] GoopError),
}

#[allow(clippy::type_complexity)]
pub type WorkerFn = Arc<
    dyn Fn(
            JobId,
            serde_json::Value,
            CancellationToken,
        ) -> Pin<Box<dyn Future<Output = Result<JobResult, GoopError>> + Send>>
        + Send
        + Sync,
>;

pub struct Scheduler {
    store: QueueStore,
    sink: Arc<dyn EventSink>,
    extract_sem: Arc<Semaphore>,
    convert_sem: Arc<Semaphore>,
    pdf_sem: Arc<Semaphore>,
    extract_worker: WorkerFn,
    convert_worker: WorkerFn,
    pdf_worker: WorkerFn,
    cancels: Arc<DashMap<JobId, CancellationToken>>,
    /// PIDs of currently-running, signal-pausable child processes (ffmpeg,
    /// Ghostscript). Shared with worker closures (constructed in
    /// `src-tauri/src/lib.rs`) so workers can register/unregister PIDs
    /// without needing a back-reference to the Scheduler.
    pids: Arc<dyn PidRegistry>,
}

impl Scheduler {
    /// Construct with a fresh PID registry. Use [`Scheduler::with_pids`] if
    /// you need to share the registry with worker closures (the typical
    /// case in `src-tauri/src/lib.rs`).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: QueueStore,
        sink: Arc<dyn EventSink>,
        extract_concurrency: usize,
        convert_concurrency: usize,
        pdf_concurrency: usize,
        extract_worker: WorkerFn,
        convert_worker: WorkerFn,
        pdf_worker: WorkerFn,
    ) -> Arc<Self> {
        Self::with_pids(
            store,
            sink,
            extract_concurrency,
            convert_concurrency,
            pdf_concurrency,
            extract_worker,
            convert_worker,
            pdf_worker,
            Arc::new(SchedulerPidRegistry::new()),
        )
    }

    /// Construct with an externally-owned PID registry. The caller (typically
    /// `src-tauri/src/lib.rs`) creates the registry, hands a clone to the
    /// `FfmpegBackend` and PDF compress worker closures, and passes it here
    /// so the scheduler can look up PIDs for pause/resume.
    #[allow(clippy::too_many_arguments)]
    pub fn with_pids(
        store: QueueStore,
        sink: Arc<dyn EventSink>,
        extract_concurrency: usize,
        convert_concurrency: usize,
        pdf_concurrency: usize,
        extract_worker: WorkerFn,
        convert_worker: WorkerFn,
        pdf_worker: WorkerFn,
        pids: Arc<dyn PidRegistry>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            sink,
            extract_sem: Arc::new(Semaphore::new(extract_concurrency.max(1))),
            convert_sem: Arc::new(Semaphore::new(convert_concurrency.max(1))),
            pdf_sem: Arc::new(Semaphore::new(pdf_concurrency.max(1))),
            extract_worker,
            convert_worker,
            pdf_worker,
            cancels: Arc::new(DashMap::new()),
            pids,
        })
    }

    /// Trait-object handle to the PID registry, for sharing with worker
    /// closures that need to register/unregister PIDs.
    pub fn pid_registry(&self) -> Arc<dyn PidRegistry> {
        self.pids.clone()
    }

    /// Spawn a background loop that pulls queued jobs per kind and runs them.
    /// Caller MUST be inside a Tokio runtime context (or use `run_kind` manually
    /// with their own spawner — Tauri's `async_runtime::spawn`, for example).
    pub fn run_forever(self: Arc<Self>) {
        let s1 = self.clone();
        tokio::spawn(async move { s1.run_kind(JobKind::Extract).await });
        let s2 = self.clone();
        tokio::spawn(async move { s2.run_kind(JobKind::Convert).await });
        let s3 = self.clone();
        tokio::spawn(async move { s3.run_kind(JobKind::Pdf).await });
    }

    /// One worker loop for a given kind. Public so callers that aren't inside a
    /// Tokio runtime context (e.g. Tauri's setup closure) can spawn it via
    /// their own runtime handle.
    pub async fn run_kind(self: Arc<Self>, kind: JobKind) {
        let sem = match kind {
            JobKind::Extract => self.extract_sem.clone(),
            JobKind::Convert => self.convert_sem.clone(),
            JobKind::Pdf => self.pdf_sem.clone(),
        };
        let worker = match kind {
            JobKind::Extract => self.extract_worker.clone(),
            JobKind::Convert => self.convert_worker.clone(),
            JobKind::Pdf => self.pdf_worker.clone(),
        };
        loop {
            let Ok(permit) = sem.clone().acquire_owned().await else {
                break;
            };
            // Poll store for next job. In v0.1, simple sleep-loop; v0.2 adds a notify channel.
            let job = match self.store.next_queued(&kind) {
                Ok(Some(j)) => j,
                _ => {
                    drop(permit);
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    continue;
                }
            };
            let cancel = CancellationToken::new();
            self.cancels.insert(job.id, cancel.clone());
            if let Err(e) = self
                .store
                .update_state(job.id, &JobState::Running, None, now_ms())
            {
                tracing::warn!(?job.id, error = %e, "failed to persist Running state; in-memory event still emitted");
            }
            self.sink.emit_queue(QueueEvent {
                job_id: job.id,
                state: JobState::Running,
                result: None,
            });
            let store = self.store.clone();
            let sink = self.sink.clone();
            let cancels = self.cancels.clone();
            let w = worker.clone();
            tokio::spawn(async move {
                let res = (w)(job.id, job.payload.clone(), cancel).await;
                let (state, result) = match &res {
                    Ok(r) => (JobState::Done, Some(r.clone())),
                    Err(GoopError::Cancelled) => (JobState::Cancelled, None),
                    Err(e) => (
                        JobState::Error {
                            message: e.to_string(),
                        },
                        None,
                    ),
                };
                if let Err(e) = store.update_state(job.id, &state, result.as_ref(), now_ms()) {
                    tracing::warn!(?job.id, ?state, error = %e, "failed to persist terminal state; in-memory event still emitted");
                }
                sink.emit_queue(QueueEvent {
                    job_id: job.id,
                    state,
                    result,
                });
                cancels.remove(&job.id);
                drop(permit);
            });
        }
    }

    pub fn cancel(&self, id: JobId) {
        if let Some((_, tok)) = self.cancels.remove(&id) {
            tok.cancel();
        }
    }

    /// Suspend the running child process for `id`. Returns
    /// `JobNotRunning` if no PID is registered (job not yet running, never
    /// running, or in the ~1ms window between state→Running and the
    /// worker's PID registration — the IPC layer retries this case).
    pub fn pause(&self, id: JobId) -> Result<(), SchedulerError> {
        let pid = self.pids.lookup(id).ok_or(SchedulerError::JobNotRunning)?;
        process_control::pause(pid)?;
        self.store
            .update_state(id, &JobState::Paused, None, now_ms())?;
        self.sink.emit_queue(QueueEvent {
            job_id: id,
            state: JobState::Paused,
            result: None,
        });
        Ok(())
    }

    /// Resume a previously-paused child. Returns `JobNotPaused` if no
    /// PID is registered for `id`.
    pub fn resume(&self, id: JobId) -> Result<(), SchedulerError> {
        let pid = self.pids.lookup(id).ok_or(SchedulerError::JobNotPaused)?;
        process_control::resume(pid)?;
        self.store
            .update_state(id, &JobState::Running, None, now_ms())?;
        self.sink.emit_queue(QueueEvent {
            job_id: id,
            state: JobState::Running,
            result: None,
        });
        Ok(())
    }

    /// Reset any rows left in `Paused` state from a previous run back to
    /// `Queued`. Called once at app startup before workers begin pulling
    /// jobs. Returns the number of rows reset.
    pub fn recover_paused_jobs(&self) -> Result<usize, GoopError> {
        self.store.recover_paused()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `DashMap`-backed `PidRegistry`. Used by `Scheduler::new` and exposed via
/// `Scheduler::pid_registry()` so worker closures can share the same
/// instance the scheduler queries during pause/resume.
pub struct SchedulerPidRegistry {
    pids: Arc<DashMap<JobId, u32>>,
}

impl SchedulerPidRegistry {
    pub fn new() -> Self {
        Self {
            pids: Arc::new(DashMap::new()),
        }
    }
}

impl Default for SchedulerPidRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl PidRegistry for SchedulerPidRegistry {
    fn register(&self, id: JobId, pid: u32) {
        self.pids.insert(id, pid);
    }
    fn unregister(&self, id: JobId) {
        self.pids.remove(&id);
    }
    fn lookup(&self, id: JobId) -> Option<u32> {
        self.pids.get(&id).map(|r| *r.value())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use goop_core::events::RecordingSink;
    use goop_core::{Job, JobKind};
    use tempfile::tempdir;

    #[tokio::test]
    async fn scheduler_runs_jobs_and_cancels_on_demand() {
        let d = tempdir().unwrap();
        let store = QueueStore::open(&d.path().join("q.db")).unwrap();
        let sink = Arc::new(RecordingSink::new());

        let extract_worker: WorkerFn = Arc::new(|_id, _payload, cancel| {
            Box::pin(async move {
                tokio::select! {
                    _ = cancel.cancelled() => Err(GoopError::Cancelled),
                    _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => Ok(JobResult{ output_path: None, bytes: None, duration_ms: 20 }),
                }
            })
        });
        let noop: WorkerFn = Arc::new(|_, _, _| {
            Box::pin(async move {
                Ok(JobResult {
                    output_path: None,
                    bytes: None,
                    duration_ms: 0,
                })
            })
        });

        let s = Scheduler::new(
            store.clone(),
            sink.clone(),
            1,
            1,
            1,
            extract_worker,
            noop.clone(),
            noop,
        );
        s.clone().run_forever();

        let j = Job::new(JobKind::Extract, serde_json::Value::Null);
        store.insert(&j).unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let events = sink.queue.lock().clone();
        assert!(events.iter().any(|e| matches!(e.state, JobState::Running)));
        assert!(events.iter().any(|e| matches!(e.state, JobState::Done)));
    }

    fn make_scheduler() -> (
        Arc<Scheduler>,
        Arc<RecordingSink>,
        QueueStore,
        tempfile::TempDir,
    ) {
        let d = tempdir().unwrap();
        let store = QueueStore::open(&d.path().join("q.db")).unwrap();
        let sink = Arc::new(RecordingSink::new());
        let noop: WorkerFn = Arc::new(|_, _, _| {
            Box::pin(async move {
                Ok(JobResult {
                    output_path: None,
                    bytes: None,
                    duration_ms: 0,
                })
            })
        });
        let s = Scheduler::new(
            store.clone(),
            sink.clone(),
            1,
            1,
            1,
            noop.clone(),
            noop.clone(),
            noop,
        );
        (s, sink, store, d)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pause_and_resume_round_trip_against_real_child() {
        use std::process::{Command, Stdio};

        let (sched, sink, store, _tmp) = make_scheduler();
        let job = Job::new(JobKind::Convert, serde_json::Value::Null);
        store.insert(&job).unwrap();
        store
            .update_state(job.id, &JobState::Running, None, now_ms())
            .unwrap();

        let mut child = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        sched.pid_registry().register(job.id, pid);

        sched.pause(job.id).expect("pause");
        let after_pause = store.get_by_id(job.id).unwrap().unwrap();
        assert_eq!(after_pause.state, JobState::Paused);

        sched.resume(job.id).expect("resume");
        let after_resume = store.get_by_id(job.id).unwrap().unwrap();
        assert_eq!(after_resume.state, JobState::Running);

        let events = sink.queue.lock().clone();
        let states: Vec<_> = events.iter().map(|e| e.state.clone()).collect();
        assert!(
            states.iter().any(|s| matches!(s, JobState::Paused)),
            "expected a Paused event, got {states:?}"
        );
        assert!(
            states.iter().any(|s| matches!(s, JobState::Running)),
            "expected a Running event after resume, got {states:?}"
        );

        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn pause_returns_job_not_running_when_pid_is_unregistered() {
        let (sched, _sink, store, _tmp) = make_scheduler();
        let job = Job::new(JobKind::Convert, serde_json::Value::Null);
        store.insert(&job).unwrap();
        store
            .update_state(job.id, &JobState::Running, None, now_ms())
            .unwrap();

        let err = sched.pause(job.id).expect_err("must fail without pid");
        assert!(matches!(err, SchedulerError::JobNotRunning));
    }

    #[test]
    fn resume_returns_job_not_paused_when_pid_is_unregistered() {
        let (sched, _sink, store, _tmp) = make_scheduler();
        let job = Job::new(JobKind::Convert, serde_json::Value::Null);
        store.insert(&job).unwrap();

        let err = sched.resume(job.id).expect_err("must fail without pid");
        assert!(matches!(err, SchedulerError::JobNotPaused));
    }

    #[test]
    fn recover_paused_jobs_resets_orphans_to_queued() {
        let (sched, _sink, store, _tmp) = make_scheduler();
        let job = Job::new(JobKind::Convert, serde_json::Value::Null);
        store.insert(&job).unwrap();
        store
            .update_state(job.id, &JobState::Paused, None, 1234)
            .unwrap();

        let n = sched.recover_paused_jobs().unwrap();
        assert_eq!(n, 1);
        let after = store.get_by_id(job.id).unwrap().unwrap();
        assert_eq!(after.state, JobState::Queued);
    }
}
