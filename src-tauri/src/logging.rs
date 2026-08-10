//! Rolling file log.
//!
//! Everything below the UI already speaks `tracing`, but until now it only
//! reached stderr — which a packaged app has no one attached to. When a user
//! reports that a download failed last Tuesday there is nothing to read: the
//! queue row holds one message, the row before it is gone, and anything the
//! dispatcher decided along the way was written to a stream nobody saw.
//!
//! So the same events also go to a daily file under `data_dir()/logs`, seven
//! days deep. Deliberately NOT `tauri-plugin-log`: the workspace crates are
//! all instrumented with `tracing` already, and a second logging facade would
//! only capture the half of the app that lives in `src-tauri`.

use std::path::{Path, PathBuf};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// Same directives the stderr subscriber has always used. `warn` keeps
/// third-party crates' warnings; `goop=info` is our own floor.
pub const DEFAULT_FILTER: &str = "goop=info,warn";

/// Environment override, for a user we've asked to reproduce something with
/// more detail than the default gives.
pub const FILTER_ENV: &str = "GOOP_LOG";

/// How many daily files to keep. A week covers "it broke over the weekend"
/// without letting a chatty debug session grow without bound.
const KEEP_DAYS: usize = 7;

/// Where the rolling files live.
///
/// Under the data dir rather than a cache dir: these are the evidence for a
/// bug report, and a cache is something the OS is entitled to delete.
pub fn log_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

/// The filter directives to run with. `GOOP_LOG` wins when it says anything
/// at all; an empty or whitespace-only value is treated as unset, since that
/// is what an exported-but-blank shell variable looks like.
pub fn filter_directive(env: Option<&str>) -> String {
    match env {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => DEFAULT_FILTER.to_string(),
    }
}

fn env_filter() -> EnvFilter {
    let directive = filter_directive(std::env::var(FILTER_ENV).ok().as_deref());
    // A malformed override must not cost the user their logs entirely.
    EnvFilter::try_new(&directive).unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER))
}

/// Build the stderr + file subscriber without installing it.
///
/// Split out from `init` purely so a test can install it on one thread and
/// read back what actually landed on disk. A global subscriber can only be
/// set once per process, which would otherwise make the thing this module
/// exists to do the one thing it cannot check.
fn build(dir: &Path) -> std::io::Result<(impl tracing::Subscriber + Send + Sync, WorkerGuard)> {
    std::fs::create_dir_all(dir)?;
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("goop")
        .filename_suffix("log")
        .max_log_files(KEEP_DAYS)
        .build(dir)
        .map_err(std::io::Error::other)?;
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let subscriber = tracing_subscriber::registry()
        .with(env_filter())
        .with(tracing_subscriber::fmt::layer())
        .with(
            tracing_subscriber::fmt::layer()
                // No colour: this one goes to a file, and escape codes in a
                // log a user is about to paste into an issue are noise.
                .with_ansi(false)
                .with_writer(writer),
        );
    Ok((subscriber, guard))
}

/// Owns the writer thread for the whole process.
///
/// A static rather than a field on `AppState`, for two reasons that both
/// matter more than tidiness:
///
/// 1. **It exists earlier.** `init` runs before the Tauri builder, and
///    `setup` can `process::exit` on a lost queue lock *before* `AppState` is
///    ever constructed. Those two lines — the ones explaining why the app
///    refused to start — are the highest-value thing this module writes.
/// 2. **It can be flushed.** A guard behind a shared `&AppState` cannot be
///    dropped, and dropping is what flushes.
///
/// Holding it here keeps the writer alive exactly as a field would: the
/// hazard the guard exists for is being dropped EARLY, and a static is never
/// dropped at all.
static GUARD: parking_lot::Mutex<Option<WorkerGuard>> = parking_lot::Mutex::new(None);

/// Install the stderr + rolling-file subscriber.
///
/// Returns whether file logging is on. A `false` is not fatal: stderr logging
/// is installed either way, so a read-only or full disk costs the file log
/// and nothing else.
pub fn init(data_dir: &Path) -> bool {
    let dir = log_dir(data_dir);
    match build(&dir) {
        Ok((subscriber, guard)) => {
            subscriber.init();
            *GUARD.lock() = Some(guard);
            tracing::info!(dir = %dir.display(), keep_days = KEEP_DAYS, "file logging started");
            true
        }
        Err(e) => {
            // Stderr only. Nothing has been installed yet, so this still
            // reaches a `tauri dev` console.
            tracing_subscriber::fmt()
                .with_env_filter(env_filter())
                .init();
            tracing::warn!(dir = %dir.display(), error = %e, "file logging unavailable");
            false
        }
    }
}

