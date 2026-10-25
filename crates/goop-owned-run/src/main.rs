//! Runs one command inside a Windows job that ends with this process, for the
//! performance harnesses. Every process the command starts stays in the job,
//! so ending the job reaps the whole tree without naming a single pid, however
//! the tree was built and whoever has since reused a pid.
//!
//! Usage: `goop-owned-run <command> [args...]`
//!
//! The command gets a null stdin and this process's stdout and stderr. The job
//! ends when the command exits, when this process's stdin reaches end of file
//! (the harness asks for a stop by closing it), or when this process dies.
//! Once the job is empty this process exits with the command's exit code,
//! which is 3 for a command a stop ended.
//! Other platforms stop a process group instead and never run this.

#[cfg(any(windows, test))]
use std::ffi::OsString;

/// The command and its arguments, or `None` when no command was given.
#[cfg(any(windows, test))]
fn split_command(mut args: impl Iterator<Item = OsString>) -> Option<(OsString, Vec<OsString>)> {
    let program = args.next()?;
    Some((program, args.collect()))
}

#[cfg(windows)]
fn main() {
    std::process::exit(owned::run(std::env::args_os().skip(1)));
}

#[cfg(not(windows))]
fn main() {
    eprintln!("goop-owned-run: only Windows runs commands this way");
    std::process::exit(2);
}

#[cfg(windows)]
mod owned {
    use std::ffi::OsString;
    use std::io::{self, Read, Write};
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

    #[link(name = "ntdll")]
    extern "system" {
        fn NtResumeProcess(process: HANDLE) -> i32;
    }

    /// A usage error: nothing was started.
    const USAGE: i32 = 2;
    /// The command could not be run inside the job, or the job did not empty.
    const FAILED: i32 = 1;
    /// The exit code of every process a stop ends, the command's included, so
    /// a stopped run reads differently from a command that failed by itself.
    const STOPPED: u32 = 3;
    /// How long an ended job may take to empty before this run fails.
    const EMPTY_WITHIN: Duration = Duration::from_secs(10);

    /// Report on stderr. A write that fails is ignored, so no report can keep
    /// the launcher from ending what it started.
    fn report(message: std::fmt::Arguments) {
        let _ = writeln!(io::stderr(), "goop-owned-run: {message}");
    }

    /// The job. Its handle is not inheritable, so nothing in the job can hold
    /// the job open, and it is never closed: this process's exit closes it,
    /// which ends whatever is still in it.
    #[derive(Clone, Copy)]
    struct Job(HANDLE);

    // SAFETY: a job handle can be used from any thread, and this one stays
    // open until the process exits (see above), so every copy stays valid.
    unsafe impl Send for Job {}

    impl Job {
        fn new() -> io::Result<Self> {
            // SAFETY: null security attributes and name create an unnamed job
            // whose handle is not inheritable. The limits struct is plain data,
            // valid when zeroed, and is passed with its exact size.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(Self(job))
            }
        }

