//! Automatic retry with exponential backoff for transient download
//! failures.
//!
//! [`with_retry`] wraps one full dispatch attempt (classify → primary →
//! fallback → direct). Only errors classified as transient are retried:
//! the direct downloader's typed [`GoopError::Network`] failures, and
//! subprocess failures whose stderr matches
//! [`goop_core::is_transient_network_stderr`]. `Cancelled`/`Paused` are
//! control flow and propagate immediately; every other error is
//! permanent and surfaces on the first attempt. Each new attempt finds
//! the previous attempt's partial files on disk, so a retry is a resume,
//! not a restart.
//!
//! The retry counter is deliberately in-memory only: it reports through
//! `ProgressEvent.stage` strings and dies with the worker future. A
//! paused-then-resumed job starts a fresh attempt budget — the resume was
//! a human decision. The persisted `Job.attempts` column counts manual
//! Retry-button clicks and is owned by the queue layer, never written
//! from here.

use goop_core::{
    is_transient_network_stderr, EventSink, GoopError, JobId, JobSignals, ProgressEvent,
};
use reqwest::StatusCode;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

pub(crate) struct RetryPolicy {
    /// Extra attempts after the first — 4 retries means 5 total attempts.
    pub max_retries: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
}

pub(crate) const DEFAULT_RETRY_POLICY: RetryPolicy = RetryPolicy {
    max_retries: 4,
    base_delay: Duration::from_secs(2),
    max_delay: Duration::from_secs(30),
};

impl RetryPolicy {
    /// Doubling backoff, capped: with the defaults, the delay before
    /// attempt N+1 is 2s, 4s, 8s, 16s for N = 1..=4. Attempts are
    /// 1-based; the saturating subtraction and clamped shift keep a
    /// misuse (attempt 0, huge attempt counts) from underflowing or
    /// overflowing.
    fn delay_for(&self, attempt: u32) -> Duration {
        let factor = 1u32 << attempt.saturating_sub(1).min(16);
        self.base_delay.saturating_mul(factor).min(self.max_delay)
    }
}

/// HTTP statuses worth an automatic retry on the direct-download path.
/// 429 rides here because our capped backoff is a polite response for an
/// in-process client; the subprocess paths treat 429 as permanent instead
/// — yt-dlp/gallery-dl already exhausted their own internal retries by
/// the time it reaches us, and hammering a rate limiter extends the ban.
pub(crate) fn transient_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 429 | 500 | 502 | 503 | 504)
}

fn is_transient(err: &GoopError) -> bool {
    match err {
        GoopError::Network(_) => true,
        GoopError::SubprocessFailed { stderr, .. } => is_transient_network_stderr(stderr),
        _ => false,
    }
}

