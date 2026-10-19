//! `/bin/sh` stand-ins for sidecars, shared by every crate's tests.
//!
//! A test points a `BinaryResolver` at a temp dir holding a script named
//! `ffmpeg`, `yt-dlp` or `gs`, so it can pin down what the code under test
//! does with a sidecar's exit code and output without the real binary.
//!
//! Writing one is not as simple as it looks — see [`write_script`]. Each
//! crate used to keep its own writer, and the fix for the race it describes
//! landed in one copy at a time: in goop-extractor twice (#66, then again
//! for a second file in the same binary, #76), then in some goop-converter
//! test files but not others, until a file without it failed on the Linux
//! runner. One writer, here, is what keeps the next test file from
//! repeating that; `scripts_are_written_only_through_write_script` below
//! fails if one goes around it.
//!
//! Unix-only: the stand-ins are shell scripts. The logic they exercise is
//! platform-independent, so the coverage gap on Windows is acceptable.

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// Argv [`write_script`] hands a script to prove it can be run. The guard
/// it writes ahead of every body answers it and exits before the body
/// runs. Sidecars are passed URLs, file paths and their own flags, so
/// nothing a real run sends can collide with it.
pub const EXEC_PROBE_ARG: &str = "--goop-exec-probe";

/// How long a sibling's forked child may keep a writer on a new script
/// before [`write_script`] gives up. A healthy child reaches its `execve`
/// within microseconds, so hitting this means something else holds the
/// file open.
const RUNNABLE_DEADLINE: Duration = Duration::from_secs(10);

/// Writes `body` to `path` as an executable `/bin/sh` script, and returns
/// only once it can actually be run.
///
/// Linux refuses to `execve` a file while any process holds it open for
/// writing (`ETXTBSY`), and a test binary runs its tests on parallel
/// threads of one process. The window is between our `File::create` and
/// our `drop`: a sibling test that spawns a process right then forks a
/// child which inherits a copy of our write descriptor, and that copy
/// outlives our own close — the kernel only drops it when the child
/// reaches its `execve`. Our exec, landing in between, is refused.
///
/// Neither of the obvious defences closes that window. `File::create`
/// already opens `O_CLOEXEC`, but cloexec fires at the child's exec, not
/// at its fork, and the gap in between is the whole bug. Writing to a
/// temp name and renaming into place does not help either: the kernel
/// counts writers per inode, and a rename keeps the inode.
///
/// So this waits for the condition the kernel checks rather than for a
/// length of time. Once our descriptor is closed, no process can gain a
/// new writer on the file: nothing reopens it for writing, and a fork
/// only copies the descriptors its parent still has. The set of writers
/// can only shrink, so one successful exec proves it is empty and stays
/// empty. The script is runnable for the rest of the test, however long
/// a sibling's child takes to get to its own exec.
///
/// Rewriting the same path reopens the window, and this closes it again
/// before returning.
///
/// macOS does not enforce `ETXTBSY` for scripts, so there the wait returns
/// on its first probe.
pub fn write_script(path: &Path, body: &str) {
    let mut file = std::fs::File::create(path)
        .unwrap_or_else(|e| panic!("could not create script {}: {e}", path.display()));
    write!(
        file,
        "#!/bin/sh\ncase \"$1\" in {EXEC_PROBE_ARG}) exit 0;; esac\n{body}\n"
    )
    .unwrap_or_else(|e| panic!("could not write script {}: {e}", path.display()));
    drop(file);
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .unwrap_or_else(|e| panic!("could not mark script {} executable: {e}", path.display()));
    wait_until_runnable(path, RUNNABLE_DEADLINE, || {
        Command::new(path)
            .arg(EXEC_PROBE_ARG)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    });
}

