use crate::binaries::BinaryResolver;
use goop_core::GoopError;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct UpdateStatus {
    pub attempted: bool,
    pub previous_version: Option<String>,
    pub new_version: Option<String>,
    pub message: String,
}

pub struct UpdateChecker<'a> {
    resolver: &'a BinaryResolver,
}

impl<'a> UpdateChecker<'a> {
    pub fn new(resolver: &'a BinaryResolver) -> Self {
        Self { resolver }
    }

    pub async fn current_version(&self) -> Result<String, GoopError> {
        let bin = self.resolver.resolve("yt-dlp")?;
        let out = Command::new(&bin.path).arg("--version").output().await?;
        if !out.status.success() {
            return Err(GoopError::SubprocessFailed {
                binary: "yt-dlp".into(),
                stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// Run `yt-dlp -U --update-to latest`. If sidecar dir is read-only, returns a warning status
    /// without panicking — caller decides whether to download into $APPDATA instead.
    pub async fn update_in_place(&self) -> Result<UpdateStatus, GoopError> {
        let prev = self.current_version().await.ok();
        let bin = self.resolver.resolve("yt-dlp")?;
        let out = tokio::time::timeout(
            Duration::from_secs(60),
            Command::new(&bin.path)
                .args(["-U", "--update-to", "latest"])
                .output(),
        )
        .await
        .map_err(|_| GoopError::SubprocessFailed {
            binary: "yt-dlp".into(),
            stderr: "update timed out after 60s".into(),
        })??;

        if !out.status.success() {
            return Ok(UpdateStatus {
                attempted: true,
                previous_version: prev,
                new_version: None,
                message: String::from_utf8_lossy(&out.stderr).to_string(),
            });
        }

        let new = self.current_version().await.ok();
        Ok(UpdateStatus {
            attempted: true,
            previous_version: prev,
            new_version: new,
            message: String::from_utf8_lossy(&out.stdout).to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn current_version_errors_when_yt_dlp_missing() {
        let r = BinaryResolver::new(PathBuf::from("/nonexistent"));
        // Skip this test if yt-dlp happens to be on PATH (likely in CI after install).
        if which::which("yt-dlp").is_ok() {
            return;
        }
        let checker = UpdateChecker::new(&r);
        assert!(checker.current_version().await.is_err());
    }
}
