use goop_core::{
    GoopError, HistoryCounts, HistoryFilter, HistorySort, Job, JobId, JobKind, JobResult, JobState,
};
use parking_lot::Mutex;
use rusqlite::{params, params_from_iter, types::Value, Connection};
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
        // Migration 0002 (v0.1.9): add `hidden_from_queue` to support
        // soft-clearing finished jobs from the queue tab without nuking
        // them from History. SQLite's ALTER TABLE has no IF NOT EXISTS so
        // we check `pragma_table_info` first; that keeps re-opens of an
        // already-migrated DB silent.
        ensure_hidden_from_queue_column(&conn)?;
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
        // `hidden_from_queue = 0` excludes finished jobs that the user
        // cleared from the queue tab. History (`list_terminal`) ignores
        // the flag so cleared jobs still show up there.
        let mut stmt = c
            .prepare(
                "SELECT id, kind, state, payload, result, priority, attempts, created_at, started_at, finished_at
                 FROM jobs WHERE hidden_from_queue = 0
                 ORDER BY priority DESC, created_at ASC",
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

    /// Reorder a list of queued jobs. Assigns priority values so the given
    /// IDs come out in the same order from `next_queued` / `list`. Jobs not
    /// in `ordered_ids` are unaffected; if any ID isn't in the queued state,
    /// it's silently skipped (so a race with the scheduler picking one up
    /// doesn't fail the whole batch). Returns the number of rows updated.
    ///
    /// Priority assignment: starts at `priority_base` (10 * len) and
    /// decrements by 10 per step, leaving room for future "move between"
    /// inserts without renumbering everything.
    pub fn reorder_queued(&self, ordered_ids: &[JobId]) -> Result<usize, GoopError> {
        if ordered_ids.is_empty() {
            return Ok(0);
        }
        let mut c = self.conn.lock();
        let tx = c
            .transaction()
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let len = ordered_ids.len() as i32;
        let mut updated = 0usize;
        for (i, id) in ordered_ids.iter().enumerate() {
            let priority = (len - i as i32) * 10;
            let n = tx
                .execute(
                    "UPDATE jobs SET priority = ?1 WHERE id = ?2 AND state = 'queued'",
                    params![priority, id.0.to_string()],
                )
                .map_err(|e| GoopError::Queue(e.to_string()))?;
            updated += n;
        }
        tx.commit().map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(updated)
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

    /// Soft-hide finished/cancelled/errored jobs from the queue tab. The
    /// rows stay in the database so the History page still lists them; only
    /// the queue's `list()` filter excludes them.
    ///
    /// Use `forget` / `forget_many` for actual deletion when the user
    /// removes a job from History.
    pub fn clear_completed(&self) -> Result<usize, GoopError> {
        let c = self.conn.lock();
        let n = c
            .execute(
                "UPDATE jobs SET hidden_from_queue = 1
                 WHERE state = 'done' OR state = 'cancelled' OR state LIKE 'error:%'",
                [],
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(n)
    }

    /// Fetch a single job by id. Returns `Ok(None)` when the id is unknown.
    /// Used by the preview panel to re-read a job's state when the user
    /// clicks a row in History (the in-memory store may be stale after a
    /// forget/trash operation from a different page).
    pub fn get_by_id(&self, id: JobId) -> Result<Option<Job>, GoopError> {
        let c = self.conn.lock();
        let mut stmt = c
            .prepare(
                "SELECT id, kind, state, payload, result, priority, attempts, created_at, started_at, finished_at
                 FROM jobs WHERE id = ?1",
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let mut rows = stmt
            .query_map(params![id.0.to_string()], row_to_job)
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        match rows.next() {
            Some(Ok(j)) => Ok(Some(j)),
            Some(Err(e)) => Err(GoopError::Queue(e.to_string())),
            None => Ok(None),
        }
    }

    /// Return terminal-state jobs matching the filter. Search is case-
    /// insensitive and matches against the JSON payload (covers both the
    /// extract URL and the convert/pdf input/output paths); `%` and `_`
    /// in user input are escaped so they're treated literally.
    pub fn list_terminal(&self, filter: &HistoryFilter) -> Result<Vec<Job>, GoopError> {
        let mut sql = String::from(
            "SELECT id, kind, state, payload, result, priority, attempts, created_at, started_at, finished_at
             FROM jobs
             WHERE (state = 'done' OR state = 'cancelled' OR state LIKE 'error:%')",
        );
        let mut binds: Vec<Value> = Vec::new();

        if let Some(k) = filter.kind.as_ref() {
            sql.push_str(" AND kind = ?");
            binds.push(Value::Text(kind_to_str(k).into()));
        }

        if let Some(search) = filter.search.as_ref() {
            let trimmed = search.trim();
            if !trimmed.is_empty() {
                sql.push_str(" AND payload LIKE ? ESCAPE '\\'");
                binds.push(Value::Text(format!("%{}%", escape_like(trimmed))));
            }
        }

        let order_col = match filter.sort {
            HistorySort::Date => "COALESCE(finished_at, created_at)",
            // Pulls bytes out of the JSON result so we don't need a generated column.
            HistorySort::Size => "CAST(json_extract(result, '$.bytes') AS INTEGER)",
            HistorySort::Name => "LOWER(json_extract(result, '$.output_path'))",
        };
        sql.push_str(" ORDER BY ");
        sql.push_str(order_col);
        sql.push_str(if filter.descending { " DESC" } else { " ASC" });

        let c = self.conn.lock();
        let mut stmt = c
            .prepare(&sql)
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let rows = stmt
            .query_map(params_from_iter(binds), row_to_job)
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| GoopError::Queue(e.to_string()))?);
        }
        Ok(out)
    }

    /// Counts of terminal-state jobs per kind. Drives the filter chip
    /// badges on the History page.
    pub fn history_counts(&self) -> Result<HistoryCounts, GoopError> {
        let c = self.conn.lock();
        let mut stmt = c
            .prepare(
                "SELECT kind, COUNT(*) FROM jobs
                 WHERE (state = 'done' OR state = 'cancelled' OR state LIKE 'error:%')
                 GROUP BY kind",
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
            })
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let mut counts = HistoryCounts::default();
        for r in rows {
            let (kind, count) = r.map_err(|e| GoopError::Queue(e.to_string()))?;
            match kind.as_str() {
                "extract" => counts.extract = count,
                "convert" => counts.convert = count,
                "pdf" => counts.pdf = count,
                _ => {}
            }
            counts.all += count;
        }
        Ok(counts)
    }

    /// Count jobs that reached a terminal state at or after `since_ms`. Used
    /// by the queue header to show "X done today" — caller computes the
    /// midnight boundary.
    pub fn completed_since(&self, since_ms: i64) -> Result<u32, GoopError> {
        let c = self.conn.lock();
        let mut stmt = c
            .prepare(
                "SELECT COUNT(*) FROM jobs
                 WHERE (state = 'done' OR state = 'cancelled' OR state LIKE 'error:%')
                 AND finished_at IS NOT NULL AND finished_at >= ?1",
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let count: u32 = stmt
            .query_row(params![since_ms], |row| row.get(0))
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(count)
    }

    /// Delete a single job row. Returns the number of rows deleted (0 or 1).
    /// Does NOT touch the file on disk — that's the caller's responsibility
    /// via the separate `file_move_to_trash` command.
    pub fn forget(&self, id: JobId) -> Result<usize, GoopError> {
        let c = self.conn.lock();
        let n = c
            .execute("DELETE FROM jobs WHERE id = ?1", params![id.0.to_string()])
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(n)
    }

    /// Batch delete. All-or-nothing via a transaction so a partial failure
    /// doesn't leave the UI selection state out of sync with the DB.
    pub fn forget_many(&self, ids: &[JobId]) -> Result<usize, GoopError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut c = self.conn.lock();
        let tx = c
            .transaction()
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let mut total = 0;
        for id in ids {
            total += tx
                .execute("DELETE FROM jobs WHERE id = ?1", params![id.0.to_string()])
                .map_err(|e| GoopError::Queue(e.to_string()))?;
        }
        tx.commit().map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(total)
    }
}

