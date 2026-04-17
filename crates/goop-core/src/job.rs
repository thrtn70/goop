use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

// TODO(Task 17): ts-rs `export_to` resolves relative to source file and lands
// types at `crates/shared/types/`. Task 17's bindings generator should either
// adjust the path (`../../../shared/types/`) or use TS_RS_EXPORT_DIR to
// consolidate at the workspace root.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct JobId(pub Uuid);

impl JobId {
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }
}

impl Default for JobId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Extract,
    Convert,
    Pdf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Error { message: String },
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct JobResult {
    pub output_path: Option<String>,
    pub bytes: Option<u64>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct Job {
    pub id: JobId,
    pub kind: JobKind,
    pub state: JobState,
    pub payload: serde_json::Value,
    pub result: Option<JobResult>,
    pub priority: i32,
    pub attempts: u32,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

impl Job {
    pub fn new(kind: JobKind, payload: serde_json::Value) -> Self {
        Self {
            id: JobId::new(),
            kind,
            state: JobState::Queued,
            payload,
            result: None,
            priority: 0,
            attempts: 0,
            created_at: chrono_now_ms(),
            started_at: None,
            finished_at: None,
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            JobState::Done | JobState::Error { .. } | JobState::Cancelled
        )
    }
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_id_is_unique_and_time_sortable() {
        let a = JobId::new();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = JobId::new();
        assert_ne!(a, b);
        // v7 UUIDs are time-ordered by the high bits
        assert!(a.0 < b.0, "expected time-ordered v7 UUIDs");
    }

    #[test]
    fn new_job_starts_queued() {
        let j = Job::new(
            JobKind::Extract,
            serde_json::json!({"url": "https://example.com"}),
        );
        assert_eq!(j.state, JobState::Queued);
        assert_eq!(j.attempts, 0);
        assert!(j.started_at.is_none());
        assert!(!j.is_terminal());
    }

    #[test]
    fn terminal_states_detected() {
        let mut j = Job::new(JobKind::Extract, serde_json::Value::Null);
        j.state = JobState::Done;
        assert!(j.is_terminal());
        j.state = JobState::Error {
            message: "x".into(),
        };
        assert!(j.is_terminal());
        j.state = JobState::Cancelled;
        assert!(j.is_terminal());
    }
}
