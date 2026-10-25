//! A clock that moves only when a test moves it, for tests whose stand-in
//! children race a query deadline.
//!
//! Every ffprobe query runs under a 5 second deadline. Counted in real time,
//! that deadline races each stand-in child, and a loaded machine can hold a
//! child for seconds before it runs. These tests run on a paused clock
//! (`start_paused`) instead. `hold`, `expire` and `cancel` keep a blocking task
//! running for the whole run, and a running blocking task stops a paused clock
//! from auto-advancing, so no deadline falls due on its own however slowly a
//! child starts. `expire` moves the clock past a deadline, and `cancel` cancels,
//! only once the query's child has armed: written its pid to `<pid file>.tmp`
//! and renamed that over the pid file, so a reader sees a whole pid or none.

use std::cell::Cell;
use std::fmt::Debug;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

/// The converter's query deadline, which its error messages name. It mirrors
/// a private constant in `bounded_process`; were that one longer, `expire`
/// would not reach it, and the run would fail at `LIVENESS_LIMIT`.
pub const QUERY_DEADLINE: Duration = Duration::from_secs(5);

/// How far `expire` moves the clock past a deadline. Tokio rounds a timer's
/// deadline up to a whole millisecond, so landing exactly on it fires the
/// timer only when the clock was paused from the start.
const PAST_DEADLINE: Duration = Duration::from_millis(1);

/// How long an armed child sleeps, longer than `LIVENESS_LIMIT`: a run that
/// waits for its child to exit on its own fails instead of passing late.
const LIFETIME_SECONDS: u64 = 120;

/// Real time a whole run may take. Correct code needs a few seconds at most,
/// even behind a stand-in that sleeps first; this only stops a broken run
/// from hanging its test.
const LIVENESS_LIMIT: Duration = Duration::from_secs(LIFETIME_SECONDS / 2);

/// Shell commands that arm the child, then sleep for its lifetime.
pub fn script(pid_file: &Path) -> String {
    let path = pid_file.to_str().expect("pid file path is UTF-8");
    assert!(!path.contains('\''), "{path:?} cannot be single-quoted");
    format!("echo $$ > '{path}.tmp' && mv '{path}.tmp' '{path}' && exec sleep {LIFETIME_SECONDS}")
}

// These wrappers box `run` before any async frame stores it. A conversion's
// future is large, and every frame that held it by value would sit on the test
// thread's stack, which a debug build overflowed.

/// Runs `run` with the clock held, so no query deadline can fall due.
pub fn hold<'a, T: Debug + 'a>(run: impl Future<Output = T> + 'a) -> impl Future<Output = T> + 'a {
    run_held(Box::pin(run), None)
}

/// Runs `run`, moving the clock past `deadlines` query deadlines in turn, each
/// once the child that writes `pid_file` has armed. The pid file is removed
/// once read, so the next query's child can write it afresh.
pub fn expire<'a, T: Debug + 'a>(
    pid_file: &'a Path,
    deadlines: usize,
    run: impl Future<Output = T> + 'a,
) -> impl Future<Output = T> + 'a {
    run_held(
        Box::pin(run),
        Some((pid_file, vec![Step::Expire; deadlines])),
    )
}

/// Runs `run`, cancelling `token` once the child that writes `pid_file` has
/// armed.
pub fn cancel<'a, T: Debug + 'a>(
    pid_file: &'a Path,
    token: &'a CancellationToken,
    run: impl Future<Output = T> + 'a,
) -> impl Future<Output = T> + 'a {
    run_held(Box::pin(run), Some((pid_file, vec![Step::Cancel(token)])))
}

#[derive(Clone, Copy)]
enum Step<'a> {
    Expire,
    Cancel(&'a CancellationToken),
}

