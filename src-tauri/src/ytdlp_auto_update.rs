//! Daily yt-dlp freshness check.
//!
//! Extractors rot. Sites change their players, yt-dlp ships a fix within days,
//! and the copy bundled at build time never moves — so the binary that shipped
//! with a release is already behind by the time anyone installs it, and gets
//! further behind every week. Before this, the only cure was noticing the
//! Settings button existed.
//!
//! The check runs shortly after launch, at most once a day, and does nothing
//! at all when the user has switched it off. Every failure is a log line: a
//! machine that boots offline must not see an error about an update it never
//! asked for.

use crate::commands::sidecar::yt_dlp_updated_event;
use goop_config::Settings;
use goop_core::{EventSink, GoopError};
use goop_extractor::BinaryUpdated;
use goop_sidecar::updater::UpdateStatus;
use goop_sidecar::BinaryResolver;
use parking_lot::RwLock;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

/// One check a day. yt-dlp releases every few days at most, and the cost of
/// being a few hours stale is nil next to a request per launch.
const CHECK_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

/// How long a failure-triggered check stands for.
///
/// Shorter than the daily throttle because a job that just failed is real
/// evidence and a calendar is not. Long enough that a rotted site — which
/// fails every job pointed at it, each failure looking exactly as stale as
/// the first — costs one request rather than one per item in the batch.
///
/// Kept in memory only. The window exists to collapse a burst, and a burst
/// does not survive a relaunch.
const STALE_CHECK_INTERVAL_MS: i64 = 30 * 60 * 1000;

/// Wall-clock milliseconds. Taken as a parameter everywhere below so the
/// throttle is testable without waiting a day.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The update call, injected so tests can drive the coordinator without a
/// network or a real binary. Mirrors `goop_queue::WorkerFn`.
#[allow(clippy::type_complexity)]
pub type UpdateFn = Arc<
    dyn Fn(
            Arc<BinaryResolver>,
        ) -> Pin<Box<dyn Future<Output = Result<UpdateStatus, GoopError>> + Send>>
        + Send
        + Sync,
>;

/// Whether an automatic check is due.
///
/// `last_ms` of `None` means one has never run, which counts as due — that is
/// the first launch after installing, when the bundled binary is at its oldest
/// relative to upstream.
///
/// A `last_ms` in the future (a clock that moved backwards, or a settings file
/// copied from another machine) also counts as due, rather than locking checks
/// out until real time catches up.
pub fn should_check(last_ms: Option<i64>, now_ms: i64, enabled: bool) -> bool {
    if !enabled {
        return false;
    }
    match last_ms {
        None => true,
        Some(last) => now_ms.saturating_sub(last) >= CHECK_INTERVAL_MS || last > now_ms,
    }
}

/// Serializes yt-dlp update checks and owns the throttle timestamp.
///
/// The download itself is already serialized process-wide inside
/// `goop_sidecar`. This guard is the layer above: a second caller should be
/// told "already running" and go away, not queue up behind a 120s download and
/// then perform a redundant check of its own.
pub struct YtDlpAutoUpdate {
    resolver: Arc<BinaryResolver>,
    settings: Arc<RwLock<Settings>>,
    settings_path: PathBuf,
    sink: Arc<dyn EventSink>,
    update: UpdateFn,
    in_flight: tokio::sync::Mutex<()>,
    /// When the last failure-triggered check completed. Separate from
    /// `Settings.yt_dlp_last_update_ms`, which is the daily throttle this
    /// path deliberately bypasses.
    last_failure_check_ms: RwLock<Option<i64>>,
}

impl YtDlpAutoUpdate {
    pub fn new(
        resolver: Arc<BinaryResolver>,
        settings: Arc<RwLock<Settings>>,
        settings_path: PathBuf,
        sink: Arc<dyn EventSink>,
        update: UpdateFn,
    ) -> Self {
        Self {
            resolver,
            settings,
            settings_path,
            sink,
            update,
            in_flight: tokio::sync::Mutex::new(()),
            last_failure_check_ms: RwLock::new(None),
        }
    }

