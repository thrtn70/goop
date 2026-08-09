use crate::binaries::BinaryResolver;
use goop_core::GoopError;
use serde::{Deserialize, Serialize};
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

/// Version reader for a sidecar binary. Different sidecars expose their
/// version under different flags (`yt-dlp --version`, `mutool -v`, `gs
/// --version`) and write it to different streams, so the flag list is
/// per-binary and `current_version` normalises whatever comes back.
///
/// Nothing here updates anything. Every sidecar that *can* be updated is
/// updated by downloading a fresh binary into the resolver's writable update
/// dir (`yt_dlp_update`, `gallery_dl_update`), never by running the tool's own
/// `-U` / `--update` against the copy inside the app bundle — that would
/// rewrite a signed bundle in place. The rest (gs, mutool, tesseract) ship
/// with Goop and change when Goop does.
pub struct UpdateChecker<'a> {
    resolver: &'a BinaryResolver,
    binary_name: &'static str,
    version_args: &'static [&'static str],
}

impl<'a> UpdateChecker<'a> {
    /// Version-only checker for yt-dlp. Updates go through the goop-native
    /// `yt_dlp_update` module, which downloads the latest GitHub release into
    /// the resolver's writable update dir. yt-dlp's own `-U` is deliberately
    /// never invoked: it rewrites the running binary in place, which inside a
    /// signed bundle means mutating the shipped app.
    pub fn for_yt_dlp(resolver: &'a BinaryResolver) -> Self {
        Self {
            resolver,
            binary_name: "yt-dlp",
            version_args: &["--version"],
        }
    }

    /// Version-only checker for gallery-dl (used by Settings → About and by
    /// the updater to read the current version). gallery-dl's own `--update`
    /// is unusable for us — it targets GitHub, which no longer hosts the
    /// release binaries (they moved to Codeberg), and there's no macOS build —
    /// so updates go through the goop-native `gallery_dl_update` module
    /// instead, which downloads from Codeberg on Windows/Linux and is a
    /// ship-with-Goop no-op on macOS.
    pub fn for_gallery_dl(resolver: &'a BinaryResolver) -> Self {
        Self {
            resolver,
            binary_name: "gallery-dl",
            version_args: &["--version"],
        }
    }

    /// Version-only checker for Ghostscript. No self-update — gs is
    /// bundled at build time, users upgrade the app to upgrade gs.
    pub fn for_ghostscript(resolver: &'a BinaryResolver) -> Self {
        Self {
            resolver,
            binary_name: "gs",
            version_args: &["--version"],
        }
    }

    /// Version-only checker for mutool. mutool uses `-v` (its
    /// `--version` flag prints help-and-exit-1 instead). No
    /// self-update — bundled, like gs.
    pub fn for_mutool(resolver: &'a BinaryResolver) -> Self {
        Self {
            resolver,
            binary_name: "mutool",
            version_args: &["-v"],
        }
    }

