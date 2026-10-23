//! Child processes for the tests that cancel a query or let its deadline fall due.
//!
//! A child arms by writing its pid to `<pid file>.tmp` and renaming that over
//! the pid file, so a reader sees a whole pid or nothing. A test cancels, or
//! lets the deadline fall due, only once the child has armed: until then it
//! may not have started, and a loaded machine can hold it there for seconds.
//!
//! The tests run on a paused clock (`start_paused`). `assert_reaps_armed_child`
//! waits for the pid in `spawn_blocking`, and a running blocking task stops a
//! paused clock from auto-advancing, so a query's deadline cannot fall due
//! before the child has armed. Once it has, an idle runtime jumps straight to
//! the deadline, so no test waits for one in real time.

use std::fmt::Debug;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

/// How long an armed child sleeps. A run that never kills its child returns
/// only once this ends, long after `KILL_LIMIT`.
const LIFETIME_SECONDS: u64 = 120;

/// Real time a run may take, once its child armed, to kill and reap it.
/// Correct code needs milliseconds; this only catches a run that leaves its
/// child to exit on its own.
const KILL_LIMIT: Duration = Duration::from_secs(LIFETIME_SECONDS / 4);

/// Real time a child may take to arm, so one that never does fails its test
/// instead of hanging it.
const ARM_LIMIT: Duration = Duration::from_secs(60);

/// Shell commands that arm the child, then sleep for its lifetime.
pub(crate) fn script(pid_file: &Path) -> String {
    let path = pid_file.to_str().expect("pid file path is UTF-8");
    assert!(!path.contains('\''), "{path:?} cannot be single-quoted");
    format!("echo $$ > '{path}.tmp' && mv '{path}.tmp' '{path}' && exec sleep {LIFETIME_SECONDS}")
}

/// Runs `run` to completion, cancelling `cancel` (when given) only once the
/// child that writes `pid_file` has armed, then asserts that the run reaped
/// that child before it returned. Returns what the run returned.
///
/// `run` must not have been polled yet, so its child cannot start before the
/// wait below holds the clock. That wait relies on the current-thread runtime
/// `start_paused` already requires.
pub(crate) async fn assert_reaps_armed_child<T: Debug>(
    pid_file: PathBuf,
    cancel: Option<&CancellationToken>,
    run: impl Future<Output = T>,
) -> T {
    let returned = Arc::new(AtomicBool::new(false));
    // Spawned before `run` is first polled, so the paused clock holds still
    // from the start until the child has armed.
    let armed = tokio::task::spawn_blocking({
        let returned = Arc::clone(&returned);
        move || wait_for_pid(&pid_file, &returned)
    });
    let run = async {
        let result = run.await;
        returned.store(true, Ordering::Relaxed);
        result
    };
    let trigger = async {
        let pid = armed.await.expect("pid file wait panicked")?;
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        Some((pid, Instant::now()))
    };
    let (result, armed) = tokio::join!(run, trigger);
    let Some((pid, armed_at)) = armed else {
        panic!("the run returned before its child armed: {result:?}");
    };
    let took = armed_at.elapsed();
    // Best effort: tokio's drop-time try_wait also reaps a child that has
    // already died, so a run that skips its own wait can pass when its child
    // dies fast. The check still runs once, at once, because any later check
    // would give tokio's orphan reaper time to reap a child the run abandoned.
    assert!(
        !pid_exists(pid),
        "child {pid} was not reaped before the run returned"
    );
    assert!(
        took < KILL_LIMIT,
        "the run left child {pid} to exit on its own"
    );
    result
}

/// The child's pid once it has armed, or `None` once the run has returned
/// without it arming.
fn wait_for_pid(pid_file: &Path, returned: &AtomicBool) -> Option<u32> {
    let limit = Instant::now() + ARM_LIMIT;
    loop {
        match std::fs::read_to_string(pid_file) {
            Ok(pid) => return Some(pid.trim().parse().expect("pid file holds a pid")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("could not read {}: {error}", pid_file.display()),
        }
        if returned.load(Ordering::Relaxed) {
            return None;
        }
        assert!(
            Instant::now() < limit,
            "child never armed {}",
            pid_file.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
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
