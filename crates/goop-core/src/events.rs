use crate::job::{JobId, JobResult, JobState};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum WarningCode {
    /// The browser cookie DB couldn't be read (Chrome v127+ DPAPI lock, missing
    /// browser, etc.) and the extractor retried without cookies. Emitted at most
    /// once per job: each extractor's fallback is a single non-looping retry.
    CookieFallback,
    /// ffmpeg couldn't decode some subtitle cues, so they are missing from the
    /// output. It drops undecodable cues and still exits 0, so without this the
    /// job reports plain success and the lost lines are invisible — which is
    /// the whole failure mode subtitle encoding detection exists to prevent.
    /// Reaching this means detection guessed the character set wrong.
    SubtitleCuesDropped,
    /// A format or audio-only choice reached gallery-dl, which has no
    /// notion of either — it saves whatever the site holds. The download
    /// succeeds and the file is real, so failing the job would be wrong;
    /// but the user picked a quality and silently did not get it, which is
    /// exactly the kind of thing that only surfaces much later, when the
    /// file turns out to be the wrong size.
    FormatFallback,
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

/// `EventSink` decorator that collapses repeated `SidecarEvent::Warning`s
/// carrying the same `code` down to the first one. Progress, queue, and
/// non-`Warning` sidecar events pass through untouched.
///
/// A warning is emitted by whichever leaf detects the condition, but one
/// run can put several leaves through the same condition: a dispatcher
/// may try a second backend after the first declines, and a retry wrapper
/// may replay the whole pipeline. Each leaf emitting once therefore still
/// yields a pile of identical toasts. Wrapping the sink for the span of a
/// run collapses them without any leaf needing to know how many times it
/// might run, or which sibling ran before it.
///
/// `code` is the whole identity — two warnings sharing a code are taken
/// to be the same fact, and the first one's `message` is what survives.
/// So a code must name a coarse category ("cookie_fallback"), never carry
/// per-instance detail that callers would expect to see every time.
///
/// Deliberately scoped to the wrapper rather than global: the seen-set
/// dies with it, so the caller chooses the span. `goop-extractor` wraps
/// one dispatch attempt, which means a resumed or manually retried job
/// warns afresh — the user acted, so a fresh heads-up is warranted.
pub struct WarnOnceSink {
    inner: Arc<dyn EventSink>,
    seen: parking_lot::Mutex<HashSet<WarningCode>>,
}

impl WarnOnceSink {
    /// Wrap `inner` so each distinct warning code reaches it at most once.
    pub fn wrap(inner: Arc<dyn EventSink>) -> Arc<dyn EventSink> {
        Arc::new(Self {
            inner,
            seen: parking_lot::Mutex::new(HashSet::new()),
        })
    }
}

impl EventSink for WarnOnceSink {
    fn emit_progress(&self, event: ProgressEvent) {
        self.inner.emit_progress(event);
    }

    fn emit_queue(&self, event: QueueEvent) {
        self.inner.emit_queue(event);
    }

    fn emit_sidecar(&self, event: SidecarEvent) {
        if let SidecarEvent::Warning { code, .. } = &event {
            // `insert` returns false when the code was already present.
            // The lock is released before forwarding: `inner` is arbitrary
            // user code (the Tauri emit path), and holding a lock across
            // it invites a deadlock for no benefit.
            let first_time = self.seen.lock().insert(*code);
            if !first_time {
                return;
            }
        }
        self.inner.emit_sidecar(event);
    }
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
    use crate::job::{JobId, JobState};

    fn warning(code: WarningCode) -> SidecarEvent {
        // Derive the message from the code's snake_case wire form so the
        // dedup key (the typed code) and the human message stay in step.
        let name = serde_json::to_value(code)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        SidecarEvent::Warning {
            code,
            message: format!("{name} happened"),
        }
    }

    fn progress(stage: &str) -> ProgressEvent {
        ProgressEvent {
            job_id: JobId::new(),
            percent: 0.0,
            eta_secs: None,
            speed_hr: None,
            stage: stage.into(),
            encoder: None,
        }
    }

    fn codes(sink: &RecordingSink) -> Vec<WarningCode> {
        sink.sidecar
            .lock()
            .iter()
            .filter_map(|e| match e {
                SidecarEvent::Warning { code, .. } => Some(*code),
                _ => None,
            })
            .collect()
    }

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
    fn warn_once_forwards_the_first_warning_of_each_code() {
        let rec = Arc::new(RecordingSink::new());
        let sink = WarnOnceSink::wrap(rec.clone());

        sink.emit_sidecar(warning(WarningCode::CookieFallback));

        assert_eq!(codes(&rec), vec![WarningCode::CookieFallback]);
        // The message must survive the wrapper untouched.
        assert!(
            matches!(&rec.sidecar.lock()[0], SidecarEvent::Warning { message, .. }
                if message == "cookie_fallback happened")
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

    #[test]
    fn warn_once_suppresses_repeats_of_the_same_code() {
        let rec = Arc::new(RecordingSink::new());
        let sink = WarnOnceSink::wrap(rec.clone());

        for _ in 0..3 {
            sink.emit_sidecar(warning(WarningCode::CookieFallback));
        }

        assert_eq!(codes(&rec), vec![WarningCode::CookieFallback]);
    }

    /// `code` is the whole identity: two warnings sharing a code collapse to
    /// the first, message and all. With a single `WarningCode` variant today
    /// this is the meaningful form of the "distinct codes stay distinct"
    /// property (a two-variant test returns when a second variant lands).
    #[test]
    fn warn_once_dedupes_on_code_not_message() {
        let rec = Arc::new(RecordingSink::new());
        let sink = WarnOnceSink::wrap(rec.clone());

        sink.emit_sidecar(SidecarEvent::Warning {
            code: WarningCode::CookieFallback,
            message: "first".into(),
        });
        sink.emit_sidecar(SidecarEvent::Warning {
            code: WarningCode::CookieFallback,
            message: "second".into(),
        });

        assert_eq!(rec.sidecar.lock().len(), 1);
        assert!(matches!(&rec.sidecar.lock()[0],
            SidecarEvent::Warning { message, .. } if message == "first"));
    }

    #[test]
    fn warn_once_never_dedupes_non_warning_sidecar_variants() {
        let rec = Arc::new(RecordingSink::new());
        let sink = WarnOnceSink::wrap(rec.clone());

        for _ in 0..2 {
            sink.emit_sidecar(SidecarEvent::YtDlpUpdated {
                from_version: "2024.10.07".into(),
                to_version: "2024.11.18".into(),
            });
        }

        assert_eq!(rec.sidecar.lock().len(), 2);
    }

    #[test]
    fn warn_once_passes_progress_and_queue_straight_through() {
        let rec = Arc::new(RecordingSink::new());
        let sink = WarnOnceSink::wrap(rec.clone());

        // Identical repeats must all land: `with_retry` reports every
        // backoff through `stage`, and a deduped progress stream would
        // freeze the queue row's retry countdown.
        for _ in 0..3 {
            sink.emit_progress(progress("retrying (attempt 2/5)"));
            sink.emit_queue(QueueEvent {
                job_id: JobId::new(),
                state: JobState::Running,
                result: None,
            });
        }

        assert_eq!(rec.progress.lock().len(), 3);
        assert_eq!(rec.queue.lock().len(), 3);
    }
}