/// Retries `probe` while it fails with `ETXTBSY`, until it runs or
/// `timeout` passes. Any other spawn error, or a probe that runs but
/// exits non-zero, is a broken script rather than a busy one.
fn wait_until_runnable(
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
                    "script readiness probe exited unsuccessfully for {}: {status}",
                    path.display()
                );
                return;
            }
            Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => e,
            Err(e) => panic!("script {} could not be run at all: {e:?}", path.display()),
        };
        assert!(
            Instant::now() < deadline,
            "script {} was still held open for writing after {timeout:?}: {busy:?}",
            path.display()
        );
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::os::unix::process::ExitStatusExt;

    /// Regression for the intermittent `ETXTBSY` on the Linux runner: a
    /// test failed to spawn a script that had just been written, so it
    /// reported a spawn error instead of whatever it was asserting.
    ///
    /// Pins the contract that keeps it away: `write_script` returns only
    /// once the script can be run. Provoked by handing an unrelated
    /// process a writer on the same inode before the script is written,
    /// which is the state a sibling test's forked child leaves behind —
    /// reproducing it through that fork would mean hitting a microsecond
    /// window on purpose, and the kernel cannot tell the two apart anyway.
    ///
    /// This is the only test that proves the wait does anything:
    /// everywhere else it prevents a race rather than a deterministic
    /// failure, so deleting it would go unnoticed until CI flaked again.
    /// On macOS it only checks the helper stays out of the way.
    #[test]
    fn a_script_is_runnable_even_while_another_process_holds_a_writer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yt-dlp");

        // `>>` rather than `>`: the holder must not truncate the script
        // out from under the run below. It creates the file, so waiting
        // for the path to appear is enough to know the writer is open, and
        // `write_script`'s create truncates that same inode rather than
        // making a new one.
        let mut holder = Command::new("/bin/sh")
            .arg("-c")
            .arg("exec 9>>\"$0\"; sleep 0.5")
            .arg(&path)
            .spawn()
            .unwrap();
        while !path.exists() {
            std::thread::sleep(Duration::from_millis(1));
        }

        write_script(&path, "exit 7");

        let status = Command::new(&path)
            .status()
            .expect("a written script must be runnable once write_script returns");
        assert_eq!(status.code(), Some(7), "the script's own body must run");
        holder.wait().unwrap();
    }

    /// The probe must not run the body, or it would consume state a test
    /// keeps on disk — an attempt counter, a first-run marker — and the
    /// test would see one call more than the code under test made.
    #[test]
    fn the_readiness_probe_exits_before_the_body() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ffprobe");
        let marker = dir.path().join("ran");
        write_script(
            &path,
            &format!("printf 'body' ; : > '{}'", marker.display()),
        );
        assert!(!marker.exists(), "write_script's own probe ran the body");

        let probe = Command::new(&path).arg(EXEC_PROBE_ARG).output().unwrap();
        assert!(probe.status.success());
        assert!(
            probe.stdout.is_empty(),
            "the probe must exit before the body"
        );
        assert!(!marker.exists());

        let run = Command::new(&path).arg("actual-run").output().unwrap();
        assert!(run.status.success());
        assert_eq!(run.stdout, b"body");
        assert!(marker.exists());
    }

    #[test]
    fn a_script_receives_its_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gs");
        write_script(&path, "printf '%s|' \"$@\"");

        let run = Command::new(&path).args(["-q", "a b"]).output().unwrap();
        assert_eq!(run.stdout, b"-q|a b|");
    }

    /// Rewriting a path the helper already wrote must leave the new body
    /// in place and runnable, which is how a test changes a stand-in's
    /// behaviour between two calls.
    #[test]
    fn rewriting_a_script_runs_the_new_body() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ffmpeg");
        write_script(&path, "exit 3");
        write_script(&path, "exit 4");

        assert_eq!(Command::new(&path).status().unwrap().code(), Some(4));
    }

    #[test]
    fn readiness_retries_only_busy_spawn_errors() {
        let mut attempts = 0;
        wait_until_runnable(Path::new("script"), Duration::from_secs(1), || {
            attempts += 1;
            if attempts < 3 {
                Err(io::Error::from(io::ErrorKind::ExecutableFileBusy))
            } else {
                Ok(ExitStatus::from_raw(0))
            }
        });
        assert_eq!(attempts, 3);

        let mut denied_attempts = 0;
        let denied = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wait_until_runnable(Path::new("script"), Duration::from_secs(1), || {
                denied_attempts += 1;
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            });
        }));
        assert!(denied.is_err());
        assert_eq!(denied_attempts, 1, "a non-busy error must not be retried");
    }

    #[test]
    fn readiness_has_a_bounded_busy_deadline() {
        let mut attempts = 0;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wait_until_runnable(Path::new("script"), Duration::ZERO, || {
                attempts += 1;
                Err(io::Error::from(io::ErrorKind::ExecutableFileBusy))
            });
        }));
        assert!(result.is_err());
        assert_eq!(attempts, 1, "expired busy probes must not retry");
    }

    #[test]
    #[should_panic(expected = "script readiness probe exited unsuccessfully")]
    fn readiness_rejects_a_nonzero_probe_exit() {
        wait_until_runnable(Path::new("script"), Duration::from_secs(1), || {
            Ok(ExitStatus::from_raw(7 << 8))
        });
    }

    /// A `/bin/sh` stand-in written any other way skips the wait above,
    /// and nothing fails locally when it does — macOS never enforces
    /// `ETXTBSY` — so the gap only shows up as a rare red run on the
    /// Linux runner. This finds one before it gets there.
    ///
    /// Bodies a mock server hands to the updaters are exempt: production
    /// code downloads and writes those, so no test helper can wrap them.
    #[test]
    fn scripts_are_written_only_through_write_script() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut sources = Vec::new();
        for dir in ["crates", "src-tauri/src"] {
            collect_rust_sources(&root.join(dir), &mut sources);
        }
        assert!(
            sources.len() > 50,
            "found only {} Rust sources under {} — the scan is not looking where the tests are",
            sources.len(),
            root.display()
        );

        let offenders: Vec<String> = sources
            .iter()
            .filter(|path| !path.ends_with("goop-core/src/test_scripts.rs"))
            .flat_map(|path| {
                let text = std::fs::read_to_string(path).unwrap();
                text.lines()
                    .enumerate()
                    .filter(|(_, line)| line.contains("#!/bin/sh") && !line.contains("set_body"))
                    .map(|(index, _)| format!("{}:{}", path.display(), index + 1))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(
            offenders.is_empty(),
            "write test scripts with goop_core::test_scripts::write_script, which waits out \
             ETXTBSY; these write one by hand:\n{}",
            offenders.join("\n")
        );
    }

    fn collect_rust_sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                if path.file_name().is_some_and(|name| name == "target") {
                    continue;
                }
                collect_rust_sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }
}
