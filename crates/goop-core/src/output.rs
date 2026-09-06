//! Private staging and no-replace publication for completed outputs.
use crate::{GoopError, ResultKind};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub struct OutputDestination {
    pub path: PathBuf,
    pub automatic_name: Option<(String, String)>,
}
impl OutputDestination {
    pub fn explicit(path: PathBuf) -> Self {
        Self {
            path,
            automatic_name: None,
        }
    }
    pub fn automatic(path: PathBuf, stem: String, extension: String) -> Self {
        Self {
            path,
            automatic_name: Some((stem, extension)),
        }
    }
}
#[derive(Debug)]
pub struct PublishedOutput {
    pub path: PathBuf,
    pub bytes: u64,
    pub file_count: u32,
    pub result_kind: ResultKind,
}

pub struct StagedOutput {
    directory: PathBuf,
    path: PathBuf,
}
impl StagedOutput {
    pub fn new(destination: &Path) -> Result<Self, GoopError> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let filename = destination
            .file_name()
            .ok_or_else(|| GoopError::InvalidRequest("output must have a filename".into()))?;
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        std::fs::create_dir_all(parent)?;
        for _ in 0..100 {
            let directory = parent.join(format!(
                ".goop-output-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&directory) {
                Ok(()) => {
                    return Ok(Self {
                        path: directory.join(filename),
                        directory,
                    })
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
        Err(GoopError::InvalidRequest(
            "cannot allocate private output workspace".into(),
        ))
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn validate(
        &self,
        target: Option<u64>,
        allow_empty: bool,
    ) -> Result<PublishedOutput, GoopError> {
        let metadata = std::fs::symlink_metadata(&self.path)?;
        let (bytes, file_count, result_kind) = if metadata.is_file() {
            if metadata.len() == 0 && !allow_empty {
                return Err(GoopError::InvalidRequest(
                    "tool produced an empty output".into(),
                ));
            }
            (metadata.len(), 1, ResultKind::File)
        } else if metadata.is_dir() {
            let (bytes, files) = inspect_directory(&self.path)?;
            if files == 0 {
                return Err(GoopError::InvalidRequest(
                    "tool produced no output files".into(),
                ));
            }
            (bytes, files, ResultKind::Folder)
        } else {
            return Err(GoopError::InvalidRequest(
                "output must be a regular file or directory, not a link or special file".into(),
            ));
        };
        if let Some(target) = target {
            if bytes > target {
                return Err(GoopError::InvalidRequest(format!("Target size was {target} bytes, but the output was {bytes} bytes. No output was saved. Increase the target or choose another format.")));
            }
        }
        Ok(PublishedOutput {
            path: self.path.clone(),
            bytes,
            file_count,
            result_kind,
        })
    }
    pub fn validate_manifest(&self, files: &[PathBuf]) -> Result<(), GoopError> {
        let mut seen = std::collections::HashSet::new();
        for file in files {
            if !file.starts_with(&self.path)
                || file
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
                || !seen.insert(file.clone())
            {
                return Err(GoopError::InvalidRequest(
                    "invalid or duplicate output manifest entry".into(),
                ));
            }
            let meta = std::fs::symlink_metadata(file)?;
            if !meta.is_file() || meta.len() == 0 {
                return Err(GoopError::InvalidRequest(
                    "missing, empty or nonregular output artifact".into(),
                ));
            }
        }
        let output = self.validate(None, false)?;
        if output.file_count as usize != files.len() {
            return Err(GoopError::InvalidRequest(
                "output manifest does not match produced files".into(),
            ));
        }
        Ok(())
    }
    pub fn publish(
        self,
        destination: &OutputDestination,
        target: Option<u64>,
        allow_empty: bool,
        cancel: &CancellationToken,
    ) -> Result<PublishedOutput, GoopError> {
        let mut result = self.validate(target, allow_empty)?;
        let mut path = destination.path.clone();
        for suffix in 1..=10_000 {
            if cancel.is_cancelled() {
                return Err(GoopError::Cancelled);
            }
            match publish_no_replace(&self.path, &path) {
                Ok(()) => {
                    result.path = path;
                    return Ok(result);
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::AlreadyExists
                        && destination.automatic_name.is_some() =>
                {
                    let (stem, ext) = destination.automatic_name.as_ref().unwrap();
                    let name = if ext.is_empty() {
                        format!("{stem} ({suffix})")
                    } else {
                        format!("{stem} ({suffix}).{ext}")
                    };
                    path = destination.path.with_file_name(name);
                }
                Err(e) => {
                    return Err(GoopError::InvalidRequest(format!(
                        "cannot publish output without replacing an existing file: {e}"
                    )))
                }
            }
        }
        Err(GoopError::InvalidRequest(
            "cannot allocate an unused output name after 10000 publication attempts".into(),
        ))
    }
}
impl Drop for StagedOutput {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
fn inspect_directory(path: &Path) -> Result<(u64, u32), GoopError> {
    let mut bytes = 0u64;
    let mut count = 0u32;
    for entry in std::fs::read_dir(path)? {
        let path = entry?.path();
        let meta = std::fs::symlink_metadata(&path)?;
        let (size, files) = if meta.is_dir() {
            inspect_directory(&path)?
        } else if meta.is_file() && meta.len() > 0 {
            (meta.len(), 1)
        } else {
            return Err(GoopError::InvalidRequest(
                "output folder contains empty, linked or nonregular artifacts".into(),
            ));
        };
        bytes = bytes
            .checked_add(size)
            .ok_or_else(|| GoopError::InvalidRequest("output size overflow".into()))?;
        count = count
            .checked_add(files)
            .ok_or_else(|| GoopError::InvalidRequest("output count overflow".into()))?;
    }
    Ok((bytes, count))
}
/// Measure each distinct source once, without silently ignoring stat failures.
pub fn source_bytes(paths: &[PathBuf]) -> Result<u64, GoopError> {
    let mut seen = std::collections::HashSet::new();
    let mut bytes = 0u64;
    for path in paths {
        let canonical = std::fs::canonicalize(path)?;
        if seen.insert(canonical.clone()) {
            let meta = std::fs::metadata(canonical)?;
            if !meta.is_file() {
                return Err(GoopError::InvalidRequest(
                    "source must be a regular file".into(),
                ));
            }
            bytes = bytes
                .checked_add(meta.len())
                .ok_or_else(|| GoopError::InvalidRequest("source size overflow".into()))?;
        }
    }
    Ok(bytes)
}

/// Move completed staging without replacing any destination entry. Native
/// no-replace moves work on removable filesystems that do not support hard links.
#[cfg(target_os = "macos")]
pub fn publish_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    // SAFETY: both pointers are valid NUL-terminated path buffers for this call.
    // RENAME_EXCL fails if any destination directory entry already exists.
    if unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "windows")]
pub fn publish_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    fn wide_path(path: &Path) -> std::io::Result<Vec<u16>> {
        let mut wide: Vec<_> = path.as_os_str().encode_wide().collect();
        if wide.contains(&0) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path contains NUL",
            ));
        }
        wide.push(0);
        Ok(wide)
    }
    let source = wide_path(source)?;
    let destination = wide_path(destination)?;
    // SAFETY: both paths are valid NUL-terminated UTF-16 buffers. Zero flags
    // prohibit both replacement and a non-atomic cross-volume copy fallback.
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
pub fn publish_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    // SAFETY: both C strings remain valid for the call. RENAME_NOREPLACE
    // atomically refuses an existing entry for files and directories alike.
    if unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn publish_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::hard_link(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    #[test]
    fn folder_publication_is_complete_and_automatically_renamed() {
        let dir = tempfile::tempdir().unwrap();
        let destination =
            OutputDestination::automatic(dir.path().join("result"), "result".into(), String::new());
        std::fs::create_dir(&destination.path).unwrap();
        std::fs::write(destination.path.join("original"), b"original").unwrap();
        let staged = StagedOutput::new(&destination.path).unwrap();
        std::fs::create_dir(staged.path()).unwrap();
        let one = staged.path().join("one.png");
        let two = staged.path().join("two.png");
        std::fs::write(&one, b"one").unwrap();
        std::fs::write(&two, b"two").unwrap();
        assert!(staged
            .validate_manifest(std::slice::from_ref(&one))
            .is_err());
        staged.validate_manifest(&[one, two]).unwrap();
        let result = staged
            .publish(&destination, None, false, &CancellationToken::new())
            .unwrap();
        assert_eq!(result.file_count, 2);
        assert_eq!(result.bytes, 6);
        assert_eq!(result.path, dir.path().join("result (1)"));
        assert_eq!(
            std::fs::read(destination.path.join("original")).unwrap(),
            b"original"
        );
    }
    #[test]
    fn repeated_sources_are_counted_once() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        std::fs::write(&source, b"12345").unwrap();
        assert_eq!(source_bytes(&[source.clone(), source]).unwrap(), 5);
    }

