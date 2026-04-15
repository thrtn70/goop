use goop_core::GoopError;
use std::path::{Path, PathBuf};

pub struct BinaryResolver {
    sidecar_dir: PathBuf,
}

pub struct ResolvedBinary {
    pub name: String,
    pub path: PathBuf,
    pub source_is_path: bool,
}

impl BinaryResolver {
    pub fn new(sidecar_dir: PathBuf) -> Self {
        Self { sidecar_dir }
    }

    /// Look for the sidecar first, then fall back to $PATH.
    pub fn resolve(&self, name: &str) -> Result<ResolvedBinary, GoopError> {
        let exe = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
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
