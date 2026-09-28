use crate::store::QueueStore;
use goop_core::publication::{FileIdentity, PublicationObserver};
use goop_core::{GoopError, JobId, JobKind, JobResult, JobState};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

const JOURNAL_VERSION: u32 = 1;
const UNCERTAIN_MESSAGE: &str =
    "Output publication is uncertain; the output may already exist. Retry is disabled to prevent a duplicate.";

#[derive(Debug, Clone, PartialEq)]
pub struct PublicationRecovery {
    pub job_id: JobId,
    pub kind: JobKind,
    pub state: JobState,
    pub result: Option<JobResult>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PublicationFinalization {
    pub state: JobState,
    pub result: Option<JobResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicationRecord {
    version: u32,
    attempt_id: Uuid,
    payload: serde_json::Value,
    phase: PublicationPhase,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum PublicationPhase {
    Preparing,
    Intent {
        staged_path: PathBuf,
        destination: PathBuf,
        result: JobResult,
        staged_identity: FileIdentity,
    },
    Published {
        staged_path: PathBuf,
        destination: PathBuf,
        result: JobResult,
        identity: FileIdentity,
    },
}

struct QueuePublicationObserver {
    store: QueueStore,
    job_id: JobId,
    attempt_id: Uuid,
    payload: serde_json::Value,
}

impl QueueStore {
    pub fn begin_publication(
        &self,
        id: JobId,
        payload: &serde_json::Value,
    ) -> Result<Arc<dyn PublicationObserver>, GoopError> {
        let attempt_id = Uuid::now_v7();
        let record = PublicationRecord {
            version: JOURNAL_VERSION,
            attempt_id,
            payload: payload.clone(),
            phase: PublicationPhase::Preparing,
        };
        let serialized = serialize_record(&record)?;
        let mut connection = self.conn.lock();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(queue_error)?;
        let row: Option<(String, String, String)> = tx
            .query_row(
                "SELECT kind, state, payload FROM jobs WHERE id = ?1",
                params![id.0.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(queue_error)?;
        let Some((kind, state, stored_payload)) = row else {
            return Err(GoopError::Queue("publication job does not exist".into()));
        };
        let stored_payload: serde_json::Value =
            serde_json::from_str(&stored_payload).map_err(queue_error)?;
        if kind != "convert" || state != "running" || stored_payload != *payload {
            return Err(GoopError::Queue(
                "publication requires the matching running convert attempt".into(),
            ));
        }
        tx.execute(
            "INSERT INTO publication_journal (job_id, record) VALUES (?1, ?2)",
            params![id.0.to_string(), serialized],
        )
        .map_err(|e| GoopError::Queue(format!("publication attempt is unresolved: {e}")))?;
        tx.commit().map_err(queue_error)?;
        Ok(Arc::new(QueuePublicationObserver {
            store: self.clone(),
            job_id: id,
            attempt_id,
            payload: payload.clone(),
        }))
    }

    pub fn has_publication_journal(&self, id: JobId) -> Result<bool, GoopError> {
        let connection = self.conn.lock();
        let present: i64 = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM publication_journal WHERE job_id = ?1)",
                params![id.0.to_string()],
                |row| row.get(0),
            )
            .map_err(queue_error)?;
        Ok(present != 0)
    }

    pub fn update_live_process_state(
        &self,
        id: JobId,
        state: &JobState,
        now_ms: i64,
    ) -> Result<(), GoopError> {
        let (expected_state, next_state) = match state {
            JobState::Paused => ("running", "paused"),
            JobState::Running => ("paused", "running"),
            _ => {
                return Err(GoopError::Queue(
                    "live process state may only transition between running and paused".into(),
                ))
            }
        };
        let raw = self.load_journal(id)?;
        let Some(raw) = raw else {
            self.update_state(id, state, None, now_ms)?;
            return Ok(());
        };
        let record = parse_record(&raw)?;
        if !matches!(record.phase, PublicationPhase::Preparing) {
            return Err(GoopError::Queue(
                "live process state cannot change after publication was attempted".into(),
            ));
        }
        let mut connection = self.conn.lock();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(queue_error)?;
        let updated = tx
            .execute(
                "UPDATE jobs SET state = ?4,
                    started_at = CASE WHEN ?4 = 'running' THEN COALESCE(started_at, ?5) ELSE started_at END,
                    error_detail = NULL
                 WHERE id = ?1 AND kind = 'convert' AND state = ?3
                   AND payload = ?6
                   AND EXISTS (SELECT 1 FROM publication_journal
                               WHERE job_id = jobs.id AND record = ?2)",
                params![
                    id.0.to_string(),
                    raw,
                    expected_state,
                    next_state,
                    now_ms,
                    serde_json::to_string(&record.payload).map_err(queue_error)?
                ],
            )
            .map_err(queue_error)?;
        if updated != 1 {
            return Err(GoopError::Queue(
                "live process state no longer matches its preparing publication attempt".into(),
            ));
        }
        tx.commit().map_err(queue_error)
    }

    pub fn reconcile_publications(&self) -> Result<Vec<PublicationRecovery>, GoopError> {
        let snapshots = {
            let connection = self.conn.lock();
            let mut statement = connection
                .prepare(
                    "SELECT p.job_id, p.record, j.kind, j.state, j.payload
                     FROM publication_journal p JOIN jobs j ON j.id = p.job_id
                     ORDER BY j.created_at ASC",
                )
                .map_err(queue_error)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })
                .map_err(queue_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(queue_error)?
        };

        let mut recoveries = Vec::new();
        for (id, raw, kind, state, payload) in snapshots {
            let id = parse_job_id(&id)?;
            let parsed_payload = serde_json::from_str::<serde_json::Value>(&payload);
            let parsed = parse_record(&raw);
            let record = match (parsed, parsed_payload) {
                (Ok(record), Ok(payload)) if record.payload == payload && kind == "convert" => {
                    record
                }
                (Err(detail), _) => {
                    if let Some(recovery) = self.mark_uncertain_if_unchanged(
                        id,
                        &raw,
                        format!("publication journal could not be interpreted: {detail}"),
                    )? {
                        recoveries.push(recovery);
                    }
                    continue;
                }
                (_, Err(detail)) => {
                    if let Some(recovery) = self.mark_uncertain_if_unchanged(
                        id,
                        &raw,
                        format!("publication job payload could not be interpreted: {detail}"),
                    )? {
                        recoveries.push(recovery);
                    }
                    continue;
                }
                _ => {
                    if let Some(recovery) = self.mark_uncertain_if_unchanged(
                        id,
                        &raw,
                        "publication journal no longer matches its convert job".into(),
                    )? {
                        recoveries.push(recovery);
                    }
                    continue;
                }
            };

            match record.phase {
                PublicationPhase::Preparing => {
                    if state == "running" || state == "paused" {
                        if let Some(recovery) = self.consume_preparing_on_startup(id, &raw)? {
                            recoveries.push(recovery);
                        }
                    } else {
                        self.consume_unchanged_journal(id, &raw)?;
                    }
                }
                PublicationPhase::Intent { .. } => {
                    if let Some(recovery) = self.mark_uncertain_if_unchanged(
                        id,
                        &raw,
                        "the process stopped after publication intent was recorded".into(),
                    )? {
                        recoveries.push(recovery);
                    }
                }
                PublicationPhase::Published {
                    destination,
                    result,
                    identity,
                    ..
                } => {
                    if let Err(error) = validate_result_destination(&destination, &result)
                        .and_then(|()| identity.verify(&destination))
                    {
                        if let Some(recovery) = self.mark_uncertain_if_unchanged(
                            id,
                            &raw,
                            format!("published output identity could not be verified: {error}"),
                        )? {
                            recoveries.push(recovery);
                        }
                    } else if let Some(recovery) =
                        self.commit_published_if_unchanged(id, &raw, &result)?
                    {
                        recoveries.push(recovery);
                    }
                }
            }
        }
        Ok(recoveries)
    }

    pub fn finalize_worker(
        &self,
        id: JobId,
        payload: &serde_json::Value,
        proposed_state: &JobState,
        proposed_result: Option<&JobResult>,
        now_ms: i64,
    ) -> Result<PublicationFinalization, GoopError> {
        let raw = self.load_journal(id)?;
        let Some(raw) = raw else {
            self.update_state(id, proposed_state, proposed_result, now_ms)?;
            return Ok(PublicationFinalization {
                state: proposed_state.clone(),
                result: proposed_result.cloned(),
            });
        };
        let record = match parse_record(&raw) {
            Ok(record) if record.payload == *payload => record,
            Ok(_) => {
                return self.uncertain_finalization(
                    id,
                    &raw,
                    "publication journal payload changed".into(),
                )
            }
            Err(error) => {
                return self.uncertain_finalization(
                    id,
                    &raw,
                    format!("publication journal could not be interpreted: {error}"),
                )
            }
        };

        match record.phase {
            PublicationPhase::Preparing => {
                let (state, result) = if *proposed_state == JobState::Done {
                    (
                        JobState::Error {
                            message: "Conversion completed without a publication receipt.".into(),
                            detail: None,
                        },
                        None,
                    )
                } else {
                    (proposed_state.clone(), proposed_result.cloned())
                };
                self.commit_terminal_and_consume(id, &raw, &state, result.as_ref(), now_ms)?;
                Ok(PublicationFinalization { state, result })
            }
            PublicationPhase::Intent { .. } => self.uncertain_finalization(
                id,
                &raw,
                "publication was attempted without a durable receipt".into(),
            ),
            PublicationPhase::Published {
                destination,
                result,
                identity,
                ..
            } => {
                if *proposed_state == JobState::Done && proposed_result != Some(&result) {
                    return self.uncertain_finalization(
                        id,
                        &raw,
                        "worker result did not match the publication receipt".into(),
                    );
                }
                if let Err(error) = identity.verify(&destination) {
                    return self.uncertain_finalization(
                        id,
                        &raw,
                        format!("published output identity could not be verified: {error}"),
                    );
                }
                self.commit_terminal_and_consume(id, &raw, &JobState::Done, Some(&result), now_ms)?;
                Ok(PublicationFinalization {
                    state: JobState::Done,
                    result: Some(result),
                })
            }
        }
    }

    pub(crate) fn retain_finalization_failure(
        &self,
        id: JobId,
        payload: &serde_json::Value,
        failure: &JobState,
        now_ms: i64,
    ) -> Result<(), GoopError> {
        if !matches!(failure, JobState::Error { .. }) {
            return Err(GoopError::Queue(
                "publication failure must retain an error state".into(),
            ));
        }
        let raw = self.load_journal(id)?.ok_or_else(|| {
            GoopError::Queue("publication journal disappeared before failure recording".into())
        })?;
        let record = parse_record(&raw)?;
        if record.payload != *payload {
            return Err(GoopError::Queue(
                "publication failure no longer matches its attempt".into(),
            ));
        }
        if !self.update_job_if_journal_unchanged(id, &raw, failure, None, now_ms, false)? {
            return Err(GoopError::Queue(
                "publication journal changed before failure recording".into(),
            ));
        }
        Ok(())
    }

    fn load_journal(&self, id: JobId) -> Result<Option<String>, GoopError> {
        self.conn
            .lock()
            .query_row(
                "SELECT record FROM publication_journal WHERE job_id = ?1",
                params![id.0.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(queue_error)
    }

    fn uncertain_finalization(
        &self,
        id: JobId,
        raw: &str,
        detail: String,
    ) -> Result<PublicationFinalization, GoopError> {
        let state = uncertain_state(detail);
        if !self.update_job_if_journal_unchanged(id, raw, &state, None, now_ms(), false)? {
            return Err(GoopError::Queue(
                "publication journal changed while recording uncertainty".into(),
            ));
        }
        Ok(PublicationFinalization {
            state,
            result: None,
        })
    }

    fn mark_uncertain_if_unchanged(
        &self,
        id: JobId,
        raw: &str,
        detail: String,
    ) -> Result<Option<PublicationRecovery>, GoopError> {
        let state = uncertain_state(detail);
        if self.update_job_if_journal_unchanged(id, raw, &state, None, now_ms(), false)? {
            Ok(Some(PublicationRecovery {
                job_id: id,
                kind: JobKind::Convert,
                state,
                result: None,
            }))
        } else {
            Ok(None)
        }
    }

    fn consume_preparing_on_startup(
        &self,
        id: JobId,
        raw: &str,
    ) -> Result<Option<PublicationRecovery>, GoopError> {
        let state = JobState::Error {
            message: "interrupted".into(),
            detail: None,
        };
        if self.update_job_if_journal_unchanged(id, raw, &state, None, now_ms(), true)? {
            Ok(Some(PublicationRecovery {
                job_id: id,
                kind: JobKind::Convert,
                state,
                result: None,
            }))
        } else {
            Ok(None)
        }
    }

    fn commit_published_if_unchanged(
        &self,
        id: JobId,
        raw: &str,
        result: &JobResult,
    ) -> Result<Option<PublicationRecovery>, GoopError> {
        if self.update_job_if_journal_unchanged(
            id,
            raw,
            &JobState::Done,
            Some(result),
            now_ms(),
            true,
        )? {
            Ok(Some(PublicationRecovery {
                job_id: id,
                kind: JobKind::Convert,
                state: JobState::Done,
                result: Some(result.clone()),
            }))
        } else {
            Ok(None)
        }
    }

    fn consume_unchanged_journal(&self, id: JobId, raw: &str) -> Result<bool, GoopError> {
        let connection = self.conn.lock();
        let changed = connection
            .execute(
                "DELETE FROM publication_journal WHERE job_id = ?1 AND record = ?2",
                params![id.0.to_string(), raw],
            )
            .map_err(queue_error)?;
        Ok(changed == 1)
    }

    fn commit_terminal_and_consume(
        &self,
        id: JobId,
        raw: &str,
        state: &JobState,
        result: Option<&JobResult>,
        now_ms: i64,
    ) -> Result<(), GoopError> {
        if self.update_job_if_journal_unchanged(id, raw, state, result, now_ms, true)? {
            Ok(())
        } else {
            Err(GoopError::Queue(
                "publication journal changed during finalization".into(),
            ))
        }
    }

    fn update_job_if_journal_unchanged(
        &self,
        id: JobId,
        raw: &str,
        state: &JobState,
        result: Option<&JobResult>,
        now_ms: i64,
        consume: bool,
    ) -> Result<bool, GoopError> {
        let mut connection = self.conn.lock();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(queue_error)?;
        let unchanged: i64 = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM publication_journal WHERE job_id = ?1 AND record = ?2)",
                params![id.0.to_string(), raw],
                |row| row.get(0),
            )
            .map_err(queue_error)?;
        if unchanged == 0 {
            return Ok(false);
        }
        let finished_at = matches!(
            state,
            JobState::Done | JobState::Error { .. } | JobState::Cancelled
        )
        .then_some(now_ms);
        let detail = match state {
            JobState::Error { detail, .. } => detail.as_ref(),
            _ => None,
        };
        let serialized_result = result
            .map(serde_json::to_string)
            .transpose()
            .map_err(queue_error)?;
        let updated = tx
            .execute(
                "UPDATE jobs SET state = ?2, result = ?3,
                    finished_at = ?4, error_detail = ?5
                 WHERE id = ?1",
                params![
                    id.0.to_string(),
                    state_to_db(state),
                    serialized_result,
                    finished_at,
                    detail
                ],
            )
            .map_err(queue_error)?;
        if updated != 1 {
            return Err(GoopError::Queue(
                "publication finalization did not update exactly one job".into(),
            ));
        }
        if consume {
            let deleted = tx
                .execute(
                    "DELETE FROM publication_journal WHERE job_id = ?1 AND record = ?2",
                    params![id.0.to_string(), raw],
                )
                .map_err(queue_error)?;
            if deleted != 1 {
                return Err(GoopError::Queue(
                    "publication finalization did not consume its journal".into(),
                ));
            }
        }
        tx.commit().map_err(queue_error)?;
        Ok(true)
    }
}

impl PublicationObserver for QueuePublicationObserver {
    fn before_publish(
        &self,
        staged: &Path,
        destination: &Path,
        result: &JobResult,
    ) -> Result<(), GoopError> {
        validate_result_destination(destination, result)?;
        let identity = FileIdentity::capture(staged)?;
        let raw = self.store.load_journal(self.job_id)?.ok_or_else(|| {
            GoopError::Queue("publication journal disappeared before intent".into())
        })?;
        let mut record = parse_record(&raw)?;
        self.validate_record(&record)?;
        if matches!(record.phase, PublicationPhase::Published { .. }) {
            return Err(GoopError::Queue(
                "published attempt cannot record another intent".into(),
            ));
        }
        record.phase = PublicationPhase::Intent {
            staged_path: staged.to_path_buf(),
            destination: destination.to_path_buf(),
            result: result.clone(),
            staged_identity: identity,
        };
        self.replace_record(&raw, &record, "intent")
    }

    fn published(&self, destination: &Path, result: &JobResult) -> Result<(), GoopError> {
        validate_result_destination(destination, result)?;
        let raw = self.store.load_journal(self.job_id)?.ok_or_else(|| {
            GoopError::Queue("publication journal disappeared before receipt".into())
        })?;
        let mut record = parse_record(&raw)?;
        self.validate_record(&record)?;
        let identity = match &record.phase {
            PublicationPhase::Intent {
                staged_path,
                destination: intended_destination,
                result: intended_result,
                staged_identity,
            } if intended_destination == destination && intended_result == result => {
                (staged_path.clone(), staged_identity.clone())
            }
            _ => {
                return Err(GoopError::Queue(
                    "publication receipt does not match its recorded intent".into(),
                ))
            }
        };
        identity.1.verify(destination)?;
        record.phase = PublicationPhase::Published {
            staged_path: identity.0,
            destination: destination.to_path_buf(),
            result: result.clone(),
            identity: identity.1,
        };
        self.replace_record(&raw, &record, "receipt")
    }
}

impl QueuePublicationObserver {
    fn validate_record(&self, record: &PublicationRecord) -> Result<(), GoopError> {
        if record.version != JOURNAL_VERSION
            || record.attempt_id != self.attempt_id
            || record.payload != self.payload
        {
            return Err(GoopError::Queue(
                "stale publication observer was rejected".into(),
            ));
        }
        Ok(())
    }

    fn replace_record(
        &self,
        raw: &str,
        record: &PublicationRecord,
        operation: &str,
    ) -> Result<(), GoopError> {
        let serialized = serialize_record(record)?;
        let mut connection = self.store.conn.lock();
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(queue_error)?;
        let current: Option<(String, String, String)> = tx
            .query_row(
                "SELECT j.kind, j.state, j.payload
                 FROM jobs j JOIN publication_journal p ON p.job_id = j.id
                 WHERE j.id = ?1 AND p.record = ?2",
                params![self.job_id.0.to_string(), raw],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(queue_error)?;
        let Some((kind, state, payload)) = current else {
            return Err(GoopError::Queue(format!(
                "publication {operation} lost its attempt compare-and-swap"
            )));
        };
        let payload: serde_json::Value = serde_json::from_str(&payload).map_err(queue_error)?;
        if kind != "convert" || state != "running" || payload != self.payload {
            return Err(GoopError::Queue(format!(
                "publication {operation} no longer matches the running convert attempt"
            )));
        }
        let updated = tx
            .execute(
                "UPDATE publication_journal SET record = ?3
                 WHERE job_id = ?1 AND record = ?2",
                params![self.job_id.0.to_string(), raw, serialized],
            )
            .map_err(queue_error)?;
        if updated != 1 {
            return Err(GoopError::Queue(format!(
                "publication {operation} was rejected as stale"
            )));
        }
        tx.commit().map_err(queue_error)
    }
}

fn validate_result_destination(destination: &Path, result: &JobResult) -> Result<(), GoopError> {
    let expected = destination
        .to_str()
        .ok_or_else(|| GoopError::Queue("publication destination is not valid UTF-8".into()))?;
    if result.output_path.as_deref() != Some(expected) {
        return Err(GoopError::Queue(
            "publication result does not name the exact destination".into(),
        ));
    }
    Ok(())
}

fn parse_record(raw: &str) -> Result<PublicationRecord, GoopError> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(queue_error)?;
    let version = value.get("version").and_then(serde_json::Value::as_u64);
    if version != Some(JOURNAL_VERSION as u64) {
        return Err(GoopError::Queue(format!(
            "unsupported publication journal version: {}",
            version
                .map(|value| value.to_string())
                .unwrap_or_else(|| "missing".into())
        )));
    }
    serde_json::from_value(value).map_err(queue_error)
}

fn serialize_record(record: &PublicationRecord) -> Result<String, GoopError> {
    serde_json::to_string(record).map_err(queue_error)
}

fn uncertain_state(detail: String) -> JobState {
    JobState::Error {
        message: UNCERTAIN_MESSAGE.into(),
        detail: Some(detail),
    }
}

fn state_to_db(state: &JobState) -> String {
    match state {
        JobState::Queued => "queued".into(),
        JobState::Running => "running".into(),
        JobState::Paused => "paused".into(),
        JobState::Done => "done".into(),
        JobState::Cancelled => "cancelled".into(),
        JobState::Error { message, .. } => format!("error:{message}"),
    }
}

fn parse_job_id(id: &str) -> Result<JobId, GoopError> {
    Uuid::parse_str(id)
        .map(JobId)
        .map_err(|error| GoopError::Queue(format!("invalid publication job id: {error}")))
}

fn queue_error(error: impl std::fmt::Display) -> GoopError {
    GoopError::Queue(error.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    use super::{parse_record, serialize_record};
    use crate::store::QueueStore;
    use goop_core::{Job, JobKind, JobResult, JobState};
    use rusqlite::params;
    use std::fs;
    use tempfile::tempdir;

    fn video_attempt() -> serde_json::Value {
        serde_json::json!({
            "kind": "encode",
            "encoder": "libx264",
            "encode_attempt_ordinal": 2,
            "selection_context": {
                "kind": "legacy_global_at_execution",
                "hw_acceleration_enabled": true
            },
            "fallback": {
                "from_encoder": "h264_videotoolbox",
                "reason": "hardware_attempt_subprocess_failed"
            }
        })
    }

    fn result(path: &std::path::Path) -> JobResult {
        serde_json::from_value(serde_json::json!({
            "output_path": path,
            "bytes": 7,
            "duration_ms": 42,
            "result_kind": "file",
            "file_count": 1,
            "source_bytes": 13,
            "target_bytes": 7,
            "reencoded": true,
            "video_attempt": video_attempt(),
            "image_metadata_execution": {
                "requested_policy": "preserve",
                "requested_color_policy": "convert_to_srgb",
                "exif_retained": true,
                "icc_retained": false,
                "destination_srgb_profile_attached": true,
                "orientation_normalized": true,
                "color_handling": "converted_to_srgb",
                "notices": ["profile converted"]
            },
            "image_alpha_execution": {
                "requested_policy": {"kind":"flatten","background":{"red":1,"green":2,"blue":3}},
                "source_had_alpha": true,
                "flattened": true,
                "background": {"red":1,"green":2,"blue":3},
                "compositing": "linear_srgb"
            },
            "compression_execution": {
                "requested_mode": {"kind":"target_size_bytes","value":7},
                "attempts": 3,
                "selected_quality": 81,
                "target_bytes": 7,
                "final_bytes": 7,
                "target_met": true,
                "metadata_policy": "preserve"
            }
        }))
        .unwrap()
    }

    fn hardware_result(path: &std::path::Path) -> JobResult {
        let mut value = serde_json::to_value(result(path)).unwrap();
        value["video_attempt"] = serde_json::json!({
            "kind": "encode",
            "encoder": "h264_videotoolbox",
            "encode_attempt_ordinal": 1,
            "selection_context": {"kind": "explicit_hardware_required"}
        });
        value["video_execution"] = serde_json::json!({
            "requested": {
                "kind": "hardware_encode",
                "codec": "h264",
                "hardware_policy": {"kind": "required"},
                "rate_control": {"kind": "average_bitrate", "kbps": 5000}
            },
            "encoder": "h264_videotoolbox",
            "video_codec": "h264",
            "video_stream_index": 0,
            "audio_stream_index": 1,
            "audio_codec": "aac",
            "audio_copied": true,
            "width": 1920,
            "height": 1080,
            "notices": []
        });
        serde_json::from_value(value).unwrap()
    }

    fn running_convert(store: &QueueStore) -> Job {
        let payload = serde_json::json!({
            "input_path": "input.png",
            "output_path": "output.jpg",
            "target": "jpeg"
        });
        let mut job = Job::new(JobKind::Convert, payload);
        job.state = JobState::Running;
        store.insert(&job).unwrap();
        job
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn sqlite_faults_preserve_publication_and_terminal_transaction_boundaries() {
        for phase in ["intent", "published", "done"] {
            let dir = tempdir().unwrap();
            let db = dir.path().join("queue.db");
            let destination = dir.path().join("out.jpg");
            let store = QueueStore::open(&db).unwrap();
            let job = running_convert(&store);
            let expected = result(&destination);
            let observer = store.begin_publication(job.id, &job.payload).unwrap();
            let trigger = if phase == "done" {
                "CREATE TRIGGER owned_fault BEFORE UPDATE ON jobs WHEN NEW.state = 'done' BEGIN SELECT RAISE(ABORT, 'owned terminal fault'); END;".to_owned()
            } else {
                format!("CREATE TRIGGER owned_fault BEFORE UPDATE ON publication_journal WHEN json_extract(NEW.record, '$.phase.kind') = '{phase}' BEGIN SELECT RAISE(ABORT, 'owned journal fault'); END;")
            };
            store.conn.lock().execute_batch(&trigger).unwrap();
            let staged = goop_core::output::StagedOutput::new(&destination).unwrap();
            fs::write(staged.path(), b"payload").unwrap();
            let publication = staged.publish_observed(
                &goop_core::output::OutputDestination::explicit(destination.clone()),
                None,
                false,
                &tokio_util::sync::CancellationToken::new(),
                observer.as_ref(),
                &expected,
            );
            assert_eq!(publication.is_ok(), phase == "done");
            assert_eq!(destination.exists(), phase != "intent");
            if phase == "done" {
                assert!(store
                    .finalize_worker(job.id, &job.payload, &JobState::Done, Some(&expected), 123)
                    .is_err());
                assert!(store.has_publication_journal(job.id).unwrap());
                assert_eq!(
                    store.get_by_id(job.id).unwrap().unwrap().state,
                    JobState::Running
                );
            } else {
                let finalized = store
                    .finalize_worker(
                        job.id,
                        &job.payload,
                        &JobState::Error {
                            message: "owned fault".into(),
                            detail: None,
                        },
                        None,
                        123,
                    )
                    .unwrap();
                assert!(matches!(finalized.state, JobState::Error { .. }));
                assert_eq!(
                    store.has_publication_journal(job.id).unwrap(),
                    phase == "published"
                );
            }
            store
                .conn
                .lock()
                .execute_batch("DROP TRIGGER owned_fault;")
                .unwrap();
            drop(observer);
            drop(store);
            for _ in 0..2 {
                let reopened = QueueStore::open(&db).unwrap();
                reopened.reconcile_publications().unwrap();
                let row = reopened.get_by_id(job.id).unwrap().unwrap();
                if phase == "done" {
                    assert_eq!(row.state, JobState::Done);
                    assert_eq!(row.result, Some(expected.clone()));
                } else {
                    assert!(matches!(row.state, JobState::Error { .. }));
                    assert!(row.result.is_none());
                }
                if phase == "published" {
                    assert!(reopened.retry_errored(job.id).is_err());
                    assert_eq!(fs::read(&destination).unwrap(), b"payload");
                }
            }
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn recovery_never_deletes_a_replaced_workspace_without_directory_identity() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("queue.db");
        let workspace = dir.path().join(".goop-output-owned-test");
        fs::create_dir(&workspace).unwrap();
        let staged = workspace.join("out.jpg");
        let destination = dir.path().join("out.jpg");
        fs::write(&staged, b"payload").unwrap();
        let store = QueueStore::open(&db).unwrap();
        let job = running_convert(&store);
        let receipt = result(&destination);
        let observer = store.begin_publication(job.id, &job.payload).unwrap();
        observer
            .before_publish(&staged, &destination, &receipt)
            .unwrap();
        fs::rename(&staged, &destination).unwrap();
        observer.published(&destination, &receipt).unwrap();
        fs::remove_dir(&workspace).unwrap();
        fs::create_dir(&workspace).unwrap();
        store.reconcile_publications().unwrap();
        assert!(
            workspace.is_dir(),
            "replacement directory was removed based only on its name"
        );
        assert_eq!(
            store.get_by_id(job.id).unwrap().unwrap().state,
            JobState::Done
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn terminal_failure_records_honest_error_without_consuming_receipt() {
        let dir = tempdir().unwrap();
        let store = QueueStore::open(&dir.path().join("queue.db")).unwrap();
        let job = running_convert(&store);
        let staged = dir.path().join("staged.jpg");
        let destination = dir.path().join("output.jpg");
        fs::write(&staged, b"payload").unwrap();
        let expected = result(&destination);
        let observer = store.begin_publication(job.id, &job.payload).unwrap();
        observer
            .before_publish(&staged, &destination, &expected)
            .unwrap();
        fs::rename(&staged, &destination).unwrap();
        observer.published(&destination, &expected).unwrap();
        store.conn.lock().execute_batch("CREATE TRIGGER owned_fault BEFORE UPDATE ON jobs WHEN NEW.state = 'done' BEGIN SELECT RAISE(ABORT, 'owned terminal fault'); END;").unwrap();
        assert!(store
            .finalize_worker(job.id, &job.payload, &JobState::Done, Some(&expected), 123)
            .is_err());
        let failure = JobState::Error { message: "Processing finished, but the job status could not be saved. Output and recovery files were retained.".into(), detail: Some("owned terminal fault".into()) };
        store
            .retain_finalization_failure(job.id, &job.payload, &failure, 124)
            .unwrap();
        assert_eq!(store.get_by_id(job.id).unwrap().unwrap().state, failure);
        assert!(store.has_publication_journal(job.id).unwrap());
        assert!(store.retry_errored(job.id).is_err());
        store
            .conn
            .lock()
            .execute_batch("DROP TRIGGER owned_fault;")
            .unwrap();
        store.reconcile_publications().unwrap();
        let recovered = store.get_by_id(job.id).unwrap().unwrap();
        assert_eq!(recovered.state, JobState::Done);
        let recovered_result = recovered.result.unwrap();
        assert_eq!(recovered_result, expected);
        assert_eq!(
            serde_json::to_value(recovered_result).unwrap()["video_attempt"],
            video_attempt()
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn published_receipt_recovers_done_after_two_reopens_with_full_result() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("queue.db");
        let staged = dir.path().join("staged.jpg");
        let destination = dir.path().join("output.jpg");
        fs::write(&staged, b"payload").unwrap();

        let store = QueueStore::open(&db).unwrap();
        let job = running_convert(&store);
        let expected = result(&destination);
        let observer = store.begin_publication(job.id, &job.payload).unwrap();
        observer
            .before_publish(&staged, &destination, &expected)
            .unwrap();
        fs::rename(&staged, &destination).unwrap();
        observer.published(&destination, &expected).unwrap();
        drop(observer);
        drop(store);

        let store = QueueStore::open(&db).unwrap();
        let recovered = store.reconcile_publications().unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].state, JobState::Done);
        assert_eq!(recovered[0].result.as_ref(), Some(&expected));
        assert_eq!(
            serde_json::to_value(recovered[0].result.as_ref().unwrap()).unwrap()["video_attempt"],
            video_attempt()
        );
        assert_eq!(
            store.get_by_id(job.id).unwrap().unwrap().result,
            Some(expected)
        );
        drop(store);

        let store = QueueStore::open(&db).unwrap();
        assert!(store.reconcile_publications().unwrap().is_empty());
        assert_eq!(
            store.get_by_id(job.id).unwrap().unwrap().state,
            JobState::Done
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn hardware_required_result_recovers_with_full_frozen_equality() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("queue.db");
        let staged = dir.path().join("staged.mp4");
        let destination = dir.path().join("output.mp4");
        fs::write(&staged, b"payload").unwrap();
        let store = QueueStore::open(&db).unwrap();
        let job = running_convert(&store);
        let expected = hardware_result(&destination);
        let observer = store.begin_publication(job.id, &job.payload).unwrap();
        observer
            .before_publish(&staged, &destination, &expected)
            .unwrap();
        fs::rename(&staged, &destination).unwrap();
        observer.published(&destination, &expected).unwrap();
        drop(observer);
        drop(store);

        let reopened = QueueStore::open(&db).unwrap();
        let recovered = reopened.reconcile_publications().unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].result.as_ref(), Some(&expected));
        assert_eq!(
            reopened.get_by_id(job.id).unwrap().unwrap().result,
            Some(expected)
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn intent_only_is_uncertain_and_blocks_retry_clear_and_deletion() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("queue.db");
        let staged = dir.path().join("staged.jpg");
        let destination = dir.path().join("output.jpg");
        fs::write(&staged, b"payload").unwrap();
        let store = QueueStore::open(&db).unwrap();
        let job = running_convert(&store);
        let expected = result(&destination);
        let observer = store.begin_publication(job.id, &job.payload).unwrap();
        observer
            .before_publish(&staged, &destination, &expected)
            .unwrap();
        let intent: serde_json::Value =
            serde_json::from_str(&store.load_journal(job.id).unwrap().unwrap()).unwrap();
        assert_eq!(intent["phase"]["result"]["video_attempt"], video_attempt());
        fs::rename(&staged, &destination).unwrap();
        drop(observer);
        drop(store);

        let store = QueueStore::open(&db).unwrap();
        let recovered = store.reconcile_publications().unwrap();
        assert_eq!(recovered.len(), 1);
        assert!(matches!(
            recovered[0].state,
            JobState::Error { ref message, .. } if message.contains("may already exist")
        ));
        assert!(store.retry_errored(job.id).is_err());
        assert_eq!(store.clear_completed().unwrap(), 0);
        assert_eq!(store.forget(job.id).unwrap(), 0);
        assert_eq!(store.forget_many(&[job.id]).unwrap(), 0);
        assert!(destination.exists());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn same_bytes_at_destination_are_never_adopted_without_a_receipt() {
        let dir = tempdir().unwrap();
        let staged = dir.path().join("staged.jpg");
        let destination = dir.path().join("output.jpg");
        fs::write(&staged, b"payload").unwrap();
        let store = QueueStore::open(&dir.path().join("queue.db")).unwrap();
        let job = running_convert(&store);
        let expected = result(&destination);
        let observer = store.begin_publication(job.id, &job.payload).unwrap();
        observer
            .before_publish(&staged, &destination, &expected)
            .unwrap();
        fs::write(&destination, b"payload").unwrap();

        let recovered = store.reconcile_publications().unwrap();
        assert!(matches!(recovered[0].state, JobState::Error { .. }));
        assert_ne!(
            store.get_by_id(job.id).unwrap().unwrap().state,
            JobState::Done
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn replacement_after_receipt_refuses_recovery() {
        let dir = tempdir().unwrap();
        let staged = dir.path().join("staged.jpg");
        let destination = dir.path().join("output.jpg");
        fs::write(&staged, b"payload").unwrap();
        let store = QueueStore::open(&dir.path().join("queue.db")).unwrap();
        let job = running_convert(&store);
        let expected = result(&destination);
        let observer = store.begin_publication(job.id, &job.payload).unwrap();
        observer
            .before_publish(&staged, &destination, &expected)
            .unwrap();
        fs::rename(&staged, &destination).unwrap();
        observer.published(&destination, &expected).unwrap();
        fs::remove_file(&destination).unwrap();
        fs::write(&destination, b"payload").unwrap();

        let recovered = store.reconcile_publications().unwrap();
        assert!(matches!(recovered[0].state, JobState::Error { .. }));
        assert!(store.retry_errored(job.id).is_err());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn verified_receipt_is_authoritative_over_late_cancel_and_retains_unproven_workspace() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join(".goop-output-test");
        fs::create_dir(&workspace).unwrap();
        let staged = workspace.join("staged.jpg");
        let destination = dir.path().join("output.jpg");
        fs::write(&staged, b"payload").unwrap();
        let store = QueueStore::open(&dir.path().join("queue.db")).unwrap();
        let job = running_convert(&store);
        let expected = result(&destination);
        let observer = store.begin_publication(job.id, &job.payload).unwrap();
        observer
            .before_publish(&staged, &destination, &expected)
            .unwrap();
        fs::rename(&staged, &destination).unwrap();
        observer.published(&destination, &expected).unwrap();

        let finalized = store
            .finalize_worker(job.id, &job.payload, &JobState::Cancelled, None, 123)
            .unwrap();
        assert_eq!(finalized.state, JobState::Done);
        assert_eq!(finalized.result, Some(expected));
        assert!(workspace.exists());
        assert!(!store.has_publication_journal(job.id).unwrap());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn successful_worker_result_must_match_published_receipt_exactly() {
        let dir = tempdir().unwrap();
        let staged = dir.path().join("staged.jpg");
        let destination = dir.path().join("output.jpg");
        fs::write(&staged, b"payload").unwrap();
        let store = QueueStore::open(&dir.path().join("queue.db")).unwrap();
        let job = running_convert(&store);
        let expected = result(&destination);
        let observer = store.begin_publication(job.id, &job.payload).unwrap();
        observer
            .before_publish(&staged, &destination, &expected)
            .unwrap();
        fs::rename(&staged, &destination).unwrap();
        observer.published(&destination, &expected).unwrap();
        let mut mismatched = expected.clone();
        mismatched.duration_ms += 1;

        let finalized = store
            .finalize_worker(
                job.id,
                &job.payload,
                &JobState::Done,
                Some(&mismatched),
                123,
            )
            .unwrap();
        assert!(matches!(finalized.state, JobState::Error { .. }));
        assert!(store.has_publication_journal(job.id).unwrap());
        assert!(store.retry_errored(job.id).is_err());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn worker_video_attempt_must_match_published_receipt_exactly() {
        let dir = tempdir().unwrap();
        let staged = dir.path().join("staged.mp4");
        let destination = dir.path().join("output.mp4");
        fs::write(&staged, b"payload").unwrap();
        let store = QueueStore::open(&dir.path().join("queue.db")).unwrap();
        let job = running_convert(&store);
        let expected = result(&destination);
        let observer = store.begin_publication(job.id, &job.payload).unwrap();
        observer
            .before_publish(&staged, &destination, &expected)
            .unwrap();
        fs::rename(&staged, &destination).unwrap();
        observer.published(&destination, &expected).unwrap();

        let mut mismatched_json = serde_json::to_value(&expected).unwrap();
        mismatched_json["video_attempt"] = serde_json::json!({"kind": "copy"});
        let mismatched: JobResult = serde_json::from_value(mismatched_json).unwrap();
        let finalized = store
            .finalize_worker(
                job.id,
                &job.payload,
                &JobState::Done,
                Some(&mismatched),
                123,
            )
            .unwrap();

        assert!(matches!(finalized.state, JobState::Error { .. }));
        assert!(finalized.result.is_none());
        assert!(store.has_publication_journal(job.id).unwrap());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn stale_observer_and_payload_change_are_rejected() {
        let dir = tempdir().unwrap();
        let staged = dir.path().join("staged.jpg");
        let destination = dir.path().join("output.jpg");
        fs::write(&staged, b"payload").unwrap();
        let store = QueueStore::open(&dir.path().join("queue.db")).unwrap();
        let job = running_convert(&store);
        let observer = store.begin_publication(job.id, &job.payload).unwrap();
        assert!(store
            .update_payload(job.id, &serde_json::json!({"changed": true}))
            .is_err());
        let raw = store.load_journal(job.id).unwrap().unwrap();
        let mut superseding = parse_record(&raw).unwrap();
        superseding.attempt_id = uuid::Uuid::now_v7();
        store
            .conn
            .lock()
            .execute(
                "UPDATE publication_journal SET record = ?2 WHERE job_id = ?1",
                params![
                    job.id.0.to_string(),
                    serialize_record(&superseding).unwrap()
                ],
            )
            .unwrap();
        assert!(observer
            .before_publish(&staged, &destination, &result(&destination))
            .is_err());
        assert!(store.begin_publication(job.id, &job.payload).is_err());
    }

    #[test]
    fn malformed_and_future_records_are_preserved_and_block_retry() {
        for raw in ["not-json", r#"{"version":999}"#] {
            let dir = tempdir().unwrap();
            let store = QueueStore::open(&dir.path().join("queue.db")).unwrap();
            let job = running_convert(&store);
            store
                .conn
                .lock()
                .execute(
                    "INSERT INTO publication_journal (job_id, record) VALUES (?1, ?2)",
                    params![job.id.0.to_string(), raw],
                )
                .unwrap();

            let recovered = store.reconcile_publications().unwrap();
            assert!(matches!(recovered[0].state, JobState::Error { .. }));
            assert!(store.retry_errored(job.id).is_err());
            let kept: String = store
                .conn
                .lock()
                .query_row(
                    "SELECT record FROM publication_journal WHERE job_id = ?1",
                    params![job.id.0.to_string()],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(kept, raw);
        }
    }

    #[test]
    fn preparing_attempt_can_finish_normally_and_is_consumed_atomically() {
        let dir = tempdir().unwrap();
        let store = QueueStore::open(&dir.path().join("queue.db")).unwrap();
        let job = running_convert(&store);
        let _observer = store.begin_publication(job.id, &job.payload).unwrap();
        let proposed = JobState::Error {
            message: "encoder failed".into(),
            detail: Some("stderr".into()),
        };
        let finalization = store
            .finalize_worker(job.id, &job.payload, &proposed, None, 123)
            .unwrap();
        assert_eq!(finalization.state, proposed);
        assert_eq!(store.retry_errored(job.id).unwrap(), 1);
    }

    #[test]
    fn preparing_attempt_allows_live_pause_and_resume_without_consuming_journal() {
        let dir = tempdir().unwrap();
        let store = QueueStore::open(&dir.path().join("queue.db")).unwrap();
        let job = running_convert(&store);
        let _observer = store.begin_publication(job.id, &job.payload).unwrap();

        store
            .update_live_process_state(job.id, &JobState::Paused, 10)
            .unwrap();
        assert_eq!(
            store.get_by_id(job.id).unwrap().unwrap().state,
            JobState::Paused
        );
        assert!(store.has_publication_journal(job.id).unwrap());

        store
            .update_live_process_state(job.id, &JobState::Running, 20)
            .unwrap();
        assert_eq!(
            store.get_by_id(job.id).unwrap().unwrap().state,
            JobState::Running
        );
        assert!(store.has_publication_journal(job.id).unwrap());
    }

    #[test]
    fn paused_preparing_attempt_is_interrupted_on_restart_and_never_requeued() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("queue.db");
        let store = QueueStore::open(&db).unwrap();
        let job = running_convert(&store);
        let _observer = store.begin_publication(job.id, &job.payload).unwrap();
        store
            .update_live_process_state(job.id, &JobState::Paused, 10)
            .unwrap();
        drop(store);

        let store = QueueStore::open(&db).unwrap();
        let recovered = store.reconcile_publications().unwrap();
        assert_eq!(recovered.len(), 1);
        assert!(matches!(recovered[0].state, JobState::Error { .. }));
        assert!(!store.has_publication_journal(job.id).unwrap());
        assert_eq!(store.recover_paused().unwrap(), 0);
        assert!(matches!(
            store.get_by_id(job.id).unwrap().unwrap().state,
            JobState::Error { .. }
        ));
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn publication_intent_refuses_live_pause() {
        let dir = tempdir().unwrap();
        let staged = dir.path().join("staged.jpg");
        let destination = dir.path().join("output.jpg");
        fs::write(&staged, b"payload").unwrap();
        let store = QueueStore::open(&dir.path().join("queue.db")).unwrap();
        let job = running_convert(&store);
        let observer = store.begin_publication(job.id, &job.payload).unwrap();
        observer
            .before_publish(&staged, &destination, &result(&destination))
            .unwrap();

        assert!(store
            .update_live_process_state(job.id, &JobState::Paused, 10)
            .is_err());
        assert_eq!(
            store.get_by_id(job.id).unwrap().unwrap().state,
            JobState::Running
        );
        assert!(store.has_publication_journal(job.id).unwrap());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    #[test]
    fn unsupported_platform_refuses_publication_without_losing_preparing_record() {
        let dir = tempdir().unwrap();
        let staged = dir.path().join("staged.jpg");
        let destination = dir.path().join("output.jpg");
        fs::write(&staged, b"payload").unwrap();
        let store = QueueStore::open(&dir.path().join("queue.db")).unwrap();
        let job = running_convert(&store);
        let observer = store.begin_publication(job.id, &job.payload).unwrap();
        assert!(observer
            .before_publish(&staged, &destination, &result(&destination))
            .is_err());
        let finalization = store
            .finalize_worker(
                job.id,
                &job.payload,
                &JobState::Error {
                    message: "unsupported".into(),
                    detail: None,
                },
                None,
                123,
            )
            .unwrap();
        assert!(matches!(finalization.state, JobState::Error { .. }));
        assert!(!store.has_publication_journal(job.id).unwrap());
    }
}
