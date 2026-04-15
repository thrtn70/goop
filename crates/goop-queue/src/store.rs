use goop_core::{GoopError, Job, JobId, JobKind, JobResult, JobState};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Arc;

const MIGRATION_0001: &str = include_str!("../migrations/0001_init.sql");

#[derive(Clone)]
pub struct QueueStore {
    conn: Arc<Mutex<Connection>>,
}

impl QueueStore {
    pub fn open(path: &Path) -> Result<Self, GoopError> {
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(path).map_err(|e| GoopError::Queue(e.to_string()))?;
        conn.execute_batch(MIGRATION_0001)
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn insert(&self, job: &Job) -> Result<(), GoopError> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO jobs (id, kind, state, payload, result, priority, attempts, created_at, started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                job.id.0.to_string(),
                kind_to_str(&job.kind),
                state_to_str(&job.state),
                serde_json::to_string(&job.payload).map_err(|e| GoopError::Queue(e.to_string()))?,
                job.result.as_ref().and_then(|r| serde_json::to_string(r).ok()),
                job.priority,
                job.attempts,
                job.created_at,
                job.started_at,
                job.finished_at,
            ],
        )
        .map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(())
    }

    pub fn update_state(
        &self,
        id: JobId,
        state: &JobState,
        result: Option<&JobResult>,
        now_ms: i64,
    ) -> Result<(), GoopError> {
        let c = self.conn.lock();
        let finished_at = if matches!(
            state,
            JobState::Done | JobState::Error { .. } | JobState::Cancelled
        ) {
            Some(now_ms)
        } else {
            None
        };
        let started_at = if matches!(state, JobState::Running) {
            Some(now_ms)
        } else {
            None
        };
        c.execute(
            "UPDATE jobs SET state = ?2, result = ?3,
                started_at = COALESCE(?4, started_at),
                finished_at = COALESCE(?5, finished_at)
             WHERE id = ?1",
            params![
                id.0.to_string(),
                state_to_str(state),
                result.and_then(|r| serde_json::to_string(r).ok()),
                started_at,
                finished_at,
            ],
        )
        .map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Job>, GoopError> {
        let c = self.conn.lock();
        let mut stmt = c
            .prepare(
                "SELECT id, kind, state, payload, result, priority, attempts, created_at, started_at, finished_at
                 FROM jobs ORDER BY priority DESC, created_at ASC",
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let rows = stmt
            .query_map([], row_to_job)
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| GoopError::Queue(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn next_queued(&self, kind: &JobKind) -> Result<Option<Job>, GoopError> {
        let c = self.conn.lock();
        let mut stmt = c
            .prepare(
                "SELECT id, kind, state, payload, result, priority, attempts, created_at, started_at, finished_at
                 FROM jobs WHERE state = 'queued' AND kind = ?1
                 ORDER BY priority DESC, created_at ASC LIMIT 1",
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let mut rows = stmt
            .query_map(params![kind_to_str(kind)], row_to_job)
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        match rows.next() {
            Some(Ok(j)) => Ok(Some(j)),
            Some(Err(e)) => Err(GoopError::Queue(e.to_string())),
            None => Ok(None),
        }
    }

    /// On boot, flip any `running` jobs to `error{reason:"interrupted"}`.
    pub fn reconcile(&self) -> Result<usize, GoopError> {
        let c = self.conn.lock();
        let n = c
            .execute(
                "UPDATE jobs SET state = ?1, finished_at = ?2 WHERE state = 'running'",
                params![
                    state_to_str(&JobState::Error {
                        message: "interrupted".into()
                    }),
                    now_ms()
                ],
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(n)
    }

    pub fn clear_completed(&self) -> Result<usize, GoopError> {
        let c = self.conn.lock();
        let n = c
            .execute("DELETE FROM jobs WHERE state IN ('done', 'cancelled')", [])
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(n)
    }
}

fn row_to_job(row: &rusqlite::Row) -> rusqlite::Result<Job> {
    let id_str: String = row.get(0)?;
    Ok(Job {
        id: JobId(uuid::Uuid::parse_str(&id_str).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?),
        kind: str_to_kind(&row.get::<_, String>(1)?).ok_or(rusqlite::Error::InvalidQuery)?,
        state: str_to_state(&row.get::<_, String>(2)?).ok_or(rusqlite::Error::InvalidQuery)?,
        payload: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or(serde_json::Value::Null),
        result: row
            .get::<_, Option<String>>(4)?
            .and_then(|s| serde_json::from_str(&s).ok()),
        priority: row.get(5)?,
        attempts: row.get(6)?,
        created_at: row.get(7)?,
        started_at: row.get(8)?,
        finished_at: row.get(9)?,
    })
}

fn kind_to_str(k: &JobKind) -> &'static str {
    match k {
        JobKind::Extract => "extract",
        JobKind::Convert => "convert",
    }
}

fn str_to_kind(s: &str) -> Option<JobKind> {
    match s {
        "extract" => Some(JobKind::Extract),
        "convert" => Some(JobKind::Convert),
        _ => None,
    }
}

fn state_to_str(s: &JobState) -> String {
    match s {
        JobState::Queued => "queued".into(),
        JobState::Running => "running".into(),
        JobState::Done => "done".into(),
        JobState::Cancelled => "cancelled".into(),
        JobState::Error { message } => format!("error:{message}"),
    }
}

fn str_to_state(s: &str) -> Option<JobState> {
    if let Some(msg) = s.strip_prefix("error:") {
        return Some(JobState::Error {
            message: msg.into(),
        });
    }
    match s {
        "queued" => Some(JobState::Queued),
        "running" => Some(JobState::Running),
        "done" => Some(JobState::Done),
        "cancelled" => Some(JobState::Cancelled),
        _ => None,
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
    use tempfile::tempdir;

    fn temp_store() -> (QueueStore, tempfile::TempDir) {
        let d = tempdir().unwrap();
        let s = QueueStore::open(&d.path().join("q.db")).unwrap();
        (s, d)
    }

    #[test]
    fn insert_and_list() {
        let (s, _tmp) = temp_store();
        let j = Job::new(JobKind::Extract, serde_json::json!({"url":"https://x"}));
        s.insert(&j).unwrap();
        let all = s.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, j.id);
    }

    #[test]
    fn next_queued_returns_highest_priority() {
        let (s, _tmp) = temp_store();
        let mut a = Job::new(JobKind::Extract, serde_json::Value::Null);
        let mut b = Job::new(JobKind::Extract, serde_json::Value::Null);
        a.priority = 1;
        b.priority = 5;
        s.insert(&a).unwrap();
        s.insert(&b).unwrap();
        let n = s.next_queued(&JobKind::Extract).unwrap().unwrap();
        assert_eq!(n.id, b.id);
    }

    #[test]
    fn reconcile_interrupted_running_jobs() {
        let (s, _tmp) = temp_store();
        let mut j = Job::new(JobKind::Extract, serde_json::Value::Null);
        j.state = JobState::Running;
        s.insert(&j).unwrap();
        let n = s.reconcile().unwrap();
        assert_eq!(n, 1);
        let all = s.list().unwrap();
        assert!(matches!(&all[0].state, JobState::Error { message } if message == "interrupted"));
    }
}
