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
}