/// Drain and stop the writer thread. Call immediately before the process
/// ends.
///
/// This is not belt-and-braces. `tao`'s event loop ends in `process::exit`
/// on both shipped platforms, and `process::exit` runs no destructors — so
/// nothing drops the guard on a normal quit, and the flush-on-drop that
/// `tracing-appender` documents never happens. The worker does flush after
/// each batch it drains, so most lines land anyway; what is lost is whatever
/// is still in the channel at the moment of exit. That window is widest for
/// a log-then-exit-immediately path, which is exactly what the startup
/// failures do.
///
/// Idempotent, and a no-op when file logging was never installed.
pub fn flush() {
    // Dropping the guard sends the shutdown message and waits for the worker
    // to drain (bounded by tracing-appender's own timeout).
    drop(GUARD.lock().take());
}

/// Record which sidecar builds this session is running, once.
///
/// The first question about any extractor failure is "which yt-dlp?", and by
/// the time it is asked the binary has usually been updated. Written at
/// startup so every day's file opens with the answer for that day.
pub async fn log_sidecar_versions(resolver: &goop_sidecar::BinaryResolver) {
    use goop_sidecar::updater::UpdateChecker;
    let checkers = [
        ("yt-dlp", UpdateChecker::for_yt_dlp(resolver)),
        ("gallery-dl", UpdateChecker::for_gallery_dl(resolver)),
        ("gs", UpdateChecker::for_ghostscript(resolver)),
        ("mutool", UpdateChecker::for_mutool(resolver)),
        ("tesseract", UpdateChecker::for_tesseract(resolver)),
    ];
    for (name, checker) in checkers {
        // An absent sidecar is worth recording too — "not installed" is an
        // answer, and a resolver miss is itself a plausible cause of the
        // failure being investigated.
        let version = checker.current_version().await.ok();
        let path = resolver
            .resolve(name)
            .ok()
            .map(|r| r.path.to_string_lossy().into_owned());
        tracing::info!(
            sidecar = name,
            version = version.as_deref().unwrap_or("unknown"),
            path = path.as_deref().unwrap_or("not found"),
            "sidecar"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_live_beside_the_queue_not_in_a_cache() {
        let dir = log_dir(Path::new("/data/goop"));
        assert_eq!(dir, PathBuf::from("/data/goop/logs"));
    }

    #[test]
    fn the_default_filter_applies_when_the_override_says_nothing() {
        assert_eq!(filter_directive(None), DEFAULT_FILTER);
        // An exported-but-blank shell variable arrives as `Some("")`, and
        // treating that as a directive would filter everything out.
        assert_eq!(filter_directive(Some("")), DEFAULT_FILTER);
        assert_eq!(filter_directive(Some("   ")), DEFAULT_FILTER);
    }

    #[test]
    fn the_override_wins_when_it_says_something() {
        assert_eq!(filter_directive(Some("goop=debug")), "goop=debug");
        assert_eq!(
            filter_directive(Some("  goop_extractor=trace,warn  ")),
            "goop_extractor=trace,warn"
        );
    }

    /// Both directives the app can actually run with have to parse, or the
    /// fallback in `env_filter` is the only thing anyone ever sees.
    #[test]
    fn the_shipped_directives_parse() {
        assert!(EnvFilter::try_new(DEFAULT_FILTER).is_ok());
        assert!(EnvFilter::try_new(filter_directive(Some("goop=debug"))).is_ok());
    }

    /// A typo in `GOOP_LOG` must cost the user nothing: they still get the
    /// default rather than a silent subscriber.
    #[test]
    fn a_malformed_override_falls_back_rather_than_filtering_everything_out() {
        assert!(EnvFilter::try_new(filter_directive(Some("=======")).as_str()).is_err());
        // Which is the branch `env_filter` covers by falling back; assert the
        // fallback itself is sound so that path can't be the broken one.
        assert!(EnvFilter::try_new(DEFAULT_FILTER).is_ok());
    }

    /// The rolling appender is upstream's, but the *builder configuration* is
    /// ours and a rejected combination would leave the app with no file log
    /// at all. Exercising it against a real directory keeps that honest.
    #[test]
    fn the_appender_configuration_is_accepted() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = log_dir(tmp.path());
        std::fs::create_dir_all(&dir).unwrap();
        let built = RollingFileAppender::builder()
            .rotation(Rotation::DAILY)
            .filename_prefix("goop")
            .filename_suffix("log")
            .max_log_files(KEEP_DAYS)
            .build(&dir);
        assert!(built.is_ok(), "{built:?}");
    }

    /// An unwritable location must cost the file log and nothing else.
    /// `build` reporting the error is what lets `init` fall back to stderr
    /// instead of taking the app down on a full disk.
    #[test]
    fn an_unwritable_location_is_reported_rather_than_panicking() {
        let tmp = tempfile::tempdir().unwrap();
        // A file where the data dir should be: `create_dir_all` cannot
        // produce `logs` underneath it on any platform.
        let blocked = tmp.path().join("not-a-dir");
        std::fs::write(&blocked, b"x").unwrap();
        assert!(build(&log_dir(&blocked)).is_err());
    }

    /// The one that matters: an event actually reaches a file on disk.
    ///
    /// Everything else here checks configuration, and configuration that
    /// composes is not the same as lines that land — the whole hazard of
    /// `non_blocking` is that it fails by writing nothing at all, quietly.
    /// Installed on this thread only (`with_default`), because a global
    /// subscriber can be set once per process and every other test in this
    /// binary would inherit it.
    #[test]
    fn events_actually_reach_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = log_dir(tmp.path());
        let (subscriber, guard) = build(&dir).expect("a writable temp dir");

        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "goop_test", marker = "landed-on-disk", "hello");
        });
        // Dropping the guard flushes the background writer and joins it —
        // without this the assertion races the worker thread.
        drop(guard);

        let written: String = std::fs::read_dir(&dir)
            .expect("log dir")
            .filter_map(|e| e.ok())
            .map(|e| std::fs::read_to_string(e.path()).unwrap_or_default())
            .collect();
        assert!(
            written.contains("landed-on-disk"),
            "nothing reached the log file; got {written:?}"
        );
    }

    /// `flush` is what every exit path calls, so it has to actually release
    /// the guard (releasing is what drains the writer), be safe when file
    /// logging was never installed, and be safe to call twice — the
    /// startup-failure branches run it before `process::exit`, and the
    /// `RunEvent::Exit` handler runs it too.
    ///
    /// One test rather than three because they share the module-level
    /// `GUARD`, and cargo runs tests in the same process: split up, they
    /// would flush each other's state.
    #[test]
    fn flush_releases_the_guard_and_tolerates_repeats() {
        // Empty to begin with — this binary never calls `init`, which is
        // also the "file logging unavailable" case.
        flush();

        let tmp = tempfile::tempdir().unwrap();
        let (_subscriber, guard) = build(&log_dir(tmp.path())).expect("a writable temp dir");
        *GUARD.lock() = Some(guard);

        flush();
        assert!(
            GUARD.lock().is_none(),
            "flush must release the guard — holding it means the writer is never drained"
        );
        flush();
    }

    /// Dropping the guard is what drains the writer thread, and on a
    /// log-then-exit-immediately path it is the only thing that does.
    /// `tao`'s event loop ends in `process::exit`, which runs no
    /// destructors, so this has to be an explicit call rather than a
    /// scope ending.
    #[test]
    fn dropping_the_guard_drains_what_is_still_in_flight() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = log_dir(tmp.path());
        let (subscriber, guard) = build(&dir).expect("a writable temp dir");
        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(target: "goop_test", "the reason we are exiting");
        });

        drop(guard);

        let written: String = std::fs::read_dir(&dir)
            .expect("log dir")
            .filter_map(|e| e.ok())
            .map(|e| std::fs::read_to_string(e.path()).unwrap_or_default())
            .collect();
        assert!(
            written.contains("the reason we are exiting"),
            "the last line before an exit must survive it; got {written:?}"
        );
    }

    /// The file copy carries no ANSI escapes. A log a user is about to paste
    /// into an issue should not be full of colour codes.
    #[test]
    fn the_file_copy_is_not_coloured() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = log_dir(tmp.path());
        let (subscriber, guard) = build(&dir).expect("a writable temp dir");
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!(target: "goop_test", "plain please");
        });
        drop(guard);

        let written: String = std::fs::read_dir(&dir)
            .expect("log dir")
            .filter_map(|e| e.ok())
            .map(|e| std::fs::read_to_string(e.path()).unwrap_or_default())
            .collect();
        assert!(written.contains("plain please"), "{written:?}");
        assert!(
            !written.contains('\u{1b}'),
            "escape codes in the file: {written:?}"
        );
    }
}