    /// The real updater.
    pub fn production(
        resolver: Arc<BinaryResolver>,
        settings: Arc<RwLock<Settings>>,
        settings_path: PathBuf,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self::new(
            resolver,
            settings,
            settings_path,
            sink,
            Arc::new(|r: Arc<BinaryResolver>| {
                Box::pin(async move { goop_sidecar::yt_dlp_update::update(&r).await })
            }),
        )
    }

    /// Run a check now, regardless of the throttle. `None` when another check
    /// is already in flight — the caller should report that rather than start
    /// a second one.
    ///
    /// On a completed run the throttle timestamp is recorded whether or not
    /// the update succeeded: a machine that is offline should back off for a
    /// day like any other, not retry on every launch.
    pub async fn check_now(&self, now_ms: i64) -> Option<Result<UpdateStatus, GoopError>> {
        // `try_lock`, not `lock`: waiting would mean a second check runs the
        // moment the first finishes, re-asking a question that was just
        // answered.
        let _guard = self.in_flight.try_lock().ok()?;

        let outcome = (self.update)(self.resolver.clone()).await;

        // Recorded on failure too. Whatever went wrong — offline, rate
        // limited, DNS — is unlikely to be fixed seconds later, and retrying
        // every launch would make a machine that is permanently offline pay
        // for this on every single start.
        self.record_check_time(now_ms).await;

        if let Ok(status) = &outcome {
            if let Some(event) = yt_dlp_updated_event(status) {
                self.sink.emit_sidecar(event);
            }
        }
        Some(outcome)
    }

