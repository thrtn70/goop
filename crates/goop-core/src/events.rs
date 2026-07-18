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
    /// Name of the active encoder, when known. Set for ffmpeg jobs that go
    /// through a hardware encoder (e.g. `h264_videotoolbox`) so the UI can
    /// show a "HW" badge. `None` for software encodes, remuxes, downloads,
    /// and PDF jobs.
    #[serde(default)]
    pub encoder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct QueueEvent {
    pub job_id: JobId,
    pub state: JobState,
    pub result: Option<JobResult>,
}

/// Machine-readable discriminant for `SidecarEvent::Warning`.
///
/// This is not a display string — the frontend routes on it. `handleSidecarEvent`
/// in `src/store/appStore.ts` switches on the code to pick a side effect, and a
/// code it doesn't recognize is dropped rather than shown as a generic warning.
/// Keeping this an enum rather than a `String` is what makes a rename or typo a
/// compile error on both sides instead of a silent no-op.
///
/// Adding a variant requires a matching branch in `handleSidecarEvent`; its
/// exhaustiveness check fails the frontend typecheck until one exists.
/// Regenerate the TS bindings (`scripts/generate-bindings.sh`) after any change
/// here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum WarningCode {
    /// The browser cookie DB couldn't be read (Chrome v127+ DPAPI lock, missing
    /// browser, etc.) and the extractor retried without cookies. Emitted at most
    /// once per job: each extractor's fallback is a single non-looping retry.
    CookieFallback,
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
        code: WarningCode,
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
    pub progress: parking_lot::Mutex<Vec<ProgressEvent>>,
    pub queue: parking_lot::Mutex<Vec<QueueEvent>>,
    pub sidecar: parking_lot::Mutex<Vec<SidecarEvent>>,
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
        self.progress.lock().push(e);
    }
    fn emit_queue(&self, e: QueueEvent) {
        self.queue.lock().push(e);
    }
    fn emit_sidecar(&self, e: SidecarEvent) {
        self.sidecar.lock().push(e);
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
            encoder: None,
        });
        assert_eq!(sink.progress.lock().len(), 1);
    }

    /// Locks the wire format the frontend matches on. `WarningCode` replaced a
    /// bare `String` here; this asserts that swap kept the emitted JSON
    /// byte-identical, so the typing change carries no wire break.
    #[test]
    fn warning_serializes_code_as_snake_case_string() {
        let json = serde_json::to_value(SidecarEvent::Warning {
            code: WarningCode::CookieFallback,
            message: "Couldn't read chrome cookies — proceeded without.".into(),
        })
        .expect("SidecarEvent serializes");

        assert_eq!(json["kind"], "warning");
        assert_eq!(json["code"], "cookie_fallback");
        assert_eq!(
            json["message"],
            "Couldn't read chrome cookies — proceeded without."
        );
    }

    #[test]
    fn warning_code_round_trips_through_json() {
        let code: WarningCode =
            serde_json::from_value(serde_json::json!("cookie_fallback")).expect("code parses");
        assert_eq!(code, WarningCode::CookieFallback);
    }

    /// The frontend routes on `code`, so an unrecognized code must not
    /// silently deserialize into a known one.
    #[test]
    fn warning_code_rejects_unknown_values() {
        let parsed: Result<WarningCode, _> = serde_json::from_value(serde_json::json!("nope"));
        assert!(parsed.is_err(), "unknown codes must not deserialize");
    }
}
