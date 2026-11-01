#![cfg(unix)]
mod common;

#[cfg(target_os = "linux")]
use common::executable::executable;
use common::executable::wait_until_executable_with;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::Command;
use std::time::Duration;

/// A script that is run straight after it was written can fail to start on
/// Linux, so no converter test may write one except through `executable`.
/// The marker is split so this file does not match itself.
#[test]
fn every_script_fixture_waits_until_executable() {
    let marker = concat!("#", "!/");
    let tests = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let helper = tests.join("common").join("executable.rs");
    let offenders: Vec<PathBuf> = rust_sources(&tests)
        .into_iter()
        .filter(|path| *path != helper)
        .filter(|path| std::fs::read_to_string(path).unwrap().contains(marker))
        .collect();
    assert!(
        offenders.is_empty(),
        "these tests write a script without waiting until it can run; use \
         common::executable::executable instead: {offenders:#?}"
    );
}

fn rust_sources(directory: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .flat_map(|path| {
            if path.is_dir() {
                rust_sources(&path)
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                vec![path]
            } else {
                Vec::new()
            }
        })
        .collect()
}

#[test]
fn readiness_retries_only_busy_spawn_errors() {
    use std::{io, os::unix::process::ExitStatusExt};
    let mut attempts = 0;
    wait_until_executable_with(Path::new("fixture"), Duration::from_secs(1), || {
        attempts += 1;
        if attempts < 3 {
            Err(io::Error::from(io::ErrorKind::ExecutableFileBusy))
        } else {
            Ok(std::process::ExitStatus::from_raw(0))
        }
    });
    assert_eq!(attempts, 3);

    let mut denied_attempts = 0;
    let denied = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait_until_executable_with(Path::new("fixture"), Duration::from_secs(1), || {
            denied_attempts += 1;
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        });
    }));
    assert!(denied.is_err());
    assert_eq!(denied_attempts, 1);
}

#[test]
fn readiness_has_a_bounded_busy_deadline() {
    let mut attempts = 0;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait_until_executable_with(Path::new("fixture"), Duration::ZERO, || {
            attempts += 1;
            Err(std::io::Error::from(std::io::ErrorKind::ExecutableFileBusy))
        });
    }));
    assert!(result.is_err());
    assert_eq!(attempts, 1, "expired busy probes must not retry");
}

/// The hazard `executable` exists for, made certain rather than left to
/// timing: while another process holds a ready script open for writing, as a
/// sibling test's forked child can, Linux refuses to run it. A fixture spawned
/// straight after it was written fails this way and never runs its body.
#[cfg(target_os = "linux")]
#[test]
fn linux_refuses_a_script_another_process_holds_open_for_writing() {
    let directory = tempfile::tempdir().unwrap();
    let binary = directory.path().join("ffmpeg");
    let held = directory.path().join("held");
    executable(&binary, "exit 7");

    let mut holder = Command::new("/bin/sh")
        .arg("-c")
        .arg("exec 9>>\"$0\"; : > \"$1\"; exec sleep 30")
        .arg(&binary)
        .arg(&held)
        .spawn()
        .unwrap();
    let marker_deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !held.exists() {
        assert!(
            std::time::Instant::now() < marker_deadline,
            "writer holder did not open {} within 2s; child status: {:?}",
            binary.display(),
            holder.try_wait().unwrap()
        );
        std::thread::sleep(Duration::from_millis(1));
    }

    let refused = Command::new(&binary).status();
    holder.kill().unwrap();
    holder.wait().unwrap();
    assert!(
        matches!(
            refused,
            Err(ref error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy
        ),
        "a script held open for writing must be refused as busy: {refused:?}"
    );
}

/// The same hazard while `executable` writes the script: it returns only once
/// the other process's handle has closed.
#[cfg(target_os = "linux")]
#[test]
fn executable_waits_out_an_inherited_writer_before_returning() {
    let directory = tempfile::tempdir().unwrap();
    let binary = directory.path().join("ffprobe");

    let mut holder = Command::new("/bin/sh")
        .arg("-c")
        .arg("exec 9>>\"$0\"; sleep 0.5")
        .arg(&binary)
        .spawn()
        .unwrap();
    let marker_deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !binary.exists() {
        assert!(
            std::time::Instant::now() < marker_deadline,
            "writer holder did not create {} within 2s; child status: {:?}",
            binary.display(),
            holder.try_wait().unwrap()
        );
        std::thread::sleep(Duration::from_millis(1));
    }

    executable(&binary, "exit 7");

    let status = Command::new(&binary)
        .status()
        .expect("a fixture must be runnable once executable returns");
    assert_eq!(status.code(), Some(7), "the fixture body must still run");
    holder.wait().unwrap();
}