    #[test]
    fn failed_target_withholds_output_and_cleans_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.mp4");
        {
            let staged = StagedOutput::new(&dest).unwrap();
            std::fs::write(staged.path(), vec![0; 456_471]).unwrap();
            let err = staged
                .publish(
                    &OutputDestination::explicit(dest.clone()),
                    Some(104_858),
                    false,
                    &CancellationToken::new(),
                )
                .unwrap_err();
            assert!(err.to_string().contains("104858"));
            assert!(err.to_string().contains("456471"));
        }
        assert!(!dest.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn collision_preserves_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.png");
        std::fs::write(&dest, b"original").unwrap();
        let staged = StagedOutput::new(&dest).unwrap();
        assert_eq!(staged.path().extension(), dest.extension());
        std::fs::write(staged.path(), b"new").unwrap();
        assert!(staged
            .publish(
                &OutputDestination::explicit(dest.clone()),
                None,
                false,
                &CancellationToken::new()
            )
            .is_err());
        assert_eq!(std::fs::read(dest).unwrap(), b"original");
    }

    #[test]
    fn cancelled_output_never_publishes() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.txt");
        let staged = StagedOutput::new(&dest).unwrap();
        std::fs::write(staged.path(), b"new").unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            staged.publish(
                &OutputDestination::explicit(dest.clone()),
                None,
                false,
                &cancel
            ),
            Err(GoopError::Cancelled)
        ));
        assert!(!dest.exists());
    }

    #[test]
    fn empty_media_rejected_but_empty_text_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.txt");
        let staged = StagedOutput::new(&dest).unwrap();
        std::fs::write(staged.path(), []).unwrap();
        assert!(staged.validate(None, false).is_err());
        assert_eq!(
            staged
                .publish(
                    &OutputDestination::explicit(dest),
                    None,
                    true,
                    &CancellationToken::new()
                )
                .unwrap()
                .bytes,
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_output_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.txt");
        let staged = StagedOutput::new(&dest).unwrap();
        std::os::unix::fs::symlink("/etc/hosts", staged.path()).unwrap();
        assert!(staged.validate(None, false).is_err());
    }
}