/// Run `op`, retrying transient failures with backoff until it succeeds,
/// a permanent error surfaces, the attempt budget runs out (the LAST
/// error is returned), or a control signal fires. The backoff sleep
/// itself selects on both signals so a pause or cancel issued during a
/// wait takes effect immediately instead of burning another attempt.
pub(crate) async fn with_retry<T, F, Fut>(
    policy: &RetryPolicy,
    signals: &JobSignals,
    sink: &Arc<dyn EventSink>,
    job_id: JobId,
    mut op: F,
) -> Result<T, GoopError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, GoopError>>,
{
    let total = policy.max_retries + 1;
    let mut attempt = 1u32;
    loop {
        match op().await {
            Ok(v) => return Ok(v),
            // Control flow: the user stopped the job. Never retried.
            Err(e @ (GoopError::Cancelled | GoopError::Paused)) => return Err(e),
            Err(e) if attempt <= policy.max_retries && is_transient(&e) => {
                // A rate limiter asked us to back off — give it the full
                // cap instead of an early exponential step. The message is
                // our own construction (direct.rs status_error), so the
                // sniff is stable.
                let delay = match &e {
                    GoopError::Network(m) if m.contains("HTTP 429") => policy.max_delay,
                    _ => policy.delay_for(attempt),
                };
                // The stage prefix "retrying" is a rendering contract with
                // QueueRow.tsx; percent 0 tells the store to hold the last
                // rendered percent, and eta_secs carries the wait.
                sink.emit_progress(ProgressEvent {
                    job_id,
                    percent: 0.0,
                    eta_secs: Some(delay.as_secs()),
                    speed_hr: None,
                    stage: format!("retrying (attempt {}/{total})", attempt + 1),
                    encoder: None,
                });
                tokio::select! {
                    biased;
                    _ = signals.cancel.cancelled() => return Err(GoopError::Cancelled),
                    _ = signals.pause.cancelled() => return Err(GoopError::Paused),
                    _ = tokio::time::sleep(delay) => {}
                }
                attempt += 1;
            }
            // Permanent, or the budget is spent: surface the LAST error.
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use goop_core::events::RecordingSink;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn sink() -> Arc<RecordingSink> {
        Arc::new(RecordingSink::new())
    }

    fn dyn_sink(s: &Arc<RecordingSink>) -> Arc<dyn EventSink> {
        s.clone()
    }

    #[test]
    fn delay_schedule_doubles_and_caps() {
        let p = &DEFAULT_RETRY_POLICY;
        let secs: Vec<u64> = (1..=6).map(|a| p.delay_for(a).as_secs()).collect();
        assert_eq!(secs, vec![2, 4, 8, 16, 30, 30]);
    }

    #[test]
    fn transient_status_table() {
        for s in [408u16, 429, 500, 502, 503, 504] {
            assert!(transient_status(StatusCode::from_u16(s).unwrap()), "{s}");
        }
        for s in [400u16, 401, 403, 404, 410, 501, 505] {
            assert!(!transient_status(StatusCode::from_u16(s).unwrap()), "{s}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn retries_transient_error_then_succeeds() {
        let rec = sink();
        let signals = JobSignals::new();
        let calls = AtomicU32::new(0);
        let res = with_retry(
            &DEFAULT_RETRY_POLICY,
            &signals,
            &dyn_sink(&rec),
            JobId::new(),
            || {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n == 0 {
                        Err(GoopError::Network("connection reset".into()))
                    } else {
                        Ok(42)
                    }
                }
            },
        )
        .await;
        assert_eq!(res.unwrap(), 42);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let progress = rec.progress.lock().clone();
        assert_eq!(progress.len(), 1);
        assert_eq!(progress[0].stage, "retrying (attempt 2/5)");
        assert_eq!(progress[0].eta_secs, Some(2));
        assert_eq!(progress[0].percent, 0.0);
    }

    #[tokio::test(start_paused = true)]
    async fn does_not_retry_permanent_error() {
        let rec = sink();
        let signals = JobSignals::new();
        let calls = AtomicU32::new(0);
        let res: Result<(), _> = with_retry(
            &DEFAULT_RETRY_POLICY,
            &signals,
            &dyn_sink(&rec),
            JobId::new(),
            || {
                calls.fetch_add(1, Ordering::SeqCst);
                async {
                    Err(GoopError::SubprocessFailed {
                        binary: "gallery-dl".into(),
                        stderr: "HTTPError: 404 Not Found".into(),
                    })
                }
            },
        )
        .await;
        assert!(matches!(
            res.unwrap_err(),
            GoopError::SubprocessFailed { .. }
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(rec.progress.lock().is_empty(), "no retry events");
    }

    #[tokio::test(start_paused = true)]
    async fn exhaustion_runs_five_attempts_with_full_backoff_and_surfaces_last_error() {
        let rec = sink();
        let signals = JobSignals::new();
        let calls = AtomicU32::new(0);
        let began = tokio::time::Instant::now();
        let res: Result<(), _> = with_retry(
            &DEFAULT_RETRY_POLICY,
            &signals,
            &dyn_sink(&rec),
            JobId::new(),
            || {
                let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
                async move { Err(GoopError::Network(format!("boom {n}"))) }
            },
        )
        .await;
        assert!(matches!(res.unwrap_err(), GoopError::Network(m) if m == "boom 5"));
        assert_eq!(calls.load(Ordering::SeqCst), 5);
        // 2 + 4 + 8 + 16 seconds of (virtual) backoff.
        assert_eq!(began.elapsed().as_secs(), 30);
        let stages: Vec<String> = rec
            .progress
            .lock()
            .iter()
            .map(|p| p.stage.clone())
            .collect();
        assert_eq!(
            stages,
            vec![
                "retrying (attempt 2/5)",
                "retrying (attempt 3/5)",
                "retrying (attempt 4/5)",
                "retrying (attempt 5/5)",
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn rate_limited_429_waits_the_full_cap() {
        let rec = sink();
        let signals = JobSignals::new();
        let calls = AtomicU32::new(0);
        let began = tokio::time::Instant::now();
        let res = with_retry(
            &DEFAULT_RETRY_POLICY,
            &signals,
            &dyn_sink(&rec),
            JobId::new(),
            || {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n == 0 {
                        Err(GoopError::Network(
                            "direct download: HTTP 429 Too Many Requests for x".into(),
                        ))
                    } else {
                        Ok(())
                    }
                }
            },
        )
        .await;
        assert!(res.is_ok());
        assert_eq!(began.elapsed().as_secs(), 30, "cap, not the 2s first step");
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_during_backoff_returns_cancelled_without_a_new_attempt() {
        let rec = sink();
        let signals = JobSignals::new();
        let fire = signals.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            fire.cancel.cancel();
        });
        let calls = AtomicU32::new(0);
        let res: Result<(), _> = with_retry(
            &DEFAULT_RETRY_POLICY,
            &signals,
            &dyn_sink(&rec),
            JobId::new(),
            || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err(GoopError::Network("drop".into())) }
            },
        )
        .await;
        assert!(matches!(res.unwrap_err(), GoopError::Cancelled));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn pause_during_backoff_returns_paused_without_a_new_attempt() {
        let rec = sink();
        let signals = JobSignals::new();
        let fire = signals.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            fire.pause.cancel();
        });
        let calls = AtomicU32::new(0);
        let res: Result<(), _> = with_retry(
            &DEFAULT_RETRY_POLICY,
            &signals,
            &dyn_sink(&rec),
            JobId::new(),
            || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err(GoopError::Network("drop".into())) }
            },
        )
        .await;
        assert!(matches!(res.unwrap_err(), GoopError::Paused));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_and_paused_results_are_never_retried() {
        for make in [(|| GoopError::Cancelled) as fn() -> GoopError, || {
            GoopError::Paused
        }] {
            let rec = sink();
            let signals = JobSignals::new();
            let calls = AtomicU32::new(0);
            let res: Result<(), _> = with_retry(
                &DEFAULT_RETRY_POLICY,
                &signals,
                &dyn_sink(&rec),
                JobId::new(),
                || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    async move { Err(make()) }
                },
            )
            .await;
            assert!(res.is_err());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert!(rec.progress.lock().is_empty());
        }
    }
}
