//! Shell-script stand-ins for sidecars, written so a test can run them at once.
//!
//! Linux refuses to run a file that any process holds open for writing
//! (`ETXTBSY`, "Text file busy"). The tests in one binary run on parallel
//! threads of one process, so a sibling test's spawn can fork while this
//! script's write handle is still open, and the forked child keeps that handle
//! until its own exec. A script run straight after it was written can then
//! fail to start, which a test sees as a stand-in that never ran. macOS does
//! not enforce this for scripts, so only the Linux runner ever showed it.
//!
//! [`executable`] runs each script once with [`EXEC_PROBE_ARG`], which every
//! script it writes answers before its body, and retries only that busy error.
//! It returns once the script can be run. Every test under `tests/` that
//! writes a script goes through it, and `fixture_executable.rs` fails on one
//! that does not. Unit tests in `src/` cannot reach this module.

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// The argument that makes a stand-in exit 0 before its body runs.
pub const EXEC_PROBE_ARG: &str = "--goop-exec-probe";

/// How long [`executable`] waits for an inherited write handle to close.
const READY_TIMEOUT: Duration = Duration::from_secs(10);

/// Writes `body` as an executable shell script at `path` and returns only
/// once it can be run.
pub fn executable(path: &Path, body: &str) {
    let mut file = std::fs::File::create(path).unwrap();
    write!(
        file,
        "#!/bin/sh\ncase \"$1\" in {EXEC_PROBE_ARG}) exit 0;; esac\n{body}\n"
    )
    .unwrap();
    drop(file);
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    wait_until_executable(path);
}

pub fn wait_until_executable(path: &Path) {
    wait_until_executable_with(path, READY_TIMEOUT, || {
        Command::new(path)
            .arg(EXEC_PROBE_ARG)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    });
}

/// Retries `probe` while it fails with `ExecutableFileBusy`, for at most
/// `timeout`. Any other spawn error, or a probe that exits unsuccessfully,
/// fails the test at once.
pub fn wait_until_executable_with(
    path: &Path,
    timeout: Duration,
    mut probe: impl FnMut() -> std::io::Result<ExitStatus>,
) {
    let deadline = Instant::now() + timeout;
    let mut backoff = Duration::from_millis(1);
    loop {
        let busy = match probe() {
            Ok(status) => {
                assert!(
                    status.success(),
                    "fixture readiness probe exited unsuccessfully for {}: {status}",
                    path.display()
                );
                return;
            }
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy => error,
            Err(error) => panic!("fixture {} could not be run: {error:?}", path.display()),
        };
        assert!(
            Instant::now() < deadline,
            "fixture {} was still held open for writing after {timeout:?}: {busy:?}",
            path.display()
        );
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_millis(25));
    }
}
