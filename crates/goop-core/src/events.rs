use crate::job::{JobId, JobResult, JobState};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ProgressEvent {
    pub job_id: JobId,
    pub percent: f32,
    pub eta_secs: Option<u64>,
    pub speed_hr: Option<String>,
    pub stage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct QueueEvent {
    pub job_id: JobId,
    pub state: JobState,
    pub result: Option<JobResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SidecarEvent {
    YtDlpUpdated {
        from_version: String,
        to_version: String,
    },
    Warning {
        code: String,
        message: String,
    },
}

/// Abstraction for emitting events. Tauri impl wraps `AppHandle::emit`.
pub trait EventSink: Send + Sync + 'static {
    fn emit_progress(&self, event: ProgressEvent);
    fn emit_queue(&self, event: QueueEvent);
    fn emit_sidecar(&self, event: SidecarEvent);
}

/// Test/no-op sink that records all emitted events in a Vec.
#[cfg(any(test, feature = "test-util"))]
pub struct RecordingSink {
    pub progress: std::sync::Mutex<Vec<ProgressEvent>>,
    pub queue: std::sync::Mutex<Vec<QueueEvent>>,
    pub sidecar: std::sync::Mutex<Vec<SidecarEvent>>,
}

#[cfg(any(test, feature = "test-util"))]
impl RecordingSink {
    pub fn new() -> Self {
        Self {
            progress: Default::default(),
            queue: Default::default(),
            sidecar: Default::default(),
        }
    }
}

#[cfg(any(test, feature = "test-util"))]
impl Default for RecordingSink {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(any(test, feature = "test-util"))]
impl EventSink for RecordingSink {
    fn emit_progress(&self, e: ProgressEvent) {
        self.progress.lock().unwrap().push(e);
    }
    fn emit_queue(&self, e: QueueEvent) {
        self.queue.lock().unwrap().push(e);
    }
    fn emit_sidecar(&self, e: SidecarEvent) {
        self.sidecar.lock().unwrap().push(e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::JobId;

    #[test]
    fn recording_sink_captures_events() {
        let sink = RecordingSink::new();
        sink.emit_progress(ProgressEvent {
            job_id: JobId::new(),
            percent: 42.0,
            eta_secs: Some(10),
            speed_hr: Some("1.2MB/s".into()),
            stage: "downloading".into(),
        });
        assert_eq!(sink.progress.lock().unwrap().len(), 1);
    }
}
