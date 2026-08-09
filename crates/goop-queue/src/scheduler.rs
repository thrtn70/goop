use crate::process_control::{self, ProcessControlError};
use crate::store::QueueStore;
use dashmap::DashMap;
use goop_core::{
    EventSink, GoopError, JobId, JobKind, JobResult, JobSignals, JobState, PidRegistry, QueueEvent,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::Semaphore;

#[derive(Debug, thiserror::Error)]
pub enum SchedulerError {
    #[error("job is not running")]
    JobNotRunning,
    #[error("job is not paused")]
    JobNotPaused,
    #[error("job does not support pause")]
    JobNotPausable,
    #[error("job is not retryable")]
    JobNotRetryable,
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
            JobSignals,
        ) -> Pin<Box<dyn Future<Output = Result<JobResult, GoopError>> + Send>>
        + Send
        + Sync,
>;

/// Job kinds whose workers poll `JobSignals::pause` and stop gracefully,
/// keeping resumable state on disk (partial files + validators). Everything
/// else either pauses via the PID registry (external children suspended in
/// place) or runs in-process with no pause story at all.
fn supports_cooperative_pause(kind: &JobKind) -> bool {
    matches!(kind, JobKind::Extract)
}

pub struct Scheduler {
    store: QueueStore,
    sink: Arc<dyn EventSink>,
    extract_sem: Arc<Semaphore>,
    convert_sem: Arc<Semaphore>,
    pdf_sem: Arc<Semaphore>,
    image_sem: Arc<Semaphore>,
    metadata_sem: Arc<Semaphore>,
    extract_worker: WorkerFn,
    convert_worker: WorkerFn,
    pdf_worker: WorkerFn,
    image_worker: WorkerFn,
    metadata_worker: WorkerFn,
    /// Control signals for every currently-running job, inserted at
    /// dispatch (before the Running event) and removed by the completion
    /// task. The kind rides along so `pause()` can gate on cooperative
    /// pausability without a store read.
    signals: Arc<DashMap<JobId, (JobKind, JobSignals)>>,
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
        image_concurrency: usize,
        metadata_concurrency: usize,
        extract_worker: WorkerFn,
        convert_worker: WorkerFn,
        pdf_worker: WorkerFn,
        image_worker: WorkerFn,
        metadata_worker: WorkerFn,
    ) -> Arc<Self> {
        Self::with_pids(
            store,
            sink,
            extract_concurrency,
            convert_concurrency,
            pdf_concurrency,
            image_concurrency,
            metadata_concurrency,
            extract_worker,
            convert_worker,
            pdf_worker,
            image_worker,
            metadata_worker,
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
        image_concurrency: usize,
        metadata_concurrency: usize,
        extract_worker: WorkerFn,
        convert_worker: WorkerFn,
        pdf_worker: WorkerFn,
        image_worker: WorkerFn,
        metadata_worker: WorkerFn,
        pids: Arc<dyn PidRegistry>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            sink,
            extract_sem: Arc::new(Semaphore::new(extract_concurrency.max(1))),
            convert_sem: Arc::new(Semaphore::new(convert_concurrency.max(1))),
            pdf_sem: Arc::new(Semaphore::new(pdf_concurrency.max(1))),
            image_sem: Arc::new(Semaphore::new(image_concurrency.max(1))),
            metadata_sem: Arc::new(Semaphore::new(metadata_concurrency.max(1))),
            extract_worker,
            convert_worker,
            pdf_worker,
            image_worker,
            metadata_worker,
            signals: Arc::new(DashMap::new()),
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
    /// Convenience for callers inside a Tokio runtime (e.g. tests, headless
    /// CLI). The Tauri binary intentionally does NOT use this method —
    /// `setup` runs outside a Tokio context, so the production wiring in
    /// `src-tauri/src/lib.rs` calls `run_kind` per kind via
    /// `tauri::async_runtime::spawn`. If you change one, change both.
    pub fn run_forever(self: Arc<Self>) {
        let s1 = self.clone();
        tokio::spawn(async move { s1.run_kind(JobKind::Extract).await });
        let s2 = self.clone();
        tokio::spawn(async move { s2.run_kind(JobKind::Convert).await });
        let s3 = self.clone();
        tokio::spawn(async move { s3.run_kind(JobKind::Pdf).await });
        let s4 = self.clone();
        tokio::spawn(async move { s4.run_kind(JobKind::Image).await });
        let s5 = self.clone();
        tokio::spawn(async move { s5.run_kind(JobKind::Metadata).await });
    }

    /// One worker loop for a given kind. Public so callers that aren't inside a
    /// Tokio runtime context (e.g. Tauri's setup closure) can spawn it via
    /// their own runtime handle.
    pub async fn run_kind(self: Arc<Self>, kind: JobKind) {
        let sem = match kind {
            JobKind::Extract => self.extract_sem.clone(),
            JobKind::Convert => self.convert_sem.clone(),
            JobKind::Pdf => self.pdf_sem.clone(),
            JobKind::Image => self.image_sem.clone(),
            JobKind::Metadata => self.metadata_sem.clone(),
        };
        let worker = match kind {
            JobKind::Extract => self.extract_worker.clone(),
            JobKind::Convert => self.convert_worker.clone(),
            JobKind::Pdf => self.pdf_worker.clone(),
            JobKind::Image => self.image_worker.clone(),
            JobKind::Metadata => self.metadata_worker.clone(),
        };
        loop {
            let Ok(permit) = sem.clone().acquire_owned().await else {
                break;
            };
            // Poll store for next job. In v0.1, simple sleep-loop; v0.2 adds a notify channel.
            let job = match self.store.next_queued(&kind, now_ms()) {
                Ok(Some(j)) => j,
                _ => {
                    drop(permit);
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    continue;
                }
            };
            // Fresh signals per run: a resumed job must arrive with unfired
            // tokens. Inserted BEFORE the Running write/event so a pause or
            // cancel issued against a visibly-running row always finds them.
            let sig = JobSignals::new();
            self.signals.insert(job.id, (kind.clone(), sig.clone()));
            // Atomic, state-guarded claim: only a still-queued row may
            // start running. A cancel that landed between the poll above
            // and this claim already finalized the row via cancel_inactive
            // — the claim misses and the job must not run.
            match self.store.claim_queued(job.id, now_ms()) {
                Ok(0) => {
                    self.signals.remove(&job.id);
                    drop(permit);
                    continue;
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(?job.id, error = %e, "failed to claim queued job; backing off");
                    self.signals.remove(&job.id);
                    drop(permit);
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    continue;
                }
            }
            self.sink.emit_queue(QueueEvent {
                job_id: job.id,
                state: JobState::Running,
                result: None,
            });
            let store = self.store.clone();
            let sink = self.sink.clone();
            let signals = self.signals.clone();
            let w = worker.clone();
            tokio::spawn(async move {
                let res = (w)(job.id, job.payload.clone(), sig.clone()).await;
                // External-wait yield is handled BEFORE the signals entry
                // is removed, unlike every terminal branch below. The
                // terminal branches persist via `update_state`, which
                // writes unconditionally by id, so a cancel falling
                // through to `cancel_inactive` during their window is a
                // harmless no-op. `requeue_with_delay` is guarded on
                // `running` while `cancel_inactive` is guarded on
                // `queued`/`paused` — mutually exclusive at every instant
                // — so a cancel landing in an empty-signals window here
                // would be silently lost. Keeping the entry alive through
                // the requeue, then re-checking the token after removal,
                // closes that: a racing cancel either fires the live
                // token (caught by the re-check) or arrives after removal
                // and finds the row already `queued` (cancel_inactive
                // works).
                if let Err(GoopError::WaitingExternal { retry_after_ms }) = &res {
                    if !sig.cancel.is_cancelled() {
                        let deadline = now_ms().saturating_add(*retry_after_ms as i64);
                        let requeued = match store.requeue_with_delay(job.id, deadline) {
                            Ok(n) => n,
                            Err(e) => {
                                tracing::warn!(?job.id, error = %e, "failed to requeue waiting job");
                                0
                            }
                        };
                        signals.remove(&job.id);
                        if requeued > 0 {
                            if sig.cancel.is_cancelled() {
                                // A cancel raced the requeue and fired the
                                // (now-removed) token; honor it here — the
                                // row is `queued`, update_state is
                                // unconditional by id.
                                if let Err(e) =
                                    store.update_state(job.id, &JobState::Cancelled, None, now_ms())
                                {
                                    tracing::warn!(?job.id, error = %e, "failed to finalize cancel after yield");
                                }
                                sink.emit_queue(QueueEvent {
                                    job_id: job.id,
                                    state: JobState::Cancelled,
                                    result: None,
                                });
                            } else {
                                // The Queued event doubles as the UI
                                // refresh signal for the waiting row.
                                sink.emit_queue(QueueEvent {
                                    job_id: job.id,
                                    state: JobState::Queued,
                                    result: None,
                                });
                            }
                        }
                        drop(permit);
                        return;
                    }
                    // Cancel token already fired: fall through to the
                    // match below, which maps this to Cancelled.
                }
                // Remove FIRST: shrinks the pause-vs-completion window
                // (a pause landing now falls through to the store check and
                // reports honestly), and cancel's inactive-row branch
                // no-ops on running/terminal states so this is safe.
                signals.remove(&job.id);
                let (state, result) = match &res {
                    Ok(r) => (JobState::Done, Some(r.clone())),
                    Err(GoopError::Cancelled) => (JobState::Cancelled, None),
                    // Cancel wins when both tokens fired: a job the user
                    // cancelled must never park as Paused, even if the
                    // worker observed the pause token first.
                    Err(GoopError::Paused) if sig.cancel.is_cancelled() => {
                        (JobState::Cancelled, None)
                    }
                    // Paused is NOT terminal: no finished_at, row stays in
                    // the queue, resume re-dispatches it.
                    Err(GoopError::Paused) => (JobState::Paused, None),
                    // Only reachable with the cancel token fired (the
                    // yield path above returns otherwise): cancel wins.
                    Err(GoopError::WaitingExternal { .. }) => (JobState::Cancelled, None),
                    Err(e) => (
                        // user_message() applies friendly_message at this
                        // boundary so History rows show "age verification"
                        // instead of a raw yt-dlp traceback. Internal
                        // dispatch decisions (which run before this point)
                        // see the raw stderr on the GoopError variant.
                        JobState::Error {
                            message: e.user_message(),
                            // The raw text `user_message` just replaced. Kept
                            // so a failure with no friendly pattern is still
                            // readable, and a matched one can still be checked
                            // against what the tool actually said.
                            detail: e.detail(),
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
                drop(permit);
            });
        }
    }

    /// Cancel a job in any non-terminal state. Running jobs get their
    /// hard-stop token fired and the worker persists Cancelled; queued and
    /// paused jobs — which have no live worker to report for them — are
    /// finalized here directly. (Previously cancel only fired tokens, so
    /// cancelling a queued job was a silent no-op and it ran anyway.)
    pub fn cancel(&self, id: JobId) -> Result<(), SchedulerError> {
        if let Some((_, (_kind, sig))) = self.signals.remove(&id) {
            sig.cancel.cancel();
            return Ok(());
        }
        if self.store.cancel_inactive(id)? > 0 {
            self.sink.emit_queue(QueueEvent {
                job_id: id,
                state: JobState::Cancelled,
                result: None,
            });
        }
        Ok(())
    }

    /// Pause a running job. Two mechanisms, checked in order:
    ///
    /// 1. A registered child PID (ffmpeg, Ghostscript & friends) is
    ///    suspended in place — SIGSTOP on Unix, NtSuspendProcess on
    ///    Windows — and the state flips synchronously.
    /// 2. A running job whose kind supports cooperative pause (downloads)
    ///    gets its pause token fired. `Ok` here means "pause initiated":
    ///    the worker stops gracefully, keeps its partial files, and the
    ///    row flips to Paused via the completion path shortly after
    ///    (bounded by child kill + reap).
    ///
    /// Pausing an already-paused job is an idempotent `Ok`. A running job
    /// of a kind with neither mechanism returns `JobNotPausable`;
    /// everything else returns `JobNotRunning` (including the ~1ms window
    /// between state→Running and the worker's PID registration — the IPC
    /// layer retries that case).
    pub fn pause(&self, id: JobId) -> Result<(), SchedulerError> {
        // TOCTOU note: PID lookup and signal are not atomic with worker
        // exit. After child.wait() returns but before PidGuard drops, the
        // PID is still registered. Sending SIGSTOP to a dead PID returns
        // ESRCH (NotFound), mapped to JobNotRunning by the IPC layer —
        // benign. PID reuse on Unix requires the kernel's PID counter to
        // wrap (~32k+ spawns), so reuse-then-pause is vanishingly rare.
        if let Some(pid) = self.pids.lookup(id) {
            process_control::pause(pid)?;
            if let Err(e) = self
                .store
                .update_state(id, &JobState::Paused, None, now_ms())
            {
                // Roll the child back so OS state and DB/UI state don't
                // diverge on a store failure.
                let _ = process_control::resume(pid);
                return Err(e.into());
            }
            self.sink.emit_queue(QueueEvent {
                job_id: id,
                state: JobState::Paused,
                result: None,
            });
            return Ok(());
        }
        if let Some(entry) = self.signals.get(&id) {
            let (kind, sig) = entry.value();
            if !supports_cooperative_pause(kind) {
                return Err(SchedulerError::JobNotPausable);
            }
            let pause = sig.pause.clone();
            // Never hold a DashMap shard guard across the token fire — a
            // waiter could re-enter the map from the same thread pool.
            drop(entry);
            pause.cancel();
            return Ok(());
        }
        match self.store.get_by_id(id)? {
            Some(j) if j.state == JobState::Paused => Ok(()),
            _ => Err(SchedulerError::JobNotRunning),
        }
    }

    /// Resume a paused job. PID-suspended children continue in place
    /// (SIGCONT / NtResumeProcess). Paused download jobs are re-queued at
    /// the front instead — their worker already returned, so the next
    /// dispatch re-runs them with fresh signals and the partial files on
    /// disk turn the re-run into a resume. Works purely off the store, so
    /// it also covers paused rows restored from a previous app run.
    ///
    /// Resuming a job that is already queued or running is an idempotent
    /// `Ok` (double-click); anything else returns `JobNotPaused`.
    pub fn resume(&self, id: JobId) -> Result<(), SchedulerError> {
        if let Some(pid) = self.pids.lookup(id) {
            process_control::resume(pid)?;
            if let Err(e) = self
                .store
                .update_state(id, &JobState::Running, None, now_ms())
            {
                // Re-suspend so OS state and DB/UI state don't diverge on
                // a store failure.
                let _ = process_control::pause(pid);
                return Err(e.into());
            }
            self.sink.emit_queue(QueueEvent {
                job_id: id,
                state: JobState::Running,
                result: None,
            });
            return Ok(());
        }
        if self.store.requeue_paused(id)? == 0 {
            return match self.store.get_by_id(id)? {
                Some(j) if matches!(j.state, JobState::Queued | JobState::Running) => Ok(()),
                _ => Err(SchedulerError::JobNotPaused),
            };
        }
        // Honest state: the row is queued until run_kind picks it up
        // (≤250ms when a permit is free). The front-bump in
        // requeue_paused guarantees it is the next pick of its kind.
        self.sink.emit_queue(QueueEvent {
            job_id: id,
            state: JobState::Queued,
            result: None,
        });
        Ok(())
    }

    /// Re-queue a failed job on the same row. Valid for ANY kind in an
    /// error state (payloads are intact and re-runs write fresh outputs);
    /// the UI decides where to render the button. For download jobs the
    /// partial files on disk make the re-run a resume. Retrying a job
    /// that is already queued or running is an idempotent `Ok`.
    pub fn retry(&self, id: JobId) -> Result<(), SchedulerError> {
        if self.store.retry_errored(id)? == 0 {
            return match self.store.get_by_id(id)? {
                Some(j) if matches!(j.state, JobState::Queued | JobState::Running) => Ok(()),
                _ => Err(SchedulerError::JobNotRetryable),
            };
        }
        self.sink.emit_queue(QueueEvent {
            job_id: id,
            state: JobState::Queued,
            result: None,
        });
        Ok(())
    }

    /// Reset rows left in `Paused` state from a previous run back to
    /// `Queued` — except extract jobs, whose graceful pause survives a
    /// restart (see `QueueStore::recover_paused`). Called once at app
    /// startup before workers begin pulling jobs. Returns the number of
    /// rows reset.
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
///
/// `DashMap` is already `Send + Sync`, so the outer `Arc<dyn PidRegistry>`
/// in callers provides the only shared-ownership wrapper needed.
pub struct SchedulerPidRegistry {
    pids: DashMap<JobId, u32>,
}

impl SchedulerPidRegistry {
    pub fn new() -> Self {
        Self {
            pids: DashMap::new(),
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
    use goop_core::{Job, JobKind, ResultKind};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;
    use tempfile::tempdir;

    fn done_result() -> JobResult {
        JobResult {
            output_path: None,
            bytes: None,
            duration_ms: 0,
            result_kind: ResultKind::File,
            file_count: 1,
        }
    }

    fn noop_worker() -> WorkerFn {
        Arc::new(|_, _, _| Box::pin(async move { Ok(done_result()) }))
    }

    /// Extract worker with the same select shape as the real downloaders:
    /// cancel and pause both stop it, otherwise it "works" until the
    /// (generous) sleep completes.
    fn pausable_extract_worker() -> WorkerFn {
        Arc::new(|_id, _payload, signals| {
            Box::pin(async move {
                tokio::select! {
                    _ = signals.cancel.cancelled() => Err(GoopError::Cancelled),
                    _ = signals.pause.cancelled() => Err(GoopError::Paused),
                    _ = tokio::time::sleep(Duration::from_secs(30)) => Ok(done_result()),
                }
            })
        })
    }

    fn make_scheduler_with(
        extract: WorkerFn,
        metadata: WorkerFn,
    ) -> (
        Arc<Scheduler>,
        Arc<RecordingSink>,
        QueueStore,
        tempfile::TempDir,
    ) {
        let d = tempdir().unwrap();
        let store = QueueStore::open(&d.path().join("q.db")).unwrap();
        let sink = Arc::new(RecordingSink::new());
        let noop = noop_worker();
        let s = Scheduler::new(
            store.clone(),
            sink.clone(),
            1,
            1,
            1,
            1,
            1,
            extract,
            noop.clone(),
            noop.clone(),
            noop,
            metadata,
        );
        (s, sink, store, d)
    }

    fn make_scheduler() -> (
        Arc<Scheduler>,
        Arc<RecordingSink>,
        QueueStore,
        tempfile::TempDir,
    ) {
        make_scheduler_with(noop_worker(), noop_worker())
    }

    /// Poll `cond` every 10ms until it holds or `ms` elapses. Returns the
    /// final evaluation so asserts read naturally at the call site.
    async fn wait_until(cond: impl Fn() -> bool, ms: u64) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_millis(ms);
        while std::time::Instant::now() < deadline {
            if cond() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        cond()
    }

    fn state_of(store: &QueueStore, id: JobId) -> JobState {
        store.get_by_id(id).unwrap().unwrap().state
    }

    #[tokio::test]
    async fn waiting_external_yields_permit_and_eventually_completes() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_in_worker = calls.clone();
        let worker: WorkerFn = Arc::new(move |_id, _payload, _signals| {
            let calls = calls_in_worker.clone();
            Box::pin(async move {
                if calls.fetch_add(1, Ordering::SeqCst) < 2 {
                    Err(GoopError::WaitingExternal { retry_after_ms: 50 })
                } else {
                    Ok(done_result())
                }
            })
        });
        let (s, sink, store, _tmp) = make_scheduler_with(worker, noop_worker());
        s.clone().run_forever();

        let j = Job::new(JobKind::Extract, serde_json::Value::Null);
        store.insert(&j).unwrap();

        assert!(
            wait_until(|| state_of(&store, j.id) == JobState::Done, 5000).await,
            "job must complete after the external wait clears; got {:?}",
            state_of(&store, j.id)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3, "two yields + one success");

        let events = sink.queue.lock().clone();
        let requeues = events
            .iter()
            .filter(|e| e.job_id == j.id && matches!(e.state, JobState::Queued))
            .count();
        assert_eq!(
            requeues, 2,
            "each yield must announce the row going back to queued"
        );
        let job = store.get_by_id(j.id).unwrap().unwrap();
        assert_eq!(job.attempts, 0, "yields are not retries");
        assert!(
            !events
                .iter()
                .any(|e| matches!(e.state, JobState::Error { .. })),
            "a yield must never surface as a job failure"
        );
    }

    #[tokio::test]
    async fn cancel_during_external_wait_finalizes_cancelled() {
        // Worker always yields with a long deadline; the cancel lands
        // while the row is parked in `queued` with a future not_before.
        let calls = Arc::new(AtomicU32::new(0));
        let calls_in_worker = calls.clone();
        let worker: WorkerFn = Arc::new(move |_id, _payload, _signals| {
            let calls = calls_in_worker.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(GoopError::WaitingExternal {
                    retry_after_ms: 30_000,
                })
            })
        });
        let (s, _sink, store, _tmp) = make_scheduler_with(worker, noop_worker());
        s.clone().run_forever();

        let j = Job::new(JobKind::Extract, serde_json::Value::Null);
        store.insert(&j).unwrap();

        assert!(
            wait_until(
                || calls.load(Ordering::SeqCst) >= 1 && state_of(&store, j.id) == JobState::Queued,
                5000
            )
            .await,
            "row must park back in queued after the first yield"
        );
        s.cancel(j.id).unwrap();
        assert!(
            wait_until(|| state_of(&store, j.id) == JobState::Cancelled, 2000).await,
            "cancel of a parked waiting row must finalize it; got {:?}",
            state_of(&store, j.id)
        );
    }

    #[tokio::test]
    async fn scheduler_runs_jobs_and_cancels_on_demand() {
        let d = tempdir().unwrap();
        let store = QueueStore::open(&d.path().join("q.db")).unwrap();
        let sink = Arc::new(RecordingSink::new());

        let extract_worker: WorkerFn = Arc::new(|_id, _payload, signals| {
            Box::pin(async move {
                tokio::select! {
                    _ = signals.cancel.cancelled() => Err(GoopError::Cancelled),
                    _ = tokio::time::sleep(Duration::from_millis(20)) => Ok(JobResult{ output_path: None, bytes: None, duration_ms: 20, result_kind: ResultKind::File, file_count: 1 }),
                }
            })
        });
        let noop = noop_worker();

        let s = Scheduler::new(
            store.clone(),
            sink.clone(),
            1,
            1,
            1,
            1,
            1,
            extract_worker,
            noop.clone(),
            noop.clone(),
            noop.clone(),
            noop,
        );
        s.clone().run_forever();

        let j = Job::new(JobKind::Extract, serde_json::Value::Null);
        store.insert(&j).unwrap();

        tokio::time::sleep(Duration::from_millis(500)).await;
        let events = sink.queue.lock().clone();
        assert!(events.iter().any(|e| matches!(e.state, JobState::Running)));
        assert!(events.iter().any(|e| matches!(e.state, JobState::Done)));
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
    fn resume_returns_job_not_paused_for_terminal_and_unknown_jobs() {
        let (sched, _sink, store, _tmp) = make_scheduler();
        let mut done = Job::new(JobKind::Convert, serde_json::Value::Null);
        done.state = JobState::Done;
        store.insert(&done).unwrap();

        let err = sched.resume(done.id).expect_err("done is not resumable");
        assert!(matches!(err, SchedulerError::JobNotPaused));
        let err = sched.resume(JobId::new()).expect_err("unknown id");
        assert!(matches!(err, SchedulerError::JobNotPaused));
    }

    #[test]
    fn resume_is_idempotent_for_queued_and_running_jobs() {
        // Double-click cover: the first resume already re-queued (or the
        // scheduler already picked up) the job; the second must not toast.
        let (sched, _sink, store, _tmp) = make_scheduler();
        let queued = Job::new(JobKind::Extract, serde_json::Value::Null);
        let mut running = Job::new(JobKind::Extract, serde_json::Value::Null);
        running.state = JobState::Running;
        store.insert(&queued).unwrap();
        store.insert(&running).unwrap();

        sched.resume(queued.id).expect("queued is idempotent Ok");
        sched.resume(running.id).expect("running is idempotent Ok");
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

    #[test]
    fn recover_paused_jobs_keeps_extract_jobs_paused() {
        let (sched, _sink, store, _tmp) = make_scheduler();
        let job = Job::new(JobKind::Extract, serde_json::Value::Null);
        store.insert(&job).unwrap();
        store
            .update_state(job.id, &JobState::Paused, None, 1234)
            .unwrap();

        let n = sched.recover_paused_jobs().unwrap();
        assert_eq!(n, 0);
        assert_eq!(state_of(&store, job.id), JobState::Paused);
    }

    #[tokio::test]
    async fn pause_fires_pause_token_and_extract_job_lands_paused() {
        let (sched, sink, store, _tmp) =
            make_scheduler_with(pausable_extract_worker(), noop_worker());
        sched.clone().run_forever();

        let job = Job::new(JobKind::Extract, serde_json::Value::Null);
        store.insert(&job).unwrap();
        assert!(
            wait_until(|| state_of(&store, job.id) == JobState::Running, 2000).await,
            "job must start running"
        );

        sched.pause(job.id).expect("pause initiates");
        assert!(
            wait_until(|| state_of(&store, job.id) == JobState::Paused, 2000).await,
            "worker must yield Paused"
        );

        let after = store.get_by_id(job.id).unwrap().unwrap();
        assert!(after.finished_at.is_none(), "Paused is not terminal");
        let states: Vec<_> = sink.queue.lock().iter().map(|e| e.state.clone()).collect();
        assert!(states.contains(&JobState::Running));
        assert!(states.contains(&JobState::Paused));
    }

    #[tokio::test]
    async fn pause_on_running_in_process_job_returns_job_not_pausable() {
        let slow_metadata: WorkerFn = Arc::new(|_, _, _| {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(done_result())
            })
        });
        let (sched, _sink, store, _tmp) = make_scheduler_with(noop_worker(), slow_metadata);
        sched.clone().run_forever();

        let job = Job::new(JobKind::Metadata, serde_json::Value::Null);
        store.insert(&job).unwrap();
        assert!(wait_until(|| state_of(&store, job.id) == JobState::Running, 2000).await);

        let err = sched
            .pause(job.id)
            .expect_err("no pause story for metadata");
        assert!(matches!(err, SchedulerError::JobNotPausable));
    }

    #[test]
    fn pause_is_idempotent_when_job_already_paused() {
        let (sched, sink, store, _tmp) = make_scheduler();
        let job = Job::new(JobKind::Extract, serde_json::Value::Null);
        store.insert(&job).unwrap();
        store
            .update_state(job.id, &JobState::Paused, None, 1234)
            .unwrap();

        sched.pause(job.id).expect("double-pause is Ok");
        assert!(
            sink.queue.lock().is_empty(),
            "idempotent pause must not re-emit events"
        );
    }

    #[tokio::test]
    async fn resume_requeues_paused_extract_job_at_front_and_emits_queued() {
        let (sched, sink, store, _tmp) = make_scheduler();
        let mut waiting = Job::new(JobKind::Extract, serde_json::Value::Null);
        waiting.priority = 40;
        store.insert(&waiting).unwrap();

        let job = Job::new(JobKind::Extract, serde_json::Value::Null);
        store.insert(&job).unwrap();
        store
            .update_state(job.id, &JobState::Running, None, 1000)
            .unwrap();
        store
            .update_state(job.id, &JobState::Paused, None, 2000)
            .unwrap();

        sched.resume(job.id).expect("resume");

        let after = store.get_by_id(job.id).unwrap().unwrap();
        assert_eq!(after.state, JobState::Queued);
        assert!(after.started_at.is_none());
        let next = store
            .next_queued(&JobKind::Extract, now_ms())
            .unwrap()
            .unwrap();
        assert_eq!(next.id, job.id, "resumed job is the next pick");
        let states: Vec<_> = sink.queue.lock().iter().map(|e| e.state.clone()).collect();
        assert_eq!(states, vec![JobState::Queued]);
    }

    #[tokio::test]
    async fn resumed_extract_job_reruns_with_fresh_signals_and_completes() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_w = calls.clone();
        let extract: WorkerFn = Arc::new(move |_id, _payload, signals| {
            let calls = calls_w.clone();
            Box::pin(async move {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    signals.pause.cancelled().await;
                    Err(GoopError::Paused)
                } else {
                    assert!(
                        signals.check().is_none(),
                        "resumed run must get fresh, unfired tokens"
                    );
                    Ok(done_result())
                }
            })
        });
        let (sched, _sink, store, _tmp) = make_scheduler_with(extract, noop_worker());
        sched.clone().run_forever();

        let job = Job::new(JobKind::Extract, serde_json::Value::Null);
        store.insert(&job).unwrap();
        assert!(wait_until(|| state_of(&store, job.id) == JobState::Running, 2000).await);
        sched.pause(job.id).expect("pause");
        assert!(wait_until(|| state_of(&store, job.id) == JobState::Paused, 2000).await);
        sched.resume(job.id).expect("resume");
        assert!(
            wait_until(|| state_of(&store, job.id) == JobState::Done, 2000).await,
            "resumed job must complete"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2, "worker re-dispatched once");
    }

    #[test]
    fn cancel_of_paused_job_finalizes_cancelled_with_finished_at() {
        let (sched, sink, store, _tmp) = make_scheduler();
        let job = Job::new(JobKind::Extract, serde_json::Value::Null);
        store.insert(&job).unwrap();
        store
            .update_state(job.id, &JobState::Paused, None, 1234)
            .unwrap();

        sched.cancel(job.id).expect("cancel paused");
        let after = store.get_by_id(job.id).unwrap().unwrap();
        assert_eq!(after.state, JobState::Cancelled);
        assert!(after.finished_at.is_some());
        let states: Vec<_> = sink.queue.lock().iter().map(|e| e.state.clone()).collect();
        assert_eq!(states, vec![JobState::Cancelled]);
    }

    #[tokio::test]
    async fn cancel_of_queued_job_finalizes_cancelled_and_it_never_runs() {
        // Regression: cancel used to only fire tokens, so cancelling a
        // queued job was a silent no-op and it ran anyway.
        let (sched, _sink, store, _tmp) = make_scheduler();
        let job = Job::new(JobKind::Extract, serde_json::Value::Null);
        store.insert(&job).unwrap();

        sched.cancel(job.id).expect("cancel queued");
        assert_eq!(state_of(&store, job.id), JobState::Cancelled);
        assert!(
            store
                .next_queued(&JobKind::Extract, now_ms())
                .unwrap()
                .is_none(),
            "cancelled job must not be pickable"
        );
    }

    #[tokio::test]
    async fn cancel_racing_pause_maps_paused_result_to_cancelled() {
        // Worker that commits to the pause path, then takes 50ms to wind
        // down — the window where a user cancel must still win.
        let extract: WorkerFn = Arc::new(|_id, _payload, signals| {
            Box::pin(async move {
                signals.pause.cancelled().await;
                tokio::time::sleep(Duration::from_millis(50)).await;
                Err(GoopError::Paused)
            })
        });
        let (sched, _sink, store, _tmp) = make_scheduler_with(extract, noop_worker());
        sched.clone().run_forever();

        let job = Job::new(JobKind::Extract, serde_json::Value::Null);
        store.insert(&job).unwrap();
        assert!(wait_until(|| state_of(&store, job.id) == JobState::Running, 2000).await);

        sched.pause(job.id).expect("pause");
        sched.cancel(job.id).expect("cancel");
        assert!(
            wait_until(|| state_of(&store, job.id) == JobState::Cancelled, 2000).await,
            "cancel must win over the in-flight pause"
        );
    }

    #[tokio::test]
    async fn retry_flips_error_job_to_queued_increments_attempts_and_reruns() {
        let (sched, sink, store, _tmp) = make_scheduler();
        sched.clone().run_forever();

        let mut job = Job::new(JobKind::Extract, serde_json::Value::Null);
        job.state = JobState::Error {
            message: "connection reset".into(),
            detail: None,
        };
        store.insert(&job).unwrap();

        sched.retry(job.id).expect("retry");
        assert!(
            wait_until(|| state_of(&store, job.id) == JobState::Done, 2000).await,
            "retried job must re-run to completion"
        );
        let after = store.get_by_id(job.id).unwrap().unwrap();
        assert_eq!(after.attempts, 1);
        assert!(after.result.is_some());
        let states: Vec<_> = sink.queue.lock().iter().map(|e| e.state.clone()).collect();
        assert!(states.contains(&JobState::Queued), "retry emits Queued");
    }

    #[test]
    fn retry_rejects_terminal_non_error_and_accepts_active_idempotently() {
        let (sched, _sink, store, _tmp) = make_scheduler();
        let mut done = Job::new(JobKind::Extract, serde_json::Value::Null);
        let mut cancelled = Job::new(JobKind::Extract, serde_json::Value::Null);
        done.state = JobState::Done;
        cancelled.state = JobState::Cancelled;
        let queued = Job::new(JobKind::Extract, serde_json::Value::Null);
        let mut running = Job::new(JobKind::Extract, serde_json::Value::Null);
        running.state = JobState::Running;
        for j in [&done, &cancelled, &queued, &running] {
            store.insert(j).unwrap();
        }

        for id in [done.id, cancelled.id, JobId::new()] {
            let err = sched.retry(id).expect_err("not retryable");
            assert!(matches!(err, SchedulerError::JobNotRetryable));
        }
        sched.retry(queued.id).expect("queued is idempotent Ok");
        sched.retry(running.id).expect("running is idempotent Ok");
    }
}
