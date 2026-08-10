//! Fake sidecars for the tests that drive an extractor end-to-end.
//!
//! A "fake" is a `/bin/sh` script written into a temp dir that a
//! `BinaryResolver` is pointed at, so a test can pin down what this crate
//! does with a sidecar's exit code, stdout and stderr without a network.
//!
//! This lives in one module because writing one is not as simple as it
//! looks — see `wait_until_executable` — and the tests that need it are
//! spread across `backend.rs` and `gallery_dl.rs`. While each file had its
//! own copy, the `ETXTBSY` fix landed in one of them (#66) and left the
//! other exposed to the same race in the same test binary, until it was
//! written out a second time by hand (#76). Once is enough.
//!
//! Unix-only: the fakes are shell scripts. The logic they exercise is
//! platform-independent, so the coverage gap on Windows is acceptable.
//!
//! `goop-tauri`'s `probe_retry_tests` spawns fakes too and keeps its own
//! copy of all this. A `#[cfg(test)]` module is not importable from
//! another crate, so sharing it would mean making this a `pub` module
//! behind a `test-fakes` feature that `goop-tauri` asks for in
//! `[dev-dependencies]` — which would stay out of the shipped binary,
//! the way this crate already borrows `goop-core`'s `RecordingSink` via
//! `test-util` (the workspace sets `resolver = "2"`, so a feature enabled
//! only by a dev-dependency is not unified into a release build). It is
//! copied instead because that trade buys two tests in another crate at
//! the price of a public, feature-gated API on this one. Keep the two in
//! step by hand.

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

/// Argv `wait_until_executable` hands a fake to prove it can be run.
/// The dispatcher passes URLs and yt-dlp/gallery-dl flags, so nothing
/// a real run sends can collide with it.
pub(crate) const EXEC_PROBE_ARG: &str = "--goop-exec-probe";

/// Writes `body` into `dir/name` as a runnable `/bin/sh` script, and
/// returns only once it can actually be run.
pub(crate) fn write_fake(dir: &std::path::Path, name: &str, body: &str) {
    let path = dir.join(name);
    let mut f = std::fs::File::create(&path).unwrap();
    // The guard answers the probe below and exits before reaching the
    // body, so probing costs nothing but a `/bin/sh` startup.
    write!(
        f,
        "#!/bin/sh\ncase \"$1\" in {EXEC_PROBE_ARG}) exit 0;; esac\n{body}"
    )
    .unwrap();
    drop(f);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    wait_until_executable(&path);
}

/// Blocks until `path` can actually be `exec`d, which is not the same
/// moment as "we finished writing it".
///
/// Linux refuses to `execve` a file while any process holds it open
/// for writing (`ETXTBSY`), and these tests run in parallel inside one
/// process. The window is between our `File::create` and our `drop`:
/// a sibling test that spawns a sidecar right then forks a child which
/// inherits a copy of our write descriptor, and that copy outlives our
/// own close — the kernel only drops it when the child reaches its
/// `execve`. Our exec, landing in between, is refused.
///
/// Neither of the two obvious defences closes that window.
/// `File::create` already opens `O_CLOEXEC`, but cloexec fires at the
/// child's exec, not at its fork, and the gap in between is the whole
/// bug. Writing to a temp name and renaming into place does not help
/// either: the kernel counts writers per inode, and a rename does not
/// change the inode.
///
/// So wait it out instead. Nothing ever reopens a fake for writing, so
/// the set of processes holding a copy only shrinks — one successful
/// exec proves the path stays runnable from here on.
pub(crate) fn wait_until_executable(path: &std::path::Path) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut backoff = Duration::from_millis(1);
    loop {
        let busy = match std::process::Command::new(path)
            .arg(EXEC_PROBE_ARG)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
        {
            Ok(_) => return,
            Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => e,
            Err(e) => panic!("fake {} could not be run at all: {e:?}", path.display()),
        };
        assert!(
            std::time::Instant::now() < deadline,
            "fake {} was still held open for writing after 10s: {busy:?}",
            path.display()
        );
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_millis(25));
    }
}

/// Regression for an intermittent `ETXTBSY` on the Linux CI runner:
/// `dispatch` failed to spawn a fake that had just been written, so
/// the run reported a spawn error instead of whatever the test was
/// actually asserting.
///
/// Pins the contract that keeps it away: `write_fake` returns only
/// once the script it wrote can be run. Provoked by handing an
/// unrelated process a writer on the same inode before the script is
/// written, which is the state a sibling test's forked sidecar leaves
/// behind — reproducing it through that fork would mean hitting a
/// microsecond window on purpose, and the kernel cannot tell the two
/// apart anyway.
///
/// This is the only test that proves the wait does anything: everywhere
/// else it prevents a race rather than a deterministic failure, so
/// deleting it would go unnoticed until CI started flaking again.
///
/// macOS does not enforce `ETXTBSY` for scripts, so there this only
/// checks the helper stays out of the way.
#[test]
fn a_fake_is_runnable_even_while_another_process_holds_a_writer() {
    let bins = tempfile::TempDir::new().unwrap();
    let path = bins.path().join("yt-dlp");

    // `>>` rather than `>`: the holder must not truncate the script
    // out from under the run below. It creates the file, so waiting
    // for the path to appear is enough to know the writer is open,
    // and `write_fake`'s create truncates that same inode rather than
    // making a new one.
    let mut holder = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("exec 9>>\"$0\"; sleep 0.5")
        .arg(&path)
        .spawn()
        .unwrap();
    while !path.exists() {
        std::thread::sleep(Duration::from_millis(1));
    }

    write_fake(bins.path(), "yt-dlp", "exit 7\n");

    let status = std::process::Command::new(&path)
        .status()
        .expect("a written fake must be runnable once write_fake returns");
    assert_eq!(status.code(), Some(7), "the fake's own body must run");
    holder.wait().unwrap();
}