/// Escape `%` and `_` so user search strings don't become wildcard LIKE
/// patterns. The caller also uses `ESCAPE '\\'` in the SQL so `\` itself
/// is the escape character.
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
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
        JobKind::Pdf => "pdf",
    }
}

fn str_to_kind(s: &str) -> Option<JobKind> {
    match s {
        "extract" => Some(JobKind::Extract),
        "convert" => Some(JobKind::Convert),
        "pdf" => Some(JobKind::Pdf),
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

/// Idempotent migration for the v0.1.9 `hidden_from_queue` column on the
/// `jobs` table. SQLite has no `IF NOT EXISTS` clause for ALTER TABLE ADD
/// COLUMN, so we check `pragma_table_info` and skip the ALTER when the
/// column is already present.
///
/// Specialized (rather than generic) on purpose: a generic
/// `add_column(table, name, decl)` helper would format identifiers into
/// raw SQL and become a latent injection surface for any future caller.
/// Keeping the table/column/declaration as compile-time literals here
/// closes that hole.
fn ensure_hidden_from_queue_column(conn: &Connection) -> Result<(), GoopError> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name = 'hidden_from_queue'")
        .map_err(|e| GoopError::Queue(e.to_string()))?;
    let exists = stmt
        .exists([])
        .map_err(|e| GoopError::Queue(e.to_string()))?;
    if !exists {
        conn.execute(
            "ALTER TABLE jobs ADD COLUMN hidden_from_queue INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| GoopError::Queue(e.to_string()))?;
    }
    Ok(())
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
    fn reorder_queued_promotes_listed_jobs_to_top() {
        let (s, _tmp) = temp_store();
        let a = Job::new(JobKind::Extract, serde_json::Value::Null);
        let b = Job::new(JobKind::Extract, serde_json::Value::Null);
        let c = Job::new(JobKind::Extract, serde_json::Value::Null);
        s.insert(&a).unwrap();
        s.insert(&b).unwrap();
        s.insert(&c).unwrap();

        // Move c to top, then a, then b.
        let n = s.reorder_queued(&[c.id, a.id, b.id]).unwrap();
        assert_eq!(n, 3);
        let next = s.next_queued(&JobKind::Extract).unwrap().unwrap();
        assert_eq!(next.id, c.id);
    }

    #[test]
    fn clear_completed_hides_terminal_jobs_from_queue_but_keeps_them_in_history() {
        let (s, _tmp) = temp_store();
        let mut done = Job::new(JobKind::Extract, serde_json::Value::Null);
        let mut cancelled = Job::new(JobKind::Convert, serde_json::Value::Null);
        let mut errored = Job::new(JobKind::Convert, serde_json::Value::Null);
        let running = Job::new(JobKind::Extract, serde_json::Value::Null);
        done.state = JobState::Done;
        cancelled.state = JobState::Cancelled;
        errored.state = JobState::Error {
            message: "boom".into(),
        };
        s.insert(&done).unwrap();
        s.insert(&cancelled).unwrap();
        s.insert(&errored).unwrap();
        s.insert(&running).unwrap();

        let hidden = s.clear_completed().unwrap();
        assert_eq!(hidden, 3, "all three terminal jobs should be hidden");

        let queue = s.list().unwrap();
        let ids: Vec<_> = queue.iter().map(|j| j.id).collect();
        assert_eq!(
            queue.len(),
            1,
            "only the running job should remain in queue list, got {ids:?}"
        );
        assert_eq!(queue[0].id, running.id);

        let history = s
            .list_terminal(&HistoryFilter {
                kind: None,
                search: None,
                sort: HistorySort::Date,
                descending: true,
            })
            .unwrap();
        assert_eq!(
            history.len(),
            3,
            "history must still see all three terminal jobs"
        );
    }

    #[test]
    fn ensure_column_is_idempotent() {
        // Open creates fresh DB + runs migrations. Open again on the same
        // path should succeed without error (column already there).
        let d = tempdir().unwrap();
        let path = d.path().join("q.db");
        let _s = QueueStore::open(&path).unwrap();
        let _s2 = QueueStore::open(&path).unwrap();
    }

    #[test]
    fn reorder_queued_skips_non_queued_jobs() {
        let (s, _tmp) = temp_store();
        let mut a = Job::new(JobKind::Extract, serde_json::Value::Null);
        let b = Job::new(JobKind::Extract, serde_json::Value::Null);
        a.state = JobState::Running;
        s.insert(&a).unwrap();
        s.insert(&b).unwrap();

        // Try to reorder a (running) and b (queued); only b should update.
        let n = s.reorder_queued(&[a.id, b.id]).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn reorder_queued_empty_input_is_noop() {
        let (s, _tmp) = temp_store();
        assert_eq!(s.reorder_queued(&[]).unwrap(), 0);
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

    #[test]
    fn pdf_kind_round_trips() {
        assert_eq!(kind_to_str(&JobKind::Pdf), "pdf");
        assert_eq!(str_to_kind("pdf"), Some(JobKind::Pdf));
    }

    #[test]
    fn escape_like_literalizes_wildcards() {
        assert_eq!(escape_like("a%b"), "a\\%b");
        assert_eq!(escape_like("a_b"), "a\\_b");
        assert_eq!(escape_like("a\\b"), "a\\\\b");
        assert_eq!(escape_like("plain"), "plain");
    }

    fn done_job(kind: JobKind, payload: serde_json::Value, bytes: Option<u64>) -> Job {
        let mut j = Job::new(kind, payload);
        j.state = JobState::Done;
        j.finished_at = Some(j.created_at + 1000);
        j.result = Some(JobResult {
            output_path: Some(match &j.payload {
                serde_json::Value::Object(m) => m
                    .get("output_path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("/tmp/out")
                    .to_string(),
                _ => "/tmp/out".to_string(),
            }),
            bytes,
            duration_ms: 1000,
        });
        j
    }

    #[test]
    fn get_by_id_returns_none_for_unknown() {
        let (s, _tmp) = temp_store();
        let missing = JobId::new();
        assert!(s.get_by_id(missing).unwrap().is_none());
    }

    #[test]
    fn get_by_id_returns_inserted_job() {
        let (s, _tmp) = temp_store();
        let j = done_job(
            JobKind::Convert,
            serde_json::json!({"input_path": "/src", "output_path": "/out"}),
            Some(1024),
        );
        s.insert(&j).unwrap();
        let fetched = s.get_by_id(j.id).unwrap().expect("job exists");
        assert_eq!(fetched.id, j.id);
    }

    #[test]
    fn list_terminal_filters_by_kind_and_search() {
        let (s, _tmp) = temp_store();
        s.insert(&done_job(
            JobKind::Convert,
            serde_json::json!({"input_path": "/a/holiday.mp4", "output_path": "/out/holiday.mp3"}),
            Some(10),
        ))
        .unwrap();
        s.insert(&done_job(
            JobKind::Convert,
            serde_json::json!({"input_path": "/a/podcast.mp3", "output_path": "/out/podcast.m4a"}),
            Some(5),
        ))
        .unwrap();
        s.insert(&done_job(
            JobKind::Extract,
            serde_json::json!({"url": "https://example.com/holiday"}),
            Some(20),
        ))
        .unwrap();

        // kind=Convert narrows to 2 rows; search "holiday" further narrows to 1.
        let by_kind = s
            .list_terminal(&HistoryFilter {
                kind: Some(JobKind::Convert),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(by_kind.len(), 2);

        let by_kind_and_search = s
            .list_terminal(&HistoryFilter {
                kind: Some(JobKind::Convert),
                search: Some("holiday".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(by_kind_and_search.len(), 1);

        // search across kinds finds the extract row too.
        let all_holiday = s
            .list_terminal(&HistoryFilter {
                search: Some("holiday".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(all_holiday.len(), 2);
    }

    #[test]
    fn list_terminal_search_escapes_like_wildcards() {
        let (s, _tmp) = temp_store();
        s.insert(&done_job(
            JobKind::Convert,
            serde_json::json!({"output_path": "/out/100_percent.mp3"}),
            Some(1),
        ))
        .unwrap();
        // Anything else in the DB shouldn't match when the user types an underscore.
        s.insert(&done_job(
            JobKind::Convert,
            serde_json::json!({"output_path": "/out/unrelated.mp3"}),
            Some(1),
        ))
        .unwrap();
        let hit = s
            .list_terminal(&HistoryFilter {
                search: Some("_percent".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hit.len(), 1, "underscore should match literally");
    }

    #[test]
    fn list_terminal_sort_by_size_ascending() {
        let (s, _tmp) = temp_store();
        s.insert(&done_job(
            JobKind::Convert,
            serde_json::json!({"output_path": "/a"}),
            Some(30),
        ))
        .unwrap();
        s.insert(&done_job(
            JobKind::Convert,
            serde_json::json!({"output_path": "/b"}),
            Some(10),
        ))
        .unwrap();
        s.insert(&done_job(
            JobKind::Convert,
            serde_json::json!({"output_path": "/c"}),
            Some(20),
        ))
        .unwrap();
        let asc = s
            .list_terminal(&HistoryFilter {
                sort: HistorySort::Size,
                descending: false,
                ..Default::default()
            })
            .unwrap();
        let sizes: Vec<u64> = asc
            .iter()
            .filter_map(|j| j.result.as_ref().and_then(|r| r.bytes))
            .collect();
        assert_eq!(sizes, vec![10, 20, 30]);
    }

    #[test]
    fn forget_deletes_single_row() {
        let (s, _tmp) = temp_store();
        let j = done_job(JobKind::Extract, serde_json::Value::Null, Some(1));
        s.insert(&j).unwrap();
        let n = s.forget(j.id).unwrap();
        assert_eq!(n, 1);
        assert!(s.get_by_id(j.id).unwrap().is_none());
    }

    #[test]
    fn forget_many_is_atomic() {
        let (s, _tmp) = temp_store();
        let a = done_job(JobKind::Extract, serde_json::Value::Null, Some(1));
        let b = done_job(JobKind::Extract, serde_json::Value::Null, Some(2));
        s.insert(&a).unwrap();
        s.insert(&b).unwrap();
        let n = s.forget_many(&[a.id, b.id]).unwrap();
        assert_eq!(n, 2);
        assert!(s
            .list_terminal(&HistoryFilter::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn history_counts_groups_by_kind() {
        let (s, _tmp) = temp_store();
        s.insert(&done_job(JobKind::Extract, serde_json::Value::Null, None))
            .unwrap();
        s.insert(&done_job(JobKind::Convert, serde_json::Value::Null, None))
            .unwrap();
        s.insert(&done_job(JobKind::Convert, serde_json::Value::Null, None))
            .unwrap();
        s.insert(&done_job(JobKind::Pdf, serde_json::Value::Null, None))
            .unwrap();
        let counts = s.history_counts().unwrap();
        assert_eq!(counts.all, 4);
        assert_eq!(counts.extract, 1);
        assert_eq!(counts.convert, 2);
        assert_eq!(counts.pdf, 1);
    }
}