    /// Persist the throttle timestamp.
    ///
    /// The write lock is held ACROSS the save, exactly as `settings_set` does.
    /// That is the whole point: `goop_config::save` rewrites the entire file
    /// with no atomic rename and no lockfile, so two savers that don't share
    /// an ordering can interleave. Mutating under the lock and then saving
    /// after releasing it would let a user's toggle — applied and saved by
    /// `settings_set` in the gap — be overwritten by this older snapshot
    /// landing second. Nothing looks wrong until the next launch reads the
    /// stale file back and the setting has silently reverted.
    ///
    /// The whole thing runs on the blocking pool: it takes a non-async lock
    /// and does synchronous disk I/O, neither of which belongs on a runtime
    /// worker shared with every job scheduler.
    async fn record_check_time(&self, now_ms: i64) {
        let settings = self.settings.clone();
        let path = self.settings_path.clone();
        let saved = tokio::task::spawn_blocking(move || {
            let mut w = settings.write();
            w.yt_dlp_last_update_ms = Some(now_ms);
            goop_config::save(&path, &w)
        })
        .await;
        match saved {
            Ok(Ok(())) => {}
            // The in-memory value still holds for this session, so the
            // throttle works until relaunch; only persistence was lost.
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "failed to persist the yt-dlp check timestamp")
            }
            Err(e) => tracing::warn!(error = %e, "settings save task failed"),
        }
    }

    /// Entry point for the dispatcher's stale-failure hook: a job just failed
    /// in a way only a newer yt-dlp can fix
    /// (`goop_core::is_stale_extractor_suspect`).
    ///
    /// `Some` ONLY when different bytes are now on disk, because that is the
    /// only outcome that justifies re-running the job. "Already current", "the
    /// check failed" and "another check is in flight" are all `None`.
    ///
    /// Two throttles apply and one does not. The daily one is deliberately
    /// bypassed — a job failing now is better evidence than a calendar — which
    /// is exactly why the kill switch has to be honoured here by hand:
    /// `check_now` does not consult it, since the Settings button that also
    /// calls it *is* the user asking.
    pub async fn check_after_stale_failure(&self, now_ms: i64) -> Option<BinaryUpdated> {
        if !self.settings.read().yt_dlp_auto_update {
            return None;
        }
        if let Some(last) = *self.last_failure_check_ms.read() {
            // `now_ms >= last` first: a clock that moved backwards must not
            // lock checks out until real time catches up, same as
            // `should_check`.
            if now_ms >= last && now_ms.saturating_sub(last) < STALE_CHECK_INTERVAL_MS {
                return None;
            }
        }
        let outcome = self.check_now(now_ms).await?;
        // Recorded for any COMPLETED check, not only fruitless ones: half a
        // minute after an update there is nothing newer to find either. The
        // `?` above skips this when another check is in flight — that one
        // does its own recording.
        *self.last_failure_check_ms.write() = Some(now_ms);

        let status = outcome.ok()?;
        // `new_version` is set only where a fresh binary was actually
        // installed (see `goop_sidecar::yt_dlp_update`), so this is the
        // "different bytes on disk" test rather than a version comparison.
        let to = status.new_version?;
        Some(BinaryUpdated {
            from: status
                .previous_version
                .unwrap_or_else(|| "unknown".to_string()),
            to,
        })
    }

    /// Throttled entry point for the startup task. Never returns an error:
    /// this runs unprompted, so a failure is a log line, not something the
    /// user has to dismiss.
    pub async fn check_if_due(&self, now_ms: i64) {
        // Copy the two values out and drop the guard before awaiting.
        let (last_ms, enabled) = {
            let s = self.settings.read();
            (s.yt_dlp_last_update_ms, s.yt_dlp_auto_update)
        };
        if !should_check(last_ms, now_ms, enabled) {
            return;
        }
        match self.check_now(now_ms).await {
            Some(Ok(status)) => {
                tracing::info!(message = %status.message, "yt-dlp check complete")
            }
            Some(Err(e)) => tracing::warn!(error = %e, "yt-dlp check failed"),
            None => tracing::debug!("yt-dlp check skipped; one was already running"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use goop_core::{ProgressEvent, QueueEvent, SidecarEvent};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const DAY: i64 = 24 * 60 * 60 * 1000;

    #[derive(Default)]
    struct CountingSink {
        sidecar: parking_lot::Mutex<Vec<SidecarEvent>>,
    }
    impl EventSink for CountingSink {
        fn emit_progress(&self, _: ProgressEvent) {}
        fn emit_queue(&self, _: QueueEvent) {}
        fn emit_sidecar(&self, e: SidecarEvent) {
            self.sidecar.lock().push(e);
        }
    }

    fn status(previous: Option<&str>, new: Option<&str>) -> UpdateStatus {
        UpdateStatus {
            attempted: true,
            previous_version: previous.map(String::from),
            new_version: new.map(String::from),
            message: "test".into(),
        }
    }

    struct Harness {
        coord: YtDlpAutoUpdate,
        calls: Arc<AtomicUsize>,
        settings: Arc<RwLock<Settings>>,
        sink: Arc<CountingSink>,
        _dir: tempfile::TempDir,
    }

    fn harness(update: UpdateFn, calls: Arc<AtomicUsize>) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(RwLock::new(Settings::default()));
        let sink = Arc::new(CountingSink::default());
        let coord = YtDlpAutoUpdate::new(
            Arc::new(BinaryResolver::new(dir.path().to_path_buf())),
            settings.clone(),
            dir.path().join("settings.json"),
            sink.clone(),
            update,
        );
        Harness {
            coord,
            calls,
            settings,
            sink,
            _dir: dir,
        }
    }

    /// Counts calls and returns immediately.
    fn instant_update(st: UpdateStatus) -> (UpdateFn, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let f: UpdateFn = Arc::new(move |_| {
            let c = c.clone();
            let st = st.clone();
            Box::pin(async move {
                c.fetch_add(1, Ordering::SeqCst);
                Ok(st)
            })
        });
        (f, calls)
    }

    // ---- should_check ---------------------------------------------------

    #[test]
    fn should_check_table() {
        let now = 10 * DAY;
        assert!(
            should_check(None, now, true),
            "never checked → due (this is the first launch after install)"
        );
        assert!(
            !should_check(Some(now - DAY + 1), now, true),
            "23h59m → not yet"
        );
        assert!(
            should_check(Some(now - DAY), now, true),
            "exactly 24h → due"
        );
        assert!(should_check(Some(now - 2 * DAY), now, true), "25h+ → due");
        assert!(
            !should_check(None, now, false),
            "disabled beats everything, including never-checked"
        );
        assert!(!should_check(Some(now - 30 * DAY), now, false), "disabled");
    }

    #[test]
    fn a_future_timestamp_does_not_lock_out_checks() {
        // A clock that moved backwards, or a settings.json copied from
        // another machine. Waiting for real time to catch up could mean
        // never checking again.
        let now = 10 * DAY;
        assert!(should_check(Some(now + 5 * DAY), now, true));
    }

    // ---- coordinator ----------------------------------------------------

    #[tokio::test]
    async fn a_successful_check_records_the_timestamp_and_persists_it() {
        let (f, calls) = instant_update(status(Some("2026.06.09"), Some("2026.07.04")));
        let h = harness(f, calls);
        let now = 5 * DAY;

        let out = h.coord.check_now(now).await.expect("not in flight");
        assert!(out.is_ok());
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            h.settings.read().yt_dlp_last_update_ms,
            Some(now),
            "the throttle timestamp must be written"
        );
        let saved = goop_config::load(&h.coord.settings_path).expect("settings file written");
        assert_eq!(saved.yt_dlp_last_update_ms, Some(now), "and persisted");
    }

    #[tokio::test]
    async fn a_real_version_change_announces_itself() {
        let (f, calls) = instant_update(status(Some("2026.06.09"), Some("2026.07.04")));
        let h = harness(f, calls);
        let _ = h.coord.check_now(DAY).await.expect("ran");
        let events = h.sink.sidecar.lock();
        assert_eq!(events.len(), 1, "one YtDlpUpdated for a real change");
        assert!(matches!(events[0], SidecarEvent::YtDlpUpdated { .. }));
    }

    #[tokio::test]
    async fn an_unchanged_binary_announces_nothing() {
        let (f, calls) = instant_update(status(Some("2026.07.04"), Some("2026.07.04")));
        let h = harness(f, calls);
        let _ = h.coord.check_now(DAY).await.expect("ran");
        assert!(
            h.sink.sidecar.lock().is_empty(),
            "an already-current sidecar must not cost a frontend re-spawn"
        );
    }

    /// The whole point of the in-flight guard: a second caller is turned away
    /// rather than queued behind a download that can take two minutes.
    #[tokio::test]
    async fn a_second_check_no_ops_while_one_is_running() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let rx = Arc::new(tokio::sync::Mutex::new(Some(rx)));
        let f: UpdateFn = Arc::new(move |_| {
            let c = c.clone();
            let rx = rx.clone();
            Box::pin(async move {
                c.fetch_add(1, Ordering::SeqCst);
                // Block until the test releases us, so the first call is
                // genuinely still in flight when the second arrives.
                if let Some(rx) = rx.lock().await.take() {
                    let _ = rx.await;
                }
                Ok(status(Some("1"), Some("1")))
            })
        });
        let h = Arc::new(harness(f, calls));

        let first = {
            let h = h.clone();
            tokio::spawn(async move { h.coord.check_now(DAY).await })
        };
        // Wait until the fake updater has actually been entered. Bounded:
        // an unbounded spin here hangs the whole suite if the first call
        // never reaches the updater, which is exactly what happens when the
        // body is unimplemented or panics.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while h.calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the first check should have entered the updater");

        assert!(
            h.coord.check_now(DAY).await.is_none(),
            "a second check must be turned away, not queued"
        );
        assert_eq!(h.calls.load(Ordering::SeqCst), 1, "and must not run");

        let _ = tx.send(());
        let _ = first.await.unwrap().expect("first call completed");
    }

    #[tokio::test]
    async fn check_if_due_respects_the_kill_switch() {
        let (f, calls) = instant_update(status(Some("1"), Some("2")));
        let h = harness(f, calls);
        h.settings.write().yt_dlp_auto_update = false;
        h.coord.check_if_due(10 * DAY).await;
        assert_eq!(
            h.calls.load(Ordering::SeqCst),
            0,
            "switched off means no network request at all"
        );
        assert_eq!(
            h.settings.read().yt_dlp_last_update_ms,
            None,
            "and no timestamp, so switching it back on checks immediately"
        );
    }

    #[tokio::test]
    async fn check_if_due_skips_a_recent_check() {
        let (f, calls) = instant_update(status(Some("1"), Some("2")));
        let h = harness(f, calls);
        let now = 10 * DAY;
        h.settings.write().yt_dlp_last_update_ms = Some(now - 1000);
        h.coord.check_if_due(now).await;
        assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn check_if_due_runs_when_overdue() {
        let (f, calls) = instant_update(status(Some("1"), Some("2")));
        let h = harness(f, calls);
        let now = 10 * DAY;
        h.settings.write().yt_dlp_last_update_ms = Some(now - 2 * DAY);
        h.coord.check_if_due(now).await;
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        assert_eq!(h.settings.read().yt_dlp_last_update_ms, Some(now));
    }

    /// The timestamp write must not clobber a settings change made while the
    /// check was in flight. Both writers rewrite the whole file, so the only
    /// thing keeping them in order is that each holds the write lock across
    /// its own save — mutate-then-release-then-save lets the older snapshot
    /// land second and silently revert the user's change on next launch.
    #[tokio::test]
    async fn recording_the_timestamp_does_not_clobber_a_concurrent_settings_write() {
        let (f, calls) = instant_update(status(Some("1"), Some("1")));
        let h = harness(f, calls);

        // The window is narrow — between releasing the write lock and the
        // file write landing — so a single interleaving catches a regression
        // only about a third of the time (measured). Repeating it turns a
        // coin-flip into a reliable failure.
        for i in 0..20u32 {
            let width = 300 + i;
            let now = 7 * DAY + i as i64;

            // Stand in for `settings_set`: take the write lock, change
            // something, and save under it — what the real command does.
            let settings = h.settings.clone();
            let path = h.coord.settings_path.clone();
            let user_edit = tokio::task::spawn_blocking(move || {
                let mut w = settings.write();
                w.queue_sidebar_width = width;
                goop_config::save(&path, &w).unwrap();
            });

            let _ = h.coord.check_now(now).await.expect("ran");
            user_edit.await.unwrap();

            let on_disk = goop_config::load(&h.coord.settings_path).expect("settings file");
            assert_eq!(
                on_disk.queue_sidebar_width, width,
                "iteration {i}: the user's change must survive the timestamp write"
            );
            assert_eq!(
                on_disk.yt_dlp_last_update_ms,
                Some(now),
                "iteration {i}: and the timestamp must survive the user's write"
            );
        }
    }

    /// An offline launch must back off like any other completed check, or a
    /// machine with no network retries on every single start.
    #[tokio::test]
    async fn a_failed_check_still_records_the_timestamp_and_stays_quiet() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let f: UpdateFn = Arc::new(move |_| {
            let c = c.clone();
            Box::pin(async move {
                c.fetch_add(1, Ordering::SeqCst);
                Err(GoopError::Queue("yt-dlp update: offline".into()))
            })
        });
        let h = harness(f, calls);
        let now = 10 * DAY;
        h.coord.check_if_due(now).await;
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        assert_eq!(h.settings.read().yt_dlp_last_update_ms, Some(now));
        assert!(
            h.sink.sidecar.lock().is_empty(),
            "a failed background check must not surface anything to the user"
        );
    }

    // ---- check_after_stale_failure --------------------------------------

    const MINUTE: i64 = 60 * 1000;

    /// The daily throttle is deliberately bypassed here — a job failing
    /// *now* is better evidence than a calendar — so the kill switch is the
    /// only thing standing between "switched off" and a network request per
    /// failed job.
    #[tokio::test]
    async fn a_stale_failure_check_respects_the_kill_switch() {
        let (f, calls) = instant_update(status(Some("1"), Some("2")));
        let h = harness(f, calls);
        h.settings.write().yt_dlp_auto_update = false;
        assert!(h.coord.check_after_stale_failure(10 * DAY).await.is_none());
        assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    }

    /// The daily throttle must NOT apply: the whole point is that a job just
    /// failed in a way a fresher binary fixes, which is news the calendar
    /// does not have.
    #[tokio::test]
    async fn a_stale_failure_check_ignores_the_daily_throttle() {
        let (f, calls) = instant_update(status(Some("2026.06.09"), Some("2026.07.04")));
        let h = harness(f, calls);
        let now = 10 * DAY;
        h.settings.write().yt_dlp_last_update_ms = Some(now - 1000);

        let updated = h
            .coord
            .check_after_stale_failure(now)
            .await
            .expect("a changed binary");
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        assert_eq!(updated.from, "2026.06.09");
        assert_eq!(updated.to, "2026.07.04");
    }

    /// A site that has genuinely rotted fails every job pointed at it, and
    /// each of those failures looks exactly as stale as the first. Without
    /// this, a twenty-item batch is twenty version checks.
    #[tokio::test]
    async fn a_second_failure_within_the_window_does_not_check_again() {
        let (f, calls) = instant_update(status(Some("1"), None));
        let h = harness(f, calls);
        let now = 10 * DAY;

        assert!(h.coord.check_after_stale_failure(now).await.is_none());
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);

        for offset in [1, MINUTE, 29 * MINUTE] {
            assert!(h
                .coord
                .check_after_stale_failure(now + offset)
                .await
                .is_none());
        }
        assert_eq!(h.calls.load(Ordering::SeqCst), 1, "still just the one");

        assert!(h
            .coord
            .check_after_stale_failure(now + 30 * MINUTE)
            .await
            .is_none());
        assert_eq!(
            h.calls.load(Ordering::SeqCst),
            2,
            "the window has passed, so the question is worth asking again"
        );
    }

    /// The window covers checks that DID change the binary too. Half a
    /// minute after an update there is nothing newer to find, so a second
    /// failing job asking again is the same wasted request as after an
    /// "already up to date".
    #[tokio::test]
    async fn the_window_applies_after_a_successful_update_too() {
        let (f, calls) = instant_update(status(Some("2026.06.09"), Some("2026.07.04")));
        let h = harness(f, calls);
        let now = 10 * DAY;

        assert!(h.coord.check_after_stale_failure(now).await.is_some());
        assert!(h
            .coord
            .check_after_stale_failure(now + MINUTE)
            .await
            .is_none());
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    }

    /// "Checked, already current" is the common case, and it must read as
    /// "nothing changed" — re-running the job against identical bytes would
    /// fail identically while claiming a fix had been tried.
    #[tokio::test]
    async fn an_already_current_binary_reports_no_change() {
        let (f, calls) = instant_update(status(Some("2026.07.04"), None));
        let h = harness(f, calls);
        assert!(h.coord.check_after_stale_failure(DAY).await.is_none());
        assert_eq!(h.calls.load(Ordering::SeqCst), 1, "it did ask");
    }

    /// A failed check is not evidence the binary changed.
    #[tokio::test]
    async fn a_failed_check_reports_no_change() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let f: UpdateFn = Arc::new(move |_| {
            let c = c.clone();
            Box::pin(async move {
                c.fetch_add(1, Ordering::SeqCst);
                Err(GoopError::Queue("yt-dlp update: offline".into()))
            })
        });
        let h = harness(f, calls);
        assert!(h.coord.check_after_stale_failure(DAY).await.is_none());
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    }

    /// A first install has no previous version to read. The note the user
    /// eventually sees still has to say something in that slot.
    #[tokio::test]
    async fn an_unknown_previous_version_still_names_itself() {
        let (f, calls) = instant_update(status(None, Some("2026.07.04")));
        let h = harness(f, calls);
        let updated = h
            .coord
            .check_after_stale_failure(DAY)
            .await
            .expect("changed");
        assert_eq!(updated.from, "unknown");
        assert_eq!(updated.to, "2026.07.04");
    }

    /// Same reasoning as `should_check`: a clock that moved backwards must
    /// not lock checks out until real time catches up.
    #[tokio::test]
    async fn a_backwards_clock_does_not_lock_out_stale_failure_checks() {
        let (f, calls) = instant_update(status(Some("1"), None));
        let h = harness(f, calls);
        let now = 10 * DAY;
        assert!(h.coord.check_after_stale_failure(now).await.is_none());
        assert!(h
            .coord
            .check_after_stale_failure(now - 5 * DAY)
            .await
            .is_none());
        assert_eq!(h.calls.load(Ordering::SeqCst), 2);
    }
}