/// Holds the clock until `run` returns, taking each step once the child that
/// writes the pid file arms. Asserts that every armed child was reaped, and
/// returns what `run` returned.
///
/// `run` must not have been polled yet, so it cannot start a query before the
/// clock is held.
async fn run_held<'a, T: Debug>(
    run: Pin<Box<dyn Future<Output = T> + 'a>>,
    armed_steps: Option<(&'a Path, Vec<Step<'a>>)>,
) -> T {
    assert_paused();
    let stop = Arc::new(AtomicBool::new(false));
    let _stop_on_unwind = StopOnDrop(Arc::clone(&stop));
    // Spawned before `run` is first polled, so the clock holds still from the
    // start, and runs until `run` returns.
    let watchdog = tokio::task::spawn_blocking({
        let stop = Arc::clone(&stop);
        move || watch(&stop)
    });
    let last_armed = Cell::new(None);
    let checked_run = async {
        let result = run.await;
        // Checked at once, since any await would let tokio reap a child the run
        // abandoned. Best effort all the same: tokio's drop-time try_wait reaps
        // a child that died at once, and another test's runtime in this binary
        // can drain tokio's process-wide orphan queue first.
        let unreaped = last_armed.get().filter(|&pid| pid_exists(pid));
        stop.store(true, Ordering::Relaxed);
        (result, unreaped)
    };
    let drive = async {
        let mut taken = 0;
        if let Some((pid_file, steps)) = &armed_steps {
            for step in steps {
                let Some(pid) = armed(pid_file.to_path_buf(), Arc::clone(&stop)).await else {
                    break;
                };
                if let Some(previous) = last_armed.replace(Some(pid)) {
                    assert!(
                        !pid_exists(previous),
                        "child {previous} was still running when the next query's child armed"
                    );
                }
                match step {
                    Step::Expire => tokio::time::advance(QUERY_DEADLINE + PAST_DEADLINE).await,
                    Step::Cancel(token) => token.cancel(),
                }
                taken += 1;
            }
        }
        let timed_out = watchdog.await.expect("watchdog panicked");
        assert!(
            !timed_out,
            "the run was still going after {LIVENESS_LIMIT:?} of real time"
        );
        taken
    };
    let ((result, unreaped), taken) = tokio::join!(checked_run, drive);
    let expected = armed_steps.as_ref().map_or(0, |(_, steps)| steps.len());
    assert_eq!(
        taken, expected,
        "the run returned before its children armed: {result:?}"
    );
    if let Some(pid) = unreaped {
        panic!("child {pid} was not reaped before the run returned");
    }
    result
}

/// A paused clock reads the same before and after real time passes.
fn assert_paused() {
    let before = tokio::time::Instant::now();
    std::thread::sleep(Duration::from_millis(1));
    assert_eq!(
        before,
        tokio::time::Instant::now(),
        "a held clock needs #[tokio::test(start_paused = true)]"
    );
}

/// Waits until the run has stopped, or `LIVENESS_LIMIT` passes; true for the
/// latter.
fn watch(stop: &AtomicBool) -> bool {
    let limit = Instant::now() + LIVENESS_LIMIT;
    while !stop.load(Ordering::Relaxed) {
        if Instant::now() >= limit {
            stop.store(true, Ordering::Relaxed);
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

/// The pid the child wrote once it armed, removing the pid file, or `None`
/// once the run has stopped without it arming. Polls in a blocking task,
/// because a held clock never wakes a timer.
async fn armed(pid_file: PathBuf, stop: Arc<AtomicBool>) -> Option<u32> {
    tokio::task::spawn_blocking(move || loop {
        match std::fs::read_to_string(&pid_file) {
            Ok(pid) => {
                std::fs::remove_file(&pid_file).expect("pid file can be removed");
                return Some(pid.trim().parse().expect("pid file holds a pid"));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("could not read {}: {error}", pid_file.display()),
        }
        if stop.load(Ordering::Relaxed) {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    })
    .await
    .expect("pid file wait panicked")
}

/// Whether `pid` still names a process. A zombie does, until it is reaped.
fn pid_exists(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .expect("kill -0 could not run")
        .success()
}

/// Stops the watchdog and any pid file wait if the test unwinds, since the
/// runtime waits for blocking tasks before it shuts down.
struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}
