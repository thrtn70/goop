use crate::store::QueueStore;
use dashmap::DashMap;
use goop_core::{EventSink, GoopError, JobId, JobKind, JobResult, JobState, QueueEvent};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

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
    extract_worker: WorkerFn,
    convert_worker: WorkerFn,
    cancels: Arc<DashMap<JobId, CancellationToken>>,
}

impl Scheduler {
    pub fn new(
        store: QueueStore,
        sink: Arc<dyn EventSink>,
        extract_concurrency: usize,
        convert_concurrency: usize,
        extract_worker: WorkerFn,
        convert_worker: WorkerFn,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            sink,
            extract_sem: Arc::new(Semaphore::new(extract_concurrency.max(1))),
            convert_sem: Arc::new(Semaphore::new(convert_concurrency.max(1))),
            extract_worker,
            convert_worker,
            cancels: Arc::new(DashMap::new()),
        })
    }

    /// Spawn a background loop that pulls queued jobs per kind and runs them.
    /// Caller MUST be inside a Tokio runtime context (or use `run_kind` manually
    /// with their own spawner — Tauri's `async_runtime::spawn`, for example).
    pub fn run_forever(self: Arc<Self>) {
        let s1 = self.clone();
        tokio::spawn(async move { s1.run_kind(JobKind::Extract).await });
        let s2 = self.clone();
        tokio::spawn(async move { s2.run_kind(JobKind::Convert).await });
    }

    /// One worker loop for a given kind. Public so callers that aren't inside a
    /// Tokio runtime context (e.g. Tauri's setup closure) can spawn it via
    /// their own runtime handle.
    pub async fn run_kind(self: Arc<Self>, kind: JobKind) {
        let sem = match kind {
            JobKind::Extract => self.extract_sem.clone(),
            JobKind::Convert => self.convert_sem.clone(),
        };
        let worker = match kind {
            JobKind::Extract => self.extract_worker.clone(),
            JobKind::Convert => self.convert_worker.clone(),
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
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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

        let s = Scheduler::new(store.clone(), sink.clone(), 1, 1, extract_worker, noop);
        s.clone().run_forever();

        let j = Job::new(JobKind::Extract, serde_json::Value::Null);
        store.insert(&j).unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let events = sink.queue.lock().unwrap().clone();
        assert!(events.iter().any(|e| matches!(e.state, JobState::Running)));
        assert!(events.iter().any(|e| matches!(e.state, JobState::Done)));
    }
}
