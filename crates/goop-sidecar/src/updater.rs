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

/// In-place updater for a self-updating sidecar binary. Both yt-dlp and
/// gallery-dl support this pattern: a CLI flag instructs the binary to
/// fetch its own latest release and overwrite itself in place. The
/// concrete subcommand differs (`yt-dlp -U --update-to latest` vs
/// `gallery-dl --update`), so the struct stores the per-binary command
/// alongside the binary name.
pub struct UpdateChecker<'a> {
    resolver: &'a BinaryResolver,
    binary_name: &'static str,
    update_args: &'static [&'static str],
}

impl<'a> UpdateChecker<'a> {
    /// Updater configured for yt-dlp.
    pub fn for_yt_dlp(resolver: &'a BinaryResolver) -> Self {
        Self {
            resolver,
            binary_name: "yt-dlp",
            update_args: &["-U", "--update-to", "latest"],
        }
    }

    /// Updater configured for gallery-dl. The PyInstaller bundle
    /// supports `--update` to self-fetch the latest stable release.
    pub fn for_gallery_dl(resolver: &'a BinaryResolver) -> Self {
        Self {
            resolver,
            binary_name: "gallery-dl",
            update_args: &["--update"],
        }
    }

    /// Backward-compatible constructor that defaults to yt-dlp. Kept
    /// so existing call sites compile without modification while we
    /// migrate them in stages.
    pub fn new(resolver: &'a BinaryResolver) -> Self {
        Self::for_yt_dlp(resolver)
    }

    pub async fn current_version(&self) -> Result<String, GoopError> {
        let bin = self.resolver.resolve(self.binary_name)?;
        let out = Command::new(&bin.path).arg("--version").output().await?;
        if !out.status.success() {
            return Err(GoopError::SubprocessFailed {
                binary: self.binary_name.into(),
                stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// Run the configured `--update`-style command on the binary. If
    /// the sidecar dir is read-only (signed app, App Store install),
    /// returns a warning status without panicking — caller decides
    /// whether to download into `$APPDATA` instead.
    pub async fn update_in_place(&self) -> Result<UpdateStatus, GoopError> {
        let prev = self.current_version().await.ok();
        let bin = self.resolver.resolve(self.binary_name)?;
        let out = tokio::time::timeout(
            Duration::from_secs(60),
            Command::new(&bin.path).args(self.update_args).output(),
        )
        .await
        .map_err(|_| GoopError::SubprocessFailed {
            binary: self.binary_name.into(),
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
        let checker = UpdateChecker::for_yt_dlp(&r);
        assert!(checker.current_version().await.is_err());
    }

    #[tokio::test]
    async fn current_version_errors_when_gallery_dl_missing() {
        let r = BinaryResolver::new(PathBuf::from("/nonexistent"));
        if which::which("gallery-dl").is_ok() {
            return;
        }
        let checker = UpdateChecker::for_gallery_dl(&r);
        assert!(checker.current_version().await.is_err());
    }

    #[test]
    fn yt_dlp_constructor_uses_correct_binary_and_args() {
        let r = BinaryResolver::new(PathBuf::from("/nonexistent"));
        let c = UpdateChecker::for_yt_dlp(&r);
        assert_eq!(c.binary_name, "yt-dlp");
        assert_eq!(c.update_args, &["-U", "--update-to", "latest"]);
    }

    #[test]
    fn gallery_dl_constructor_uses_correct_binary_and_args() {
        let r = BinaryResolver::new(PathBuf::from("/nonexistent"));
        let c = UpdateChecker::for_gallery_dl(&r);
        assert_eq!(c.binary_name, "gallery-dl");
        assert_eq!(c.update_args, &["--update"]);
    }
}