        /// End every process in the job.
        fn terminate(self) -> io::Result<()> {
            // SAFETY: the job handle is open for this process's lifetime.
            if unsafe { TerminateJobObject(self.0, STOPPED) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        fn active_processes(self) -> io::Result<u32> {
            // SAFETY: the job handle is open for this process's lifetime, and
            // the out-parameter is a zeroed plain-data struct of the given size.
            unsafe {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                if QueryInformationJobObject(
                    self.0,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(info.ActiveProcesses)
            }
        }
    }

    /// End a command that never made it into the job. Waits only when the kill
    /// went through, so a failed kill cannot hang the launcher.
    fn abandon(mut child: Child) {
        if child.kill().is_ok() {
            let _ = child.wait();
        }
    }

    pub fn run(args: impl Iterator<Item = OsString>) -> i32 {
        let Some((program, args)) = super::split_command(args) else {
            report(format_args!("usage: goop-owned-run <command> [args...]"));
            return USAGE;
        };
        let job = match Job::new() {
            Ok(job) => job,
            Err(error) => {
                report(format_args!("cannot create the job: {error}"));
                return FAILED;
            }
        };
        // Suspended, so the command runs no code before it is in the job. A
        // launcher killed before the command joins leaves it suspended: it never
        // runs, but nothing ends it either.
        let mut child = match Command::new(&program)
            .args(&args)
            .stdin(Stdio::null())
            .creation_flags(CREATE_SUSPENDED)
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                report(format_args!(
                    "cannot start {}: {error}",
                    program.to_string_lossy()
                ));
                return FAILED;
            }
        };
        let process = child.as_raw_handle() as HANDLE;
        // SAFETY: `process` is the suspended child's handle, owned by `child`
        // and open until `child` is dropped.
        let refused = if unsafe { AssignProcessToJobObject(job.0, process) } == 0 {
            Some(format!(
                "cannot put it in the job: {}",
                io::Error::last_os_error()
            ))
        } else {
            // SAFETY: as above.
            let status = unsafe { NtResumeProcess(process) };
            (status < 0).then(|| format!("cannot resume it: NTSTATUS {status:#010x}"))
        };
        if let Some(reason) = refused {
            abandon(child);
            report(format_args!("{} {reason}", program.to_string_lossy()));
            return FAILED;
        }
        // The harness holds this stdin open for the whole run and closes it to
        // ask for a stop. A stdin that is null, closed or broken reads as the
        // same request, so a launcher started without one fails safe.
        let watcher = std::thread::Builder::new().spawn(move || {
            let mut stdin = io::stdin();
            let mut buffer = [0u8; 64];
            let unreadable = loop {
                match stdin.read(&mut buffer) {
                    Ok(0) => break None,
                    Ok(_) => {}
                    Err(error) => break Some(error),
                }
            };
            // End the job before reporting anything, so no report can delay it.
            let ended = job.terminate();
            if let Some(error) = unreadable {
                report(format_args!("stopped: cannot read stdin: {error}"));
            }
            if let Err(error) = ended {
                report(format_args!("cannot end the job on request: {error}"));
                // Exiting closes the job, which ends it all the same.
                std::process::exit(FAILED);
            }
        });
        if let Err(error) = watcher {
            let _ = job.terminate();
            report(format_args!("cannot watch for a stop request: {error}"));
            return FAILED;
        }
        let status = child.wait();
        // The command is gone; whatever it left running goes with the job.
        // Ending it again on each poll also catches a process that joined
        // while the job was being ended.
        let deadline = Instant::now() + EMPTY_WITHIN;
        loop {
            match job.active_processes() {
                Ok(0) => break,
                Ok(left) if Instant::now() >= deadline => {
                    report(format_args!("{left} owned processes did not stop"));
                    return FAILED;
                }
                Ok(_) => {
                    if let Err(error) = job.terminate() {
                        report(format_args!("cannot end the job: {error}"));
                        return FAILED;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => {
                    report(format_args!("cannot count the job's processes: {error}"));
                    return FAILED;
                }
            }
        }
        match status {
            Ok(status) => status.code().unwrap_or(FAILED),
            Err(error) => {
                report(format_args!("cannot wait for the command: {error}"));
                FAILED
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::split_command;
    use std::ffi::OsString;

    fn args(values: &[&str]) -> impl Iterator<Item = OsString> {
        values
            .iter()
            .map(OsString::from)
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn no_command_is_a_usage_error() {
        assert_eq!(split_command(args(&[])), None);
    }

    #[test]
    fn the_command_keeps_every_argument_in_order() {
        assert_eq!(
            split_command(args(&["node", "--", "-x", "a b", ""])),
            Some((
                OsString::from("node"),
                ["--", "-x", "a b", ""].map(OsString::from).to_vec()
            ))
        );
        assert_eq!(
            split_command(args(&["node"])),
            Some((OsString::from("node"), Vec::new()))
        );
    }
}
