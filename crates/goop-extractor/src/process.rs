//! Ownership of an extractor process group. Persisted process ids are never used.
use goop_core::GoopError;
use tokio::process::{Child, Command};

pub(crate) struct ProcessTree {
    #[cfg(unix)]
    group: i32,
    finished: std::sync::atomic::AtomicBool,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}
impl ProcessTree {
    pub fn configure(command: &mut Command) {
        command.kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(0x00000004); // CREATE_SUSPENDED: own the job before execution.
    }
    pub fn new(child: &Child) -> Result<Self, GoopError> {
        #[cfg(windows)]
        let job = unsafe {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::JobObjects::*;
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let process = child.raw_handle().expect("new child handle") as _;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job, process) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(error.into());
            }
            #[link(name = "ntdll")]
            extern "system" {
                fn NtResumeProcess(process: windows_sys::Win32::Foundation::HANDLE) -> i32;
            }
            if NtResumeProcess(process) < 0 {
                CloseHandle(job);
                return Err(GoopError::Queue(
                    "cannot resume owned extractor process".into(),
                ));
            }
            job
        };
        Ok(Self {
            finished: std::sync::atomic::AtomicBool::new(false),
            #[cfg(windows)]
            job,
            #[cfg(unix)]
            group: child.id().expect("new child has pid") as i32,
        })
    }
    /// Observe exit without reaping the Unix leader. Its unreaped PID pins the
    /// group identity until the final group signal has been sent. Tokio only
    /// reaps this live Child when its wait future is polled (or it is dropped).
    pub async fn wait_leader(&self, child: &mut Child) -> Result<(), GoopError> {
        #[cfg(unix)]
        {
            let _ = child;
            loop {
                match self.leader_exited() {
                    Ok(true) => return Ok(()),
                    Ok(false) => {}
                    Err(error) if error.raw_os_error() == Some(libc::EINTR) => continue,
                    Err(error) => {
                        self.finished
                            .store(true, std::sync::atomic::Ordering::Release);
                        return Err(error.into());
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
        #[cfg(windows)]
        {
            child.wait().await?;
            Ok(())
        }
    }
    #[cfg(unix)]
    fn leader_exited(&self) -> std::io::Result<bool> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: info is writable; WNOWAIT explicitly retains our child.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                self.group as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == -1 {
            return Err(std::io::Error::last_os_error());
        }
        #[cfg(target_os = "macos")]
        let pid = info.si_pid;
        #[cfg(not(target_os = "macos"))]
        let pid = unsafe { info.si_pid() };
        Ok(pid == self.group)
    }
    pub async fn finish(&self, child: &mut Child) -> Result<std::process::ExitStatus, GoopError> {
        #[cfg(unix)]
        {
            // Disarm before reaping: neither Drop nor an error path may signal
            // a numeric group id after the original leader's identity is released.
            if !self
                .finished
                .swap(true, std::sync::atomic::Ordering::AcqRel)
            {
                // SAFETY: no wait future has reaped this guard's Unix leader.
                unsafe {
                    libc::kill(-self.group, libc::SIGKILL);
                }
            }
            let status = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait())
                .await
                .map_err(|_| GoopError::Queue("Extract leader did not stop".into()))??;
            for _ in 0..200 {
                // SAFETY: signal zero only tests whether this owned group exists.
                if unsafe { libc::kill(-self.group, 0) } == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    self.finished
                        .store(true, std::sync::atomic::Ordering::Release);
                    return Ok(status);
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Err(GoopError::Queue(
                "Extract process tree did not stop; recovery files have been retained".into(),
            ))
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::*;
            // SAFETY: this guard owns the job, assigned before the child resumed.
            if unsafe { TerminateJobObject(self.job, 1) } == 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let status = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait())
                .await
                .map_err(|_| {
                    GoopError::Queue(
                        "Extract leader did not stop; recovery files have been retained".into(),
                    )
                })??;
            for _ in 0..200 {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION =
                    unsafe { std::mem::zeroed() };
                let ok = unsafe {
                    QueryInformationJobObject(
                        self.job,
                        JobObjectBasicAccountingInformation,
                        &mut info as *mut _ as _,
                        std::mem::size_of_val(&info) as u32,
                        std::ptr::null_mut(),
                    )
                };
                if ok != 0 && info.ActiveProcesses == 0 {
                    self.finished
                        .store(true, std::sync::atomic::Ordering::Release);
                    return Ok(status);
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Err(GoopError::Queue(
                "Extract process tree did not stop; recovery files have been retained".into(),
            ))
        }
    }
}
impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        // SAFETY: only the process group created by this live guard is signalled.
        if !self.finished.load(std::sync::atomic::Ordering::Acquire) {
            unsafe {
                libc::kill(-self.group, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}
// A job handle may be passed between worker threads; ownership remains exclusive.
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
unsafe impl Sync for ProcessTree {}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::io::Read;
    use std::path::Path;
    use std::time::Duration;

    fn sentinel_command(sentinel: &Path) -> Command {
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(format!(
                "Set-Content -LiteralPath '{}' -Value ready; Start-Sleep -Seconds 60",
                sentinel.display()
            ));
        command.kill_on_drop(true);
        command
    }

    async fn wait_for_sentinel(
        sentinel: &Path,
        child: &mut Child,
        tree: Option<&ProcessTree>,
        stderr: &Path,
        leader_sentinel: Option<&Path>,
    ) -> Result<(), String> {
        let readiness = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if sentinel.exists() {
                    return Ok(());
                }
                match child.try_wait() {
                    Ok(None) => {}
                    status => return Err(format!("child stopped before sentinel: {status:?}")),
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        if matches!(readiness, Ok(Ok(()))) {
            return Ok(());
        }
        let before_cleanup = child.try_wait();
        let cleanup = if let Some(tree) = tree {
            // Includes descendants and has bounded leader/job waits.
            format!("{:?}", tree.finish(child).await)
        } else {
            // The unsuspended control launches no descendants.
            format!(
                "{:?}",
                tokio::time::timeout(Duration::from_secs(2), child.kill()).await
            )
        };
        let stderr_text = std::fs::File::open(stderr).and_then(|file| {
            let mut bytes = Vec::new();
            file.take(64 * 1024).read_to_end(&mut bytes)?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        });
        Err(format!(
            "sentinel readiness: {readiness:?}; child before cleanup: {before_cleanup:?}; \
             leader sentinel: {:?}; cleanup: {cleanup}; stderr: {stderr_text:?}",
            leader_sentinel.map(Path::exists)
        ))
    }

    #[tokio::test]
    async fn windows_powershell_fixture_runs_without_suspension() {
        let dir = tempfile::tempdir().unwrap();
        let sentinel = dir.path().join("sentinel");
        let stderr = dir.path().join("stderr");
        let mut command = sentinel_command(&sentinel);
        command.stderr(std::fs::File::create(&stderr).unwrap());
        let mut child = command.spawn().unwrap();
        wait_for_sentinel(&sentinel, &mut child, None, &stderr, None)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), child.kill())
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn windows_powershell_fixture_failure_reports_exit_and_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let sentinel = dir.path().join("sentinel");
        let stderr = dir.path().join("stderr");
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Error.WriteLine('fixture failure detail'); exit 7",
        ]);
        command.kill_on_drop(true);
        command.stderr(std::fs::File::create(&stderr).unwrap());
        let mut child = command.spawn().unwrap();
        let error = wait_for_sentinel(&sentinel, &mut child, None, &stderr, None)
            .await
            .unwrap_err();
        assert!(error.contains("child stopped before sentinel"), "{error}");
        assert!(error.contains("fixture failure detail"), "{error}");
        assert_eq!(child.try_wait().unwrap().unwrap().code(), Some(7));
    }

    #[tokio::test]
    async fn windows_job_termination_failure_returns_without_waiting_for_leader() {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 60",
        ]);
        command.kill_on_drop(true);
        let mut child = command.spawn().unwrap();
        let tree = ProcessTree {
            job: std::ptr::null_mut(),
            finished: std::sync::atomic::AtomicBool::new(false),
        };
        let outcome =
            tokio::time::timeout(Duration::from_millis(500), tree.finish(&mut child)).await;
        child.kill().await.unwrap();
        assert!(outcome
            .expect("termination API failure must not await the running leader")
            .is_err());
        assert!(!tree.finished.load(std::sync::atomic::Ordering::Acquire));
    }

    #[tokio::test]
    async fn windows_job_object_owns_suspended_child_before_any_write() {
        let dir = tempfile::tempdir().unwrap();
        let sentinel = dir.path().join("sentinel");
        let stderr = dir.path().join("stderr");
        let mut command = sentinel_command(&sentinel);
        command.stderr(std::fs::File::create(&stderr).unwrap());
        ProcessTree::configure(&mut command);
        let mut child = command.spawn().unwrap();
        assert!(
            !sentinel.exists(),
            "CREATE_SUSPENDED prohibits execution before ownership"
        );
        let tree = ProcessTree::new(&child).unwrap();
        wait_for_sentinel(&sentinel, &mut child, Some(&tree), &stderr, None)
            .await
            .unwrap();
        tree.finish(&mut child).await.unwrap();
    }

    #[tokio::test]
    async fn windows_job_object_terminates_descendant_writer() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("writer.ps1");
        let sentinel = dir.path().join("sentinel");
        let leader_sentinel = dir.path().join("leader-sentinel");
        let stderr = dir.path().join("stderr");
        std::fs::write(&script, format!("while ($true) {{ Add-Content -LiteralPath '{}' -Value writing; Start-Sleep -Milliseconds 10 }}", sentinel.display())).unwrap();
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(format!(
                "Set-Content -LiteralPath '{}' -Value ready; & powershell.exe -NoProfile -NonInteractive -File '{}'",
                leader_sentinel.display(),
                script.display()
            ));
        command.stderr(std::fs::File::create(&stderr).unwrap());
        ProcessTree::configure(&mut command);
        let mut child = command.spawn().unwrap();
        let tree = ProcessTree::new(&child).unwrap();
        wait_for_sentinel(
            &sentinel,
            &mut child,
            Some(&tree),
            &stderr,
            Some(&leader_sentinel),
        )
        .await
        .unwrap();
        tree.finish(&mut child).await.unwrap();
        let bytes = std::fs::metadata(&sentinel).unwrap().len();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(std::fs::metadata(sentinel).unwrap().len(), bytes);
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::*;
    #[tokio::test]
    async fn exit_observation_keeps_leader_unreaped_until_signalling_is_disarmed() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exit 7"]);
        ProcessTree::configure(&mut command);
        let mut child = command.spawn().unwrap();
        let tree = ProcessTree::new(&child).unwrap();
        tree.wait_leader(&mut child).await.unwrap();
        assert!(
            tree.leader_exited().unwrap(),
            "WNOWAIT must leave the same child waitable twice"
        );
        assert!(!tree.finished.load(std::sync::atomic::Ordering::Acquire));
        let mut finish = Box::pin(tree.finish(&mut child));
        let result = futures_util::poll!(&mut finish);
        assert!(
            tree.finished.load(std::sync::atomic::Ordering::Acquire),
            "group signalling must be permanently disarmed before the reaping await can suspend"
        );
        let status = match result {
            std::task::Poll::Ready(result) => result.unwrap(),
            std::task::Poll::Pending => finish.await.unwrap(),
        };
        assert_eq!(status.code(), Some(7));
    }
}