    /// Version-only checker for tesseract. The CLI accepts `--version`
    /// and writes the version banner to stderr (similar to mutool).
    /// Bundled per-platform via fetch-sidecars.sh — no self-update.
    pub fn for_tesseract(resolver: &'a BinaryResolver) -> Self {
        Self {
            resolver,
            binary_name: "tesseract",
            version_args: &["--version"],
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
        let out = Command::new(&bin.path)
            .args(self.version_args)
            .output()
            .await?;
        if !out.status.success() {
            return Err(GoopError::SubprocessFailed {
                binary: self.binary_name.into(),
                stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            });
        }
        // mutool -v writes its version to stderr (with stdout empty);
        // yt-dlp / gallery-dl / gs write to stdout. Fall back to stderr
        // when stdout is empty so the same code path handles both.
        let raw = {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let trimmed = stdout.trim();
            if trimmed.is_empty() {
                String::from_utf8_lossy(&out.stderr).trim().to_string()
            } else {
                trimmed.to_string()
            }
        };
        Ok(normalize_version(self.binary_name, raw))
    }
}

/// Strip per-binary preamble from the `--version` / `-v` stdout so
/// Settings → Sidecars displays a clean semver. mutool prints
/// "mutool version 1.27.2" rather than just the version; gs prints
/// "GPL Ghostscript 10.04.0 (...)" on the first line; tesseract prints
/// "tesseract 5.5.0" on the first line followed by leptonica + image
/// library banners. Other binaries already print a bare semver and are
/// passed through unchanged.
fn normalize_version(binary_name: &str, raw: String) -> String {
    match binary_name {
        "mutool" => raw
            .strip_prefix("mutool version ")
            .map(str::to_string)
            .unwrap_or(raw),
        "gs" => raw
            .lines()
            .next()
            .map(|first| {
                first
                    .strip_prefix("GPL Ghostscript ")
                    .and_then(|s| s.split_whitespace().next())
                    .map(str::to_string)
                    .unwrap_or_else(|| first.to_string())
            })
            .unwrap_or(raw),
        "tesseract" => raw
            .lines()
            .next()
            .map(|first| {
                first
                    .strip_prefix("tesseract ")
                    .map(str::to_string)
                    .unwrap_or_else(|| first.to_string())
            })
            .unwrap_or(raw),
        _ => raw,
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
        assert_eq!(c.version_args, &["--version"]);
    }

    #[test]
    fn gallery_dl_constructor_uses_correct_binary_and_args() {
        let r = BinaryResolver::new(PathBuf::from("/nonexistent"));
        let c = UpdateChecker::for_gallery_dl(&r);
        assert_eq!(c.binary_name, "gallery-dl");
        assert_eq!(c.version_args, &["--version"]);
    }

    #[test]
    fn mutool_constructor_uses_v_flag_and_has_no_self_update() {
        let r = BinaryResolver::new(PathBuf::from("/nonexistent"));
        let c = UpdateChecker::for_mutool(&r);
        assert_eq!(c.binary_name, "mutool");
        assert_eq!(c.version_args, &["-v"]);
    }

    #[test]
    fn ghostscript_constructor_uses_version_flag_and_has_no_self_update() {
        let r = BinaryResolver::new(PathBuf::from("/nonexistent"));
        let c = UpdateChecker::for_ghostscript(&r);
        assert_eq!(c.binary_name, "gs");
        assert_eq!(c.version_args, &["--version"]);
    }

    #[test]
    fn tesseract_constructor_uses_version_flag_and_has_no_self_update() {
        let r = BinaryResolver::new(PathBuf::from("/nonexistent"));
        let c = UpdateChecker::for_tesseract(&r);
        assert_eq!(c.binary_name, "tesseract");
        assert_eq!(c.version_args, &["--version"]);
    }

    #[test]
    fn normalize_version_strips_mutool_preamble() {
        assert_eq!(
            normalize_version("mutool", "mutool version 1.27.2".into()),
            "1.27.2"
        );
    }

    #[test]
    fn normalize_version_strips_ghostscript_preamble() {
        assert_eq!(
            normalize_version("gs", "GPL Ghostscript 10.04.0 (2024-09-18)".into()),
            "10.04.0"
        );
    }

    #[test]
    fn normalize_version_passes_other_binaries_through_unchanged() {
        assert_eq!(
            normalize_version("yt-dlp", "2024.11.18".into()),
            "2024.11.18"
        );
        assert_eq!(normalize_version("gallery-dl", "1.32.0".into()), "1.32.0");
    }

    #[test]
    fn normalize_version_strips_tesseract_preamble() {
        // tesseract --version writes "tesseract 5.5.0\n leptonica-1.85.0\n ..."
        // to stderr. Only keep the first-line version after the prefix.
        let raw = "tesseract 5.5.0\n leptonica-1.85.0\n  libgif 5.2.1 : libjpeg 8d : libpng 1.6.40";
        assert_eq!(normalize_version("tesseract", raw.into()), "5.5.0");
    }

    #[test]
    fn normalize_version_preserves_tesseract_dev_suffix() {
        // Some upstream/distro builds emit "tesseract 5.5.0-dev" or
        // "tesseract 5.4.1-20231212". Strip the prefix, keep the rest
        // intact for display.
        assert_eq!(
            normalize_version("tesseract", "tesseract 5.5.0-dev\n leptonica-1.85.0".into()),
            "5.5.0-dev"
        );
        assert_eq!(
            normalize_version("tesseract", "tesseract 5.4.1-20231212".into()),
            "5.4.1-20231212"
        );
    }
}
