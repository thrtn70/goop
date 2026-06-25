use goop_core::GoopError;
use std::path::{Path, PathBuf};

pub struct BinaryResolver {
    sidecar_dir: PathBuf,
    /// Writable dir holding goop-native sidecar updates (e.g. a gallery-dl
    /// downloaded from Codeberg). Checked BEFORE `sidecar_dir` so an in-app
    /// update shadows the binary shipped inside the (signed, read-only) app
    /// bundle without having to touch the bundle itself. `None` disables the
    /// override (the historical behaviour).
    update_dir: Option<PathBuf>,
}

pub struct ResolvedBinary {
    pub name: String,
    pub path: PathBuf,
    pub source_is_path: bool,
}

impl BinaryResolver {
    pub fn new(sidecar_dir: PathBuf) -> Self {
        Self {
            sidecar_dir,
            update_dir: None,
        }
    }

    /// Set the writable update dir checked ahead of the bundled sidecar dir.
    /// Builder-style so existing `BinaryResolver::new(..)` call sites (tests,
    /// etc.) keep working unchanged.
    pub fn with_update_dir(mut self, dir: PathBuf) -> Self {
        self.update_dir = Some(dir);
        self
    }

    /// The writable update dir, if configured. Sidecar updaters use this to
    /// decide where to write a freshly downloaded binary.
    pub fn update_dir(&self) -> Option<&Path> {
        self.update_dir.as_deref()
    }

    /// Resolve a sidecar by name. Preference order:
    ///   1. an updated copy in `update_dir` (goop-native self-update),
    ///   2. the bundled copy in `sidecar_dir`,
    ///   3. `$PATH` (dev / Homebrew installs).
    pub fn resolve(&self, name: &str) -> Result<ResolvedBinary, GoopError> {
        let exe = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
        if let Some(dir) = &self.update_dir {
            let updated = dir.join(&exe);
            if updated.is_file() {
                return Ok(ResolvedBinary {
                    name: name.to_string(),
                    path: updated,
                    source_is_path: false,
                });
            }
        }
        let sidecar = self.sidecar_dir.join(&exe);
        if sidecar.is_file() {
            return Ok(ResolvedBinary {
                name: name.to_string(),
                path: sidecar,
                source_is_path: false,
            });
        }
        match which::which(&exe) {
            Ok(path) => Ok(ResolvedBinary {
                name: name.to_string(),
                path,
                source_is_path: true,
            }),
            Err(_) => Err(GoopError::SidecarMissing(name.to_string())),
        }
    }

    pub fn sidecar_dir(&self) -> &Path {
        &self.sidecar_dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Platform-correct sidecar filename (`foo` on unix, `foo.exe` on Windows)
    /// so the tests match what `resolve` looks for.
    fn exe_name(stem: &str) -> String {
        if cfg!(windows) {
            format!("{stem}.exe")
        } else {
            stem.to_string()
        }
    }

    fn touch(dir: &Path, stem: &str) -> PathBuf {
        let p = dir.join(exe_name(stem));
        std::fs::write(&p, b"#!/bin/sh\n").unwrap();
        p
    }

    #[test]
    fn resolves_bundled_sidecar_when_no_update_dir() {
        let bundled = TempDir::new().unwrap();
        let want = touch(bundled.path(), "gallery-dl");
        let r = BinaryResolver::new(bundled.path().to_path_buf());
        let got = r.resolve("gallery-dl").expect("resolves bundled");
        assert_eq!(got.path, want);
        assert!(!got.source_is_path);
    }

    #[test]
    fn update_dir_shadows_bundled() {
        let bundled = TempDir::new().unwrap();
        let updated = TempDir::new().unwrap();
        touch(bundled.path(), "gallery-dl");
        let want = touch(updated.path(), "gallery-dl");
        let r = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updated.path().to_path_buf());
        let got = r.resolve("gallery-dl").expect("resolves updated");
        assert_eq!(got.path, want, "update_dir copy must win over bundled");
    }

    #[test]
    fn falls_back_to_bundled_when_update_dir_lacks_binary() {
        let bundled = TempDir::new().unwrap();
        let updated = TempDir::new().unwrap(); // empty
        let want = touch(bundled.path(), "gallery-dl");
        let r = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updated.path().to_path_buf());
        let got = r.resolve("gallery-dl").expect("resolves bundled");
        assert_eq!(got.path, want);
    }

    #[test]
    fn update_dir_accessor_reflects_builder() {
        let bundled = TempDir::new().unwrap();
        let updated = TempDir::new().unwrap();
        assert!(BinaryResolver::new(bundled.path().to_path_buf())
            .update_dir()
            .is_none());
        let r = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updated.path().to_path_buf());
        assert_eq!(r.update_dir(), Some(updated.path()));
    }

    #[test]
    fn resolves_from_path_when_nothing_bundled_or_updated() {
        // Empty bundled + update dirs → $PATH fallback. `cargo` is always on
        // PATH in CI/dev, mirroring the existing integration test.
        let bundled = TempDir::new().unwrap();
        let updated = TempDir::new().unwrap();
        let r = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updated.path().to_path_buf());
        let got = r.resolve("cargo").expect("cargo on PATH");
        assert!(got.source_is_path);
        assert!(got.path.exists());
    }
}
