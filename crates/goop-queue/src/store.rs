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
        // Migration 0003 (debrid): add `not_before` so a job waiting on an
        // external service can park in `queued` with a wake-up deadline
        // instead of pinning a concurrency permit while it polls.
        ensure_not_before_column(&conn)?;
        // Migration 0004: add `error_detail` so a failure can keep the raw
        // stderr that `friendly_message` replaced. Nullable, and outside the
        // `state` string on purpose — the `error:{message}` encoding stays
        // exactly as it was, so every `LIKE 'error:%'` predicate and every
        // pre-existing row keeps working with no backfill.
        ensure_error_detail_column(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn insert(&self, job: &Job) -> Result<(), GoopError> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO jobs (id, kind, state, payload, result, priority, attempts, created_at, started_at, finished_at, error_detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
                // Enqueue always inserts a Queued job, so this is None in
                // practice — but carrying it keeps insert and update_state
                // symmetric, so a Job round-tripped through insert can't
                // silently lose its detail.
                match &job.state {
                    JobState::Error { detail, .. } => detail.as_ref(),
                    _ => None,
                },
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
        // Written unconditionally rather than COALESCEd: every non-error
        // state must CLEAR it. A retry goes error → queued → running, and if
        // the old detail survived that, a second failure carrying none would
        // display the first attempt's stderr as though it were its own.
        let error_detail: Option<&String> = match state {
            JobState::Error { detail, .. } => detail.as_ref(),
            _ => None,
        };
        let updated = c
            .execute(
                "UPDATE jobs SET state = ?2, result = ?3,
                started_at = COALESCE(?4, started_at),
                finished_at = COALESCE(?5, finished_at),
                error_detail = ?6
             WHERE id = ?1",
                params![
                    id.0.to_string(),
                    state_to_str(state),
                    result.and_then(|r| serde_json::to_string(r).ok()),
                    started_at,
                    finished_at,
                    error_detail,
                ],
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        if updated != 1 {
            return Err(GoopError::Queue(
                "job state was not persisted: expected exactly one row".into(),
            ));
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Job>, GoopError> {
        let c = self.conn.lock();
        // `hidden_from_queue = 0` excludes finished jobs that the user
        // cleared from the queue tab. History (`list_terminal`) ignores
        // the flag so cleared jobs still show up there.
        let mut stmt = c
            .prepare(
                "SELECT id, kind, state, payload, result, priority, attempts, created_at, started_at, finished_at, error_detail
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

    /// Return every extract job, including terminal rows hidden from the
    /// queue tab. Startup partial cleanup uses historical payloads to discover
    /// output directories and active/error rows to protect resumable files.
    pub fn list_extract_jobs(&self) -> Result<Vec<Job>, GoopError> {
        let c = self.conn.lock();
        let mut stmt = c
            .prepare(
                "SELECT id, kind, state, payload, result, priority, attempts, created_at, started_at, finished_at, error_detail
                 FROM jobs WHERE kind = 'extract'
                 ORDER BY created_at ASC",
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let rows = stmt
            .query_map([], row_to_job)
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| GoopError::Queue(e.to_string()))?);
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

    /// `now_ms` gates rows a yielded worker parked with a future
    /// `not_before` deadline (debrid waiting-on-TorBox polls) — they stay
    /// invisible to the claim loop until the deadline passes.
    pub fn next_queued(&self, kind: &JobKind, now_ms: i64) -> Result<Option<Job>, GoopError> {
        let c = self.conn.lock();
        let mut stmt = c
            .prepare(
                "SELECT id, kind, state, payload, result, priority, attempts, created_at, started_at, finished_at, error_detail
                 FROM jobs WHERE state = 'queued' AND kind = ?1
                   AND (not_before IS NULL OR not_before <= ?2)
                 ORDER BY priority DESC, created_at ASC LIMIT 1",
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let mut rows = stmt
            .query_map(params![kind_to_str(kind), now_ms], row_to_job)
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        match rows.next() {
            Some(Ok(j)) => Ok(Some(j)),
            Some(Err(e)) => Err(GoopError::Queue(e.to_string())),
            None => Ok(None),
        }
    }

    /// Rewrite a job's stored payload. The debrid path uses this for the
    /// TorBox item handle and exact child partial locations, so poll cycles,
    /// retries, and startup cleanup can resume without re-submitting or
    /// recursively scanning the output root.
    pub fn update_payload(&self, id: JobId, payload: &serde_json::Value) -> Result<(), GoopError> {
        let c = self.conn.lock();
        let updated = c
            .execute(
                "UPDATE jobs SET payload = ?2 WHERE id = ?1",
                params![
                    id.0.to_string(),
                    serde_json::to_string(payload).map_err(|e| GoopError::Queue(e.to_string()))?,
                ],
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        if updated == 1 {
            Ok(())
        } else {
            Err(GoopError::Queue(format!("job not found: {id:?}")))
        }
    }

    /// Patch one internal field while holding the same write transaction used
    /// to read it, so independent recovery callbacks cannot erase each other.
    pub fn patch_payload_field(
        &self,
        id: JobId,
        key: &str,
        value: serde_json::Value,
    ) -> Result<(), GoopError> {
        let mut connection = self.conn.lock();
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let raw: String = tx
            .query_row(
                "SELECT payload FROM jobs WHERE id = ?1",
                params![id.0.to_string()],
                |row| row.get(0),
            )
            .map_err(|e| GoopError::Queue(format!("cannot read job {id:?}: {e}")))?;
        let mut payload: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| GoopError::Queue(e.to_string()))?;
        payload
            .as_object_mut()
            .ok_or_else(|| GoopError::Queue("extract payload is not an object".into()))?
            .insert(key.into(), value);
        tx.execute(
            "UPDATE jobs SET payload = ?2 WHERE id = ?1",
            params![id.0.to_string(), payload.to_string()],
        )
        .map_err(|e| GoopError::Queue(e.to_string()))?;
        tx.commit().map_err(|e| GoopError::Queue(e.to_string()))
    }

    /// Yield a running job back to the queue with a wake-up deadline: the
    /// worker found its external dependency (TorBox fetch) not ready and
    /// released its concurrency permit instead of blocking on it. Guarded
    /// on `running` so a cancel that already finalized the row wins.
    pub fn requeue_with_delay(&self, id: JobId, not_before_ms: i64) -> Result<usize, GoopError> {
        let c = self.conn.lock();
        let n = c
            .execute(
                "UPDATE jobs SET state = 'queued', started_at = NULL, not_before = ?2
                 WHERE id = ?1 AND state = 'running'",
                params![id.0.to_string(), not_before_ms],
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(n)
    }

    /// On boot, flip any `running` jobs to `error{reason:"interrupted"}`
    /// and return their IDs/kinds so the host can record terminal outcomes.
    pub fn reconcile(&self) -> Result<Vec<(JobId, JobKind)>, GoopError> {
        let mut c = self.conn.lock();
        let tx = c
            .transaction()
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        let interrupted = {
            let mut stmt = tx
                .prepare(
                    "SELECT id, kind FROM jobs WHERE state = 'running' ORDER BY created_at ASC",
                )
                .map_err(|e| GoopError::Queue(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    let id: String = row.get(0)?;
                    let id = uuid::Uuid::parse_str(&id).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;
                    let kind = str_to_kind(&row.get::<_, String>(1)?)
                        .ok_or(rusqlite::Error::InvalidQuery)?;
                    Ok((JobId(id), kind))
                })
                .map_err(|e| GoopError::Queue(e.to_string()))?;
            let mut interrupted = Vec::new();
            for row in rows {
                interrupted.push(row.map_err(|e| GoopError::Queue(e.to_string()))?);
            }
            interrupted
        };
        let updated = tx
            .execute(
                "UPDATE jobs SET state = ?1, finished_at = ?2, error_detail = NULL
                 WHERE state = 'running'",
                params![
                    state_to_str(&JobState::Error {
                        message: "interrupted".into(),
                        detail: None
                    }),
                    now_ms()
                ],
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        if updated != interrupted.len() {
            return Err(GoopError::Queue(format!(
                "reconciled {updated} running rows after selecting {}",
                interrupted.len()
            )));
        }
        tx.commit().map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(interrupted)
    }

    /// Reset rows left in `paused` state from a previous run back to
    /// `queued` — EXCEPT extract jobs. An extract pause is a graceful stop
    /// with resumable partial files on disk, so Paused legitimately
    /// survives a restart and the user resumes it on their own terms.
    /// Every other kind was a suspended child process that died with the
    /// app, so those re-run from scratch on next pull. Called once at
    /// startup before workers begin pulling. Returns the number of rows
    /// reset.
    pub fn recover_paused(&self) -> Result<usize, GoopError> {
        let c = self.conn.lock();
        let n = c
            .execute(
                "UPDATE jobs SET state = ?1, started_at = NULL
                 WHERE state = 'paused' AND kind != 'extract'",
                params![state_to_str(&JobState::Queued)],
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(n)
    }

    /// Flip a paused job back to `queued`, clear `started_at`, and bump it
    /// ahead of everything currently queued so it restarts promptly — the
    /// user explicitly asked for it back. A single atomic UPDATE: returns
    /// 0 when the job isn't paused (already resumed, completed, unknown),
    /// letting the caller distinguish without a read-modify-write race.
    ///
    /// Dedicated method rather than `update_state` because that method's
    /// COALESCE semantics can never NULL-out `started_at`.
    pub fn requeue_paused(&self, id: JobId) -> Result<usize, GoopError> {
        let c = self.conn.lock();
        let n = c
            .execute(
                "UPDATE jobs SET state = ?2, started_at = NULL,
                    priority = (SELECT COALESCE(MAX(priority), 0) + 10
                                FROM jobs WHERE state = 'queued')
                 WHERE id = ?1 AND state = 'paused'",
                params![id.0.to_string(), state_to_str(&JobState::Queued)],
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(n)
    }

    /// Atomically claim a queued job for execution: `queued` → `running`
    /// with `started_at` set, in one state-guarded UPDATE. Returns 0 when
    /// the row is no longer `queued` — a cancel (or anything else) that
    /// landed between the scheduler's poll and this claim finalized the
    /// row, and the job must not run. This is the claim-side counterpart
    /// of `cancel_inactive`'s guard.
    pub fn claim_queued(&self, id: JobId, now_ms: i64) -> Result<usize, GoopError> {
        let c = self.conn.lock();
        // not_before is cleared on claim so a stale yield deadline can't
        // delay later cycles (e.g. a pause→resume requeue of the same row).
        let n = c
            .execute(
                "UPDATE jobs SET state = ?2, started_at = ?3, not_before = NULL
                 WHERE id = ?1 AND state = 'queued'",
                params![id.0.to_string(), state_to_str(&JobState::Running), now_ms],
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(n)
    }

    /// Finalize a job that has no live worker to report for it: queued
    /// and paused rows flip straight to `cancelled` with `finished_at`
    /// set, so they land in History like any other cancel. Running rows
    /// are the worker's responsibility (the scheduler fires their cancel
    /// token instead) and terminal rows are left alone — the state check
    /// lives inside the single atomic UPDATE so there is no window for a
    /// worker pickup to slip between a read and a write. Returns rows
    /// affected.
    pub fn cancel_inactive(&self, id: JobId) -> Result<usize, GoopError> {
        let c = self.conn.lock();
        let n = c
            .execute(
                "UPDATE jobs SET state = ?2, finished_at = ?3
                 WHERE id = ?1 AND state IN ('queued', 'paused')",
                params![
                    id.0.to_string(),
                    state_to_str(&JobState::Cancelled),
                    now_ms()
                ],
            )
            .map_err(|e| GoopError::Queue(e.to_string()))?;
        Ok(n)
    }

    /// Manual retry: flip an errored job back to `queued` on the SAME row.
    /// Clears `result`/`started_at`/`finished_at`, increments `attempts`
    /// (attempts counts user-initiated retries), un-hides the row from the
    /// queue tab, and bumps it to the front — it already waited its turn
    /// once. The `LIKE 'error:%'` predicate matches every persisted error
    /// including boot-reconcile's `error:interrupted`, which makes a job
    /// that died with the app recoverable in one click. Returns 0 when the
    /// job isn't in an error state.
    pub fn retry_errored(&self, id: JobId) -> Result<usize, GoopError> {
        let c = self.conn.lock();
        let n = c
            .execute(
                // `error_detail` is cleared here for the same reason `result`
                // is: this row is no longer describing the attempt that
                // failed. `update_state` would overwrite it at the next
                // terminal write anyway, but leaving it set in the meantime
                // means a queued or running row carries the previous
                // attempt's stderr — true only by accident of nothing
                // reading the column outside an error state.
                "UPDATE jobs SET state = ?2, result = NULL, started_at = NULL,
                    finished_at = NULL, attempts = attempts + 1, hidden_from_queue = 0,
                    error_detail = NULL,
                    priority = (SELECT COALESCE(MAX(priority), 0) + 10
                                FROM jobs WHERE state = 'queued')
                 WHERE id = ?1 AND state LIKE 'error:%'",
                params![id.0.to_string(), state_to_str(&JobState::Queued)],
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
                "SELECT id, kind, state, payload, result, priority, attempts, created_at, started_at, finished_at, error_detail
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
            "SELECT id, kind, state, payload, result, priority, attempts, created_at, started_at, finished_at, error_detail
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
        state: str_to_state(&row.get::<_, String>(2)?, row.get::<_, Option<String>>(10)?)
            .ok_or(rusqlite::Error::InvalidQuery)?,
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
        JobKind::Image => "image",
        JobKind::Metadata => "metadata",
    }
}

fn str_to_kind(s: &str) -> Option<JobKind> {
    match s {
        "extract" => Some(JobKind::Extract),
        "convert" => Some(JobKind::Convert),
        "pdf" => Some(JobKind::Pdf),
        "image" => Some(JobKind::Image),
        "metadata" => Some(JobKind::Metadata),
        _ => None,
    }
}

fn state_to_str(s: &JobState) -> String {
    match s {
        JobState::Queued => "queued".into(),
        JobState::Running => "running".into(),
        JobState::Paused => "paused".into(),
        JobState::Done => "done".into(),
        JobState::Cancelled => "cancelled".into(),
        // `detail` is deliberately NOT encoded here. Keeping the string form
        // as `error:{message}` is what lets every `LIKE 'error:%'` predicate
        // and every row written before this column existed keep working.
        JobState::Error { message, .. } => format!("error:{message}"),
    }
}

fn str_to_state(s: &str, detail: Option<String>) -> Option<JobState> {
    if let Some(msg) = s.strip_prefix("error:") {
        return Some(JobState::Error {
            message: msg.into(),
            detail,
        });
    }
    match s {
        "queued" => Some(JobState::Queued),
        "running" => Some(JobState::Running),
        "paused" => Some(JobState::Paused),
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

/// Idempotent migration for the `error_detail` column. Same shape as
/// `ensure_hidden_from_queue_column`, and specialized for the same reason:
/// the table, column and declaration stay compile-time literals rather than
/// identifiers formatted into raw SQL.
fn ensure_error_detail_column(conn: &Connection) -> Result<(), GoopError> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name = 'error_detail'")
        .map_err(|e| GoopError::Queue(e.to_string()))?;
    let exists = stmt
        .exists([])
        .map_err(|e| GoopError::Queue(e.to_string()))?;
    if !exists {
        conn.execute("ALTER TABLE jobs ADD COLUMN error_detail TEXT", [])
            .map_err(|e| GoopError::Queue(e.to_string()))?;
    }
    Ok(())
}

fn ensure_not_before_column(conn: &Connection) -> Result<(), GoopError> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name = 'not_before'")
        .map_err(|e| GoopError::Queue(e.to_string()))?;
    let exists = stmt
        .exists([])
        .map_err(|e| GoopError::Queue(e.to_string()))?;
    if !exists {
        conn.execute("ALTER TABLE jobs ADD COLUMN not_before INTEGER", [])
            .map_err(|e| GoopError::Queue(e.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use goop_core::ResultKind;
    use tempfile::tempdir;

    fn temp_store() -> (QueueStore, tempfile::TempDir) {
        let d = tempdir().unwrap();
        let s = QueueStore::open(&d.path().join("q.db")).unwrap();
        (s, d)
    }

    #[test]
    fn missing_job_state_update_cannot_claim_persistence() {
        let (store, _dir) = temp_store();
        assert!(store
            .update_state(JobId::new(), &JobState::Done, None, 1)
            .is_err());
    }

    /// Persisting a failure keeps the raw detail alongside the friendly
    /// message, and hands both back on every read path.
    #[test]
    fn error_detail_round_trips_through_get_and_list() {
        let (s, _tmp) = temp_store();
        let j = Job::new(JobKind::Extract, serde_json::Value::Null);
        s.insert(&j).unwrap();
        let state = JobState::Error {
            message: "yt-dlp: This video is unavailable.".into(),
            detail: Some("ERROR: [youtube] abc: Video unavailable\nTraceback...".into()),
        };
        s.update_state(j.id, &state, None, 1).unwrap();

        let got = s.get_by_id(j.id).unwrap().expect("job");
        assert_eq!(got.state, state, "get_by_id must return message and detail");

        let listed = s.list_terminal(&HistoryFilter::default()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].state, state, "list_terminal must too");
    }

    /// A failure with nothing worth keeping stores NULL rather than an empty
    /// string, so `detail: None` survives the round trip unchanged.
    #[test]
    fn error_without_detail_round_trips_as_none() {
        let (s, _tmp) = temp_store();
        let j = Job::new(JobKind::Convert, serde_json::Value::Null);
        s.insert(&j).unwrap();
        let state = JobState::Error {
            message: "cancelled by user".into(),
            detail: None,
        };
        s.update_state(j.id, &state, None, 1).unwrap();
        assert_eq!(s.get_by_id(j.id).unwrap().unwrap().state, state);
    }

    /// Retrying clears the previous run's detail. Otherwise a second failure
    /// that carries none would display the first attempt's stderr as if it
    /// were its own.
    #[test]
    fn retrying_clears_the_previous_detail() {
        let (s, _tmp) = temp_store();
        let j = Job::new(JobKind::Extract, serde_json::Value::Null);
        s.insert(&j).unwrap();
        s.update_state(
            j.id,
            &JobState::Error {
                message: "first".into(),
                detail: Some("first stderr".into()),
            },
            None,
            1,
        )
        .unwrap();
        s.retry_errored(j.id).unwrap();
        s.update_state(
            j.id,
            &JobState::Error {
                message: "second".into(),
                detail: None,
            },
            None,
            2,
        )
        .unwrap();
        assert_eq!(
            s.get_by_id(j.id).unwrap().unwrap().state,
            JobState::Error {
                message: "second".into(),
                detail: None,
            },
            "the first attempt's stderr must not resurface on the second failure"
        );
    }

    /// The column itself must be clear while the row is queued, not merely
    /// invisible through `str_to_state`. A queued row holding the previous
    /// attempt's stderr is stale data waiting for the first query that reads
    /// the column directly.
    #[test]
    fn retrying_clears_the_detail_column_itself() {
        let (s, _tmp) = temp_store();
        let j = Job::new(JobKind::Extract, serde_json::Value::Null);
        s.insert(&j).unwrap();
        s.update_state(
            j.id,
            &JobState::Error {
                message: "boom".into(),
                detail: Some("stderr from the first attempt".into()),
            },
            None,
            1,
        )
        .unwrap();
        s.retry_errored(j.id).unwrap();

        let stored: Option<String> = s
            .conn
            .lock()
            .query_row(
                "SELECT error_detail FROM jobs WHERE id = ?1",
                params![j.id.0.to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, None, "a queued row must not hold a stale detail");
    }

    /// A database written before the column existed must still open, and its
    /// error rows must load with `detail: None` rather than failing the read.
    #[test]
    fn pre_existing_database_without_the_column_still_loads() {
        let d = tempdir().unwrap();
        let path = d.path().join("q.db");
        {
            let s = QueueStore::open(&path).unwrap();
            let j = Job::new(JobKind::Extract, serde_json::Value::Null);
            s.insert(&j).unwrap();
            s.update_state(
                j.id,
                &JobState::Error {
                    message: "old failure".into(),
                    detail: None,
                },
                None,
                1,
            )
            .unwrap();
        }
        // Drop the column to reproduce a pre-migration file, then reopen.
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute("ALTER TABLE jobs DROP COLUMN error_detail", [])
                .expect("sqlite >= 3.35 supports DROP COLUMN");
        }
        let s = QueueStore::open(&path).unwrap();
        let all = s.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(
            all[0].state,
            JobState::Error {
                message: "old failure".into(),
                detail: None,
            }
        );
    }

    /// A file that isn't a database must be refused, not adopted. The startup
    /// dialog tells the user their queue file is damaged or unreadable; this
    /// pins the half of that claim that lives down here.
    #[test]
    fn a_file_that_is_not_a_database_is_refused() {
        let d = tempdir().unwrap();
        let path = d.path().join("q.db");
        std::fs::write(&path, b"this is not a database").unwrap();

        // `.err().expect(..)` rather than `.expect_err(..)`: the latter needs
        // `QueueStore: Debug`, and the struct derives only Clone.
        let e = QueueStore::open(&path)
            .err()
            .expect("garbage must not be adopted as a queue");
        assert!(matches!(e, GoopError::Queue(_)), "got {e:?}");
    }

    /// The startup dialog promises that moving the queue file aside gets the
    /// user a working Goop back. That promise is the reason the dialog is
    /// worth showing at all, so it is asserted here — the dialog itself can't
    /// be, since it runs inside the Tauri setup closure and ends in
    /// `process::exit`.
    #[test]
    fn moving_a_damaged_queue_file_aside_lets_the_next_open_rebuild_it() {
        let d = tempdir().unwrap();
        let path = d.path().join("q.db");
        std::fs::write(&path, b"this is not a database").unwrap();
        assert!(QueueStore::open(&path).is_err());

        // Exactly what the dialog asks the user to do.
        std::fs::rename(&path, d.path().join("q.db.moved")).unwrap();

        let s = QueueStore::open(&path).expect("a fresh queue must take its place");
        assert!(
            s.list().unwrap().is_empty(),
            "the rebuilt queue starts empty"
        );
    }

    /// Opening the same file twice must not fail on the ALTER.
    #[test]
    fn migration_is_idempotent_across_reopens() {
        let d = tempdir().unwrap();
        let path = d.path().join("q.db");
        let first = QueueStore::open(&path).unwrap();
        drop(first);
        let second = QueueStore::open(&path).expect("second open must not re-run the ALTER");
        assert!(second.list().unwrap().is_empty());
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
    fn list_extract_jobs_includes_hidden_rows_and_excludes_other_kinds() {
        let (s, _tmp) = temp_store();
        let active = Job::new(
            JobKind::Extract,
            serde_json::json!({"url":"https://active"}),
        );
        let mut finished = Job::new(
            JobKind::Extract,
            serde_json::json!({"url":"https://finished"}),
        );
        finished.state = JobState::Done;
        let mut convert = Job::new(JobKind::Convert, serde_json::Value::Null);
        convert.state = JobState::Done;
        for job in [&active, &finished, &convert] {
            s.insert(job).unwrap();
        }
        s.clear_completed().unwrap();

        let jobs = s.list_extract_jobs().unwrap();
        let ids: Vec<_> = jobs.into_iter().map(|job| job.id).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&active.id));
        assert!(ids.contains(&finished.id));
        assert!(!ids.contains(&convert.id));
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
        let n = s.next_queued(&JobKind::Extract, 0).unwrap().unwrap();
        assert_eq!(n.id, b.id);
    }

    #[test]
    fn payload_field_patches_preserve_concurrent_fields_and_reopened_retry() {
        let (store, tmp) = temp_store();
        let mut job = Job::new(JobKind::Extract, serde_json::json!({"url":"original"}));
        job.state = JobState::Running;
        store.insert(&job).unwrap();
        std::thread::scope(|scope| {
            for index in 0..16 {
                let store = &store;
                let id = job.id;
                scope.spawn(move || {
                    store
                        .patch_payload_field(id, &format!("field{index}"), serde_json::json!(index))
                        .unwrap()
                });
            }
        });
        let payload = store.get_by_id(job.id).unwrap().unwrap().payload;
        assert_eq!(payload.as_object().unwrap().len(), 17);
        let path = tmp.path().join("q.db");
        drop(store);
        let store = QueueStore::open(&path).unwrap();
        store.reconcile().unwrap();
        store.retry_errored(job.id).unwrap();
        assert_eq!(store.get_by_id(job.id).unwrap().unwrap().payload, payload);
    }

    #[test]
    fn update_payload_rewrites_payload_in_place() {
        let (s, _tmp) = temp_store();
        let j = Job::new(JobKind::Extract, serde_json::json!({"url":"magnet:?xt=x"}));
        s.insert(&j).unwrap();
        s.update_payload(
            j.id,
            &serde_json::json!({"url":"magnet:?xt=x","debrid_item":"torrent:7"}),
        )
        .unwrap();
        let row = s.get_by_id(j.id).unwrap().unwrap();
        assert_eq!(row.payload["debrid_item"], "torrent:7");
        assert_eq!(row.payload["url"], "magnet:?xt=x");
    }

    #[test]
    fn update_payload_rejects_an_unknown_job() {
        let (s, _tmp) = temp_store();

        let error = s
            .update_payload(JobId::new(), &serde_json::json!({"url":"https://x"}))
            .unwrap_err();

        assert!(error.to_string().contains("job not found"));
    }

    #[test]
    fn next_queued_skips_rows_delayed_by_not_before() {
        let (s, _tmp) = temp_store();
        let j = Job::new(JobKind::Extract, serde_json::Value::Null);
        s.insert(&j).unwrap();
        s.claim_queued(j.id, 1_000).unwrap();
        assert_eq!(s.requeue_with_delay(j.id, 6_000).unwrap(), 1);

        assert!(
            s.next_queued(&JobKind::Extract, 5_999).unwrap().is_none(),
            "a delayed row must not be claimable before its deadline"
        );
        let picked = s.next_queued(&JobKind::Extract, 6_000).unwrap().unwrap();
        assert_eq!(picked.id, j.id);
    }

    #[test]
    fn requeue_with_delay_only_flips_running_rows_and_clears_started_at() {
        let (s, _tmp) = temp_store();
        let j = Job::new(JobKind::Extract, serde_json::Value::Null);
        s.insert(&j).unwrap();

        // Still queued — nothing to requeue.
        assert_eq!(s.requeue_with_delay(j.id, 5_000).unwrap(), 0);

        s.claim_queued(j.id, 1_000).unwrap();
        assert_eq!(s.requeue_with_delay(j.id, 5_000).unwrap(), 1);
        let row = s
            .list()
            .unwrap()
            .into_iter()
            .find(|x| x.id == j.id)
            .unwrap();
        assert!(matches!(row.state, JobState::Queued), "got {:?}", row.state);
        assert!(row.started_at.is_none(), "yield must clear started_at");

        // A cancelled row must not be revivable via requeue.
        s.cancel_inactive(j.id).unwrap();
        assert_eq!(s.requeue_with_delay(j.id, 9_000).unwrap(), 0);
    }

    #[test]
    fn claim_clears_not_before_so_later_cycles_start_fresh() {
        let (s, _tmp) = temp_store();
        let j = Job::new(JobKind::Extract, serde_json::Value::Null);
        s.insert(&j).unwrap();
        s.claim_queued(j.id, 1_000).unwrap();
        s.requeue_with_delay(j.id, 6_000).unwrap();
        assert_eq!(s.claim_queued(j.id, 6_500).unwrap(), 1);

        // Re-queue through a path that sets no delay (pause→resume style):
        // the old deadline must not linger and block the pickup.
        s.update_state(j.id, &JobState::Queued, None, 7_000)
            .unwrap();
        let picked = s.next_queued(&JobKind::Extract, 0).unwrap();
        assert_eq!(
            picked.map(|p| p.id),
            Some(j.id),
            "stale not_before must not survive a claim"
        );
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
        let next = s.next_queued(&JobKind::Extract, 0).unwrap().unwrap();
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
            detail: None,
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
    fn recover_paused_resets_to_queued_and_clears_started_at() {
        let (s, _tmp) = temp_store();
        let job = Job::new(JobKind::Convert, serde_json::Value::Null);
        s.insert(&job).unwrap();
        // Mark it Paused with a started_at to simulate a job that was running
        // before the previous app exit.
        s.update_state(job.id, &JobState::Running, None, 1234)
            .unwrap();
        s.update_state(job.id, &JobState::Paused, None, 5678)
            .unwrap();

        let n = s.recover_paused().unwrap();
        assert_eq!(n, 1);

        let after = s.get_by_id(job.id).unwrap().expect("row");
        assert_eq!(after.state, JobState::Queued);
        assert!(after.started_at.is_none(), "started_at must be cleared");
    }

    #[test]
    fn recover_paused_is_noop_when_no_paused_rows() {
        let (s, _tmp) = temp_store();
        let job = Job::new(JobKind::Extract, serde_json::Value::Null);
        s.insert(&job).unwrap();
        let n = s.recover_paused().unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn recover_paused_keeps_extract_rows_paused() {
        let (s, _tmp) = temp_store();
        let extract = Job::new(JobKind::Extract, serde_json::Value::Null);
        let convert = Job::new(JobKind::Convert, serde_json::Value::Null);
        for j in [&extract, &convert] {
            s.insert(j).unwrap();
            s.update_state(j.id, &JobState::Running, None, 1234)
                .unwrap();
            s.update_state(j.id, &JobState::Paused, None, 5678).unwrap();
        }

        let n = s.recover_paused().unwrap();
        assert_eq!(n, 1, "only the convert row should be recovered");

        let e = s.get_by_id(extract.id).unwrap().expect("row");
        assert_eq!(e.state, JobState::Paused, "extract stays paused");
        assert!(e.started_at.is_some(), "extract row untouched");

        let c = s.get_by_id(convert.id).unwrap().expect("row");
        assert_eq!(c.state, JobState::Queued);
        assert!(c.started_at.is_none());
    }

    #[test]
    fn requeue_paused_sets_queued_clears_started_at_and_outprioritizes_queue() {
        let (s, _tmp) = temp_store();
        let mut waiting_a = Job::new(JobKind::Extract, serde_json::Value::Null);
        let mut waiting_b = Job::new(JobKind::Extract, serde_json::Value::Null);
        waiting_a.priority = 20;
        waiting_b.priority = 10;
        s.insert(&waiting_a).unwrap();
        s.insert(&waiting_b).unwrap();

        let paused = Job::new(JobKind::Extract, serde_json::Value::Null);
        s.insert(&paused).unwrap();
        s.update_state(paused.id, &JobState::Running, None, 1234)
            .unwrap();
        s.update_state(paused.id, &JobState::Paused, None, 5678)
            .unwrap();

        let n = s.requeue_paused(paused.id).unwrap();
        assert_eq!(n, 1);

        let after = s.get_by_id(paused.id).unwrap().expect("row");
        assert_eq!(after.state, JobState::Queued);
        assert!(after.started_at.is_none(), "started_at must be cleared");
        assert!(
            after.priority > waiting_a.priority,
            "resumed job must outprioritize the existing queue"
        );
        let next = s.next_queued(&JobKind::Extract, 0).unwrap().unwrap();
        assert_eq!(next.id, paused.id);
    }

    #[test]
    fn requeue_paused_returns_zero_when_not_paused() {
        let (s, _tmp) = temp_store();
        let queued = Job::new(JobKind::Extract, serde_json::Value::Null);
        let mut running = Job::new(JobKind::Extract, serde_json::Value::Null);
        running.state = JobState::Running;
        s.insert(&queued).unwrap();
        s.insert(&running).unwrap();
        assert_eq!(s.requeue_paused(queued.id).unwrap(), 0);
        assert_eq!(s.requeue_paused(running.id).unwrap(), 0);
        assert_eq!(s.requeue_paused(JobId::new()).unwrap(), 0);
    }

    #[test]
    fn retry_errored_resets_row_clears_result_and_finished_at_and_increments_attempts() {
        let (s, _tmp) = temp_store();
        let job = Job::new(JobKind::Extract, serde_json::json!({"url":"https://x"}));
        s.insert(&job).unwrap();
        s.update_state(job.id, &JobState::Running, None, 1000)
            .unwrap();
        // Seed with the boot-reconcile shape specifically: retry must also
        // recover jobs that died with the app ("error:interrupted").
        s.update_state(
            job.id,
            &JobState::Error {
                message: "interrupted".into(),
                detail: None,
            },
            None,
            2000,
        )
        .unwrap();

        let n = s.retry_errored(job.id).unwrap();
        assert_eq!(n, 1);

        let after = s.get_by_id(job.id).unwrap().expect("row");
        assert_eq!(after.state, JobState::Queued);
        assert_eq!(after.attempts, 1);
        assert!(after.result.is_none());
        assert!(after.started_at.is_none());
        assert!(after.finished_at.is_none());
        // A previously cleared-from-queue row must reappear in the queue tab.
        assert!(s.list().unwrap().iter().any(|j| j.id == job.id));
    }

    #[test]
    fn claim_queued_transitions_to_running_and_sets_started_at() {
        let (s, _tmp) = temp_store();
        let job = Job::new(JobKind::Extract, serde_json::Value::Null);
        s.insert(&job).unwrap();
        assert_eq!(s.claim_queued(job.id, 4242).unwrap(), 1);
        let after = s.get_by_id(job.id).unwrap().unwrap();
        assert_eq!(after.state, JobState::Running);
        assert_eq!(after.started_at, Some(4242));
    }

    #[test]
    fn claim_queued_misses_rows_that_left_the_queued_state() {
        // The cancel-vs-claim race: a job cancelled between the scheduler's
        // poll and its claim must not be resurrected to running.
        let (s, _tmp) = temp_store();
        let job = Job::new(JobKind::Extract, serde_json::Value::Null);
        s.insert(&job).unwrap();
        assert_eq!(s.cancel_inactive(job.id).unwrap(), 1);
        assert_eq!(s.claim_queued(job.id, 4242).unwrap(), 0);
        let after = s.get_by_id(job.id).unwrap().unwrap();
        assert_eq!(after.state, JobState::Cancelled, "cancel must stick");
        assert!(after.finished_at.is_some());
    }

    #[test]
    fn cancel_inactive_finalizes_queued_and_paused_rows() {
        let (s, _tmp) = temp_store();
        let queued = Job::new(JobKind::Extract, serde_json::Value::Null);
        let paused = Job::new(JobKind::Extract, serde_json::Value::Null);
        s.insert(&queued).unwrap();
        s.insert(&paused).unwrap();
        s.update_state(paused.id, &JobState::Paused, None, 1000)
            .unwrap();

        assert_eq!(s.cancel_inactive(queued.id).unwrap(), 1);
        assert_eq!(s.cancel_inactive(paused.id).unwrap(), 1);
        for id in [queued.id, paused.id] {
            let j = s.get_by_id(id).unwrap().unwrap();
            assert_eq!(j.state, JobState::Cancelled);
            assert!(j.finished_at.is_some(), "cancelled rows belong in History");
        }
    }

    #[test]
    fn cancel_inactive_ignores_running_and_terminal_rows() {
        let (s, _tmp) = temp_store();
        let mut running = Job::new(JobKind::Extract, serde_json::Value::Null);
        let mut done = Job::new(JobKind::Extract, serde_json::Value::Null);
        running.state = JobState::Running;
        done.state = JobState::Done;
        s.insert(&running).unwrap();
        s.insert(&done).unwrap();

        assert_eq!(s.cancel_inactive(running.id).unwrap(), 0);
        assert_eq!(s.cancel_inactive(done.id).unwrap(), 0);
        assert_eq!(
            s.get_by_id(running.id).unwrap().unwrap().state,
            JobState::Running
        );
        assert_eq!(s.get_by_id(done.id).unwrap().unwrap().state, JobState::Done);
    }

    #[test]
    fn retry_errored_returns_zero_for_non_error_rows() {
        let (s, _tmp) = temp_store();
        let queued = Job::new(JobKind::Extract, serde_json::Value::Null);
        let mut done = Job::new(JobKind::Extract, serde_json::Value::Null);
        let mut cancelled = Job::new(JobKind::Extract, serde_json::Value::Null);
        done.state = JobState::Done;
        cancelled.state = JobState::Cancelled;
        for j in [&queued, &done, &cancelled] {
            s.insert(j).unwrap();
            assert_eq!(s.retry_errored(j.id).unwrap(), 0, "state {:?}", j.state);
        }
    }

    #[test]
    fn retry_errored_bumps_priority_above_existing_queued_and_unhides() {
        let (s, _tmp) = temp_store();
        let mut waiting = Job::new(JobKind::Extract, serde_json::Value::Null);
        waiting.priority = 50;
        s.insert(&waiting).unwrap();

        let mut failed = Job::new(JobKind::Extract, serde_json::Value::Null);
        failed.state = JobState::Error {
            message: "boom".into(),
            detail: None,
        };
        s.insert(&failed).unwrap();
        // Simulate the user having cleared completed jobs from the queue tab.
        s.clear_completed().unwrap();

        assert_eq!(s.retry_errored(failed.id).unwrap(), 1);
        let next = s.next_queued(&JobKind::Extract, 0).unwrap().unwrap();
        assert_eq!(next.id, failed.id, "retried job goes to the front");
        assert!(
            s.list().unwrap().iter().any(|j| j.id == failed.id),
            "retried job must be un-hidden from the queue tab"
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
        let interrupted = s.reconcile().unwrap();
        assert_eq!(interrupted, vec![(j.id, JobKind::Extract)]);
        let all = s.list().unwrap();
        assert!(
            matches!(&all[0].state, JobState::Error { message, .. } if message == "interrupted")
        );
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
            source_bytes: None,
            target_bytes: None,
            reencoded: None,
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
            result_kind: ResultKind::File,
            file_count: 1,
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
