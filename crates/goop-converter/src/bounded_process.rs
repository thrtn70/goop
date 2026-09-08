//! Small subprocess queries with a shared byte ceiling, deadline and reaping.
use goop_core::GoopError;
use std::{
    process::{Output, Stdio},
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

pub(crate) async fn output(
    command: &mut Command,
    binary: &str,
    cancel: &CancellationToken,
) -> Result<Output, GoopError> {
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let query = async {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let (mut ob, mut eb) = ([0u8; 8192], [0u8; 8192]);
        let (mut od, mut ed) = (false, false);
        while !od || !ed {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(GoopError::Cancelled),
                n = stdout.read(&mut ob), if !od => {
                    let n = n?;
                    od = n == 0;
                    check_size(binary, out.len() + err.len(), n)?;
                    out.extend_from_slice(&ob[..n]);
                }
                n = stderr.read(&mut eb), if !ed => {
                    let n = n?;
                    ed = n == 0;
                    check_size(binary, out.len() + err.len(), n)?;
                    err.extend_from_slice(&eb[..n]);
                }
            }
        }
        let status = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(GoopError::Cancelled),
            status = child.wait() => status?,
        };
        Ok(Output {
            status,
            stdout: out,
            stderr: err,
        })
    };
    let result = tokio::time::timeout(Duration::from_secs(5), query)
        .await
        .unwrap_or_else(|_| {
            Err(GoopError::InvalidRequest(format!(
                "{binary} query exceeded its 5 second deadline"
            )))
        });
    if result.is_err() {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    result
}
fn check_size(binary: &str, current: usize, incoming: usize) -> Result<(), GoopError> {
    if current + incoming > 1024 * 1024 {
        return Err(GoopError::InvalidRequest(format!(
            "{binary} query exceeded its 1 MiB output limit"
        )));
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn excessive_output_is_bounded() {
        let result = output(Command::new("sh").args(["-c", "while :; do printf '1234567890123456789012345678901234567890123456789012345678901234567890'; done"]), "fixture", &CancellationToken::new()).await;
        assert!(result.unwrap_err().user_message().contains("1 MiB"));
    }
    #[tokio::test]
    async fn cancellation_and_deadline_reap_child() {
        for cancel_early in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let pid_file = dir.path().join("pid");
            let cancel = CancellationToken::new();
            let trigger = cancel.clone();
            let mut command = Command::new("sh");
            command
                .args(["-c", "echo $$ > \"$1\"; exec sleep 20", "fixture"])
                .arg(&pid_file);
            let trigger_task = async move {
                if cancel_early {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    trigger.cancel();
                }
            };
            let (result, _) = tokio::join!(output(&mut command, "fixture", &cancel), trigger_task);
            let error = result.unwrap_err();
            if cancel_early {
                assert!(matches!(error, GoopError::Cancelled));
            } else {
                assert!(error.user_message().contains("5 second"));
            }
            let pid = std::fs::read_to_string(pid_file).unwrap();
            assert!(!std::process::Command::new("kill")
                .args(["-0", pid.trim()])
                .output()
                .unwrap()
                .status
                .success());
        }
    }
}
