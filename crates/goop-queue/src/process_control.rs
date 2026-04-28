//! Cross-platform pause / resume primitives for child processes by PID.
//!
//! - On Unix (macOS, Linux), pause sends `SIGSTOP` and resume sends `SIGCONT`.
//! - On Windows, pause calls `NtSuspendProcess` and resume calls
//!   `NtResumeProcess` against a handle obtained from `OpenProcess` with
//!   `PROCESS_SUSPEND_RESUME` access.
//!
//! Both signals are uncatchable / unblockable — the target process cannot
//! refuse to pause.

use std::io;

#[derive(Debug, thiserror::Error)]
pub enum ProcessControlError {
    #[error("process not found (pid {0})")]
    NotFound(u32),
    #[error("permission denied for pid {0}")]
    PermissionDenied(u32),
    #[error("process control failed for pid {pid}: {source}")]
    Other {
        pid: u32,
        #[source]
        source: io::Error,
    },
}

/// Suspend execution of the process identified by `pid`.
pub fn pause(pid: u32) -> Result<(), ProcessControlError> {
    imp::pause(pid)
}

/// Resume execution of a previously-suspended process identified by `pid`.
pub fn resume(pid: u32) -> Result<(), ProcessControlError> {
    imp::resume(pid)
}

#[cfg(unix)]
mod imp {
    use super::ProcessControlError;
    use std::io;

    pub fn pause(pid: u32) -> Result<(), ProcessControlError> {
        signal(pid, libc::SIGSTOP)
    }

    pub fn resume(pid: u32) -> Result<(), ProcessControlError> {
        signal(pid, libc::SIGCONT)
    }

    fn signal(pid: u32, sig: libc::c_int) -> Result<(), ProcessControlError> {
        // SAFETY: `kill` is safe to call with any pid and signal; we check the
        // return value below. No invariants on Rust state.
        let rc = unsafe { libc::kill(pid as libc::pid_t, sig) };
        if rc == 0 {
            return Ok(());
        }
        let err = io::Error::last_os_error();
        match err.raw_os_error() {
            Some(libc::ESRCH) => Err(ProcessControlError::NotFound(pid)),
            Some(libc::EPERM) => Err(ProcessControlError::PermissionDenied(pid)),
            _ => Err(ProcessControlError::Other { pid, source: err }),
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::ProcessControlError;
    use std::io;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, HANDLE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SUSPEND_RESUME};

    // NtSuspendProcess / NtResumeProcess are exported from `ntdll.dll`
    // but not surfaced by the auto-generated `windows-sys` crate (the
    // Microsoft-published win32 metadata excludes them — they're stable
    // but technically undocumented kernel-mode entry points). Declare
    // them manually so this crate doesn't need a heavier dep.
    #[link(name = "ntdll")]
    extern "system" {
        fn NtSuspendProcess(process: HANDLE) -> i32;
        fn NtResumeProcess(process: HANDLE) -> i32;
    }

    pub fn pause(pid: u32) -> Result<(), ProcessControlError> {
        with_handle(pid, |h| {
            // SAFETY: `h` is a non-null process handle opened with
            // PROCESS_SUSPEND_RESUME above. NtSuspendProcess takes ownership
            // of nothing; the handle is closed by `with_handle` after return.
            let status = unsafe { NtSuspendProcess(h) };
            ntstatus_to_result(pid, status)
        })
    }

    pub fn resume(pid: u32) -> Result<(), ProcessControlError> {
        with_handle(pid, |h| {
            // SAFETY: same as `pause`.
            let status = unsafe { NtResumeProcess(h) };
            ntstatus_to_result(pid, status)
        })
    }

    /// RAII wrapper so `CloseHandle` runs even if the closure inside
    /// `with_handle` panics. Without this, an unwind would leak the handle.
    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: the handle was returned by `OpenProcess` and not yet
            // closed. CloseHandle accepts and invalidates it. Failure is
            // non-recoverable and not actionable for the caller.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn with_handle<F>(pid: u32, f: F) -> Result<(), ProcessControlError>
    where
        F: FnOnce(HANDLE) -> Result<(), ProcessControlError>,
    {
        // SAFETY: OpenProcess returns null on failure; we check below.
        let handle = unsafe { OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid) };
        if handle.is_null() {
            let err = io::Error::last_os_error();
            return Err(match err.raw_os_error() {
                Some(code) if code == ERROR_ACCESS_DENIED as i32 => {
                    ProcessControlError::PermissionDenied(pid)
                }
                Some(code) if code == ERROR_INVALID_PARAMETER as i32 => {
                    ProcessControlError::NotFound(pid)
                }
                _ => ProcessControlError::Other { pid, source: err },
            });
        }
        let owned = OwnedHandle(handle);
        f(owned.0)
    }

    fn ntstatus_to_result(pid: u32, status: i32) -> Result<(), ProcessControlError> {
        if status >= 0 {
            // NTSTATUS: non-negative = success / informational.
            Ok(())
        } else {
            Err(ProcessControlError::Other {
                pid,
                source: io::Error::from_raw_os_error(status),
            })
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests_macos {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    fn ps_state(pid: u32) -> Option<String> {
        let out = Command::new("ps")
            .args(["-o", "state=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    #[test]
    fn pause_and_resume_round_trip_on_sleep_child() {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();

        // Give the kernel a moment to register the process.
        std::thread::sleep(Duration::from_millis(50));

        pause(pid).expect("pause");
        std::thread::sleep(Duration::from_millis(50));
        let state = ps_state(pid).unwrap_or_default();
        // macOS `ps` reports "T" when stopped (uppercase) — verify SIGSTOP took.
        assert!(
            state.starts_with('T'),
            "expected stopped state (T*), got {state:?}"
        );

        resume(pid).expect("resume");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn pause_unknown_pid_returns_not_found() {
        // PID 0 is reserved on Unix; PID 999_999_999 is unlikely to exist.
        let err = pause(999_999_999).expect_err("must fail");
        assert!(matches!(err, ProcessControlError::NotFound(_)));
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests_linux {
    use super::*;
    use std::fs;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    fn proc_state(pid: u32) -> Option<char> {
        let raw = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let after_paren = raw.rsplit_once(") ")?.1;
        after_paren.chars().next()
    }

    #[test]
    fn pause_and_resume_round_trip_on_sleep_child() {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();

        std::thread::sleep(Duration::from_millis(50));
        pause(pid).expect("pause");
        std::thread::sleep(Duration::from_millis(50));
        let state = proc_state(pid).unwrap_or('?');
        assert_eq!(state, 'T', "expected stopped state, got {state:?}");

        resume(pid).expect("resume");
        let _ = child.kill();
        let _ = child.wait();
    }
}
