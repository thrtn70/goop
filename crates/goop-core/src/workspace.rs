//! Identity-checked removal of a private output workspace.
use crate::GoopError;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DirectoryIdentity {
    volume: u64,
    object: u128,
}

/// A workspace directory this process created, with the identity it had then.
#[derive(Debug)]
pub struct OwnedWorkspace {
    path: PathBuf,
    identity: DirectoryIdentity,
}

impl OwnedWorkspace {
    /// Returns `None` when the platform cannot report a directory identity,
    /// so the workspace is never eligible for removal.
    pub(crate) fn capture(path: PathBuf) -> Option<Self> {
        let identity = directory_identity(&path).ok()?;
        Some(Self { path, identity })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Remove the workspace only while it is still the same, empty directory.
    /// Links are never followed and contents are never deleted.
    pub fn remove_if_empty(self) -> Result<(), GoopError> {
        if directory_identity(&self.path)? != self.identity {
            return Err(GoopError::InvalidRequest(
                "workspace is no longer the directory that was created".into(),
            ));
        }
        std::fs::remove_dir(&self.path)?;
        Ok(())
    }
}

#[cfg(unix)]
fn directory_identity(path: &Path) -> Result<DirectoryIdentity, GoopError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir() {
        return Err(GoopError::InvalidRequest(
            "workspace is not a directory".into(),
        ));
    }
    Ok(DirectoryIdentity {
        volume: metadata.dev(),
        object: u128::from(metadata.ino()),
    })
}

#[cfg(windows)]
fn directory_identity(path: &Path) -> Result<DirectoryIdentity, GoopError> {
    use std::mem::MaybeUninit;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO,
    };

    // Directories open only with backup semantics; the reparse flag opens a
    // junction or link itself instead of its target.
    let directory = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let handle = directory.as_raw_handle() as HANDLE;
    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    // SAFETY: `directory` owns a valid handle for this call and `information`
    // points to writable storage for the complete result structure.
    if unsafe { GetFileInformationByHandle(handle, information.as_mut_ptr()) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: a successful call initializes the full structure.
    let information = unsafe { information.assume_init() };
    if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(GoopError::InvalidRequest(
            "workspace is not a directory".into(),
        ));
    }
    let mut identity = MaybeUninit::<FILE_ID_INFO>::zeroed();
    // SAFETY: `directory` owns a valid handle for this call and `identity`
    // points to a correctly sized FILE_ID_INFO buffer.
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            identity.as_mut_ptr().cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: a successful call initializes the full structure.
    let identity = unsafe { identity.assume_init() };
    if identity.FileId.Identifier == [0; 16] {
        return Err(GoopError::InvalidRequest(
            "filesystem does not expose a stable directory identity".into(),
        ));
    }
    Ok(DirectoryIdentity {
        volume: identity.VolumeSerialNumber,
        object: u128::from_le_bytes(identity.FileId.Identifier),
    })
}

#[cfg(not(any(unix, windows)))]
fn directory_identity(_path: &Path) -> Result<DirectoryIdentity, GoopError> {
    Err(GoopError::InvalidRequest(
        "directory identity is unsupported on this platform".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn created(parent: &std::path::Path) -> OwnedWorkspace {
        let path = parent.join(".goop-output-test");
        std::fs::create_dir(&path).unwrap();
        OwnedWorkspace::capture(path).unwrap()
    }

    #[test]
    fn unchanged_empty_workspace_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = created(dir.path());
        let path = workspace.path().to_path_buf();

        workspace.remove_if_empty().unwrap();

        assert!(!path.exists());
        assert!(dir.path().is_dir());
    }

    #[test]
    fn non_empty_workspace_is_left_with_its_contents() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = created(dir.path());
        let path = workspace.path().to_path_buf();
        std::fs::write(path.join("partial"), b"bytes").unwrap();

        assert!(workspace.remove_if_empty().is_err());

        assert_eq!(std::fs::read(path.join("partial")).unwrap(), b"bytes");
    }

    #[test]
    fn replaced_workspace_is_left_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = created(dir.path());
        let path = workspace.path().to_path_buf();
        let replacement = dir.path().join("replacement");
        std::fs::create_dir(&replacement).unwrap();
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(&replacement, &path).unwrap();

        assert!(workspace.remove_if_empty().is_err());

        assert!(path.is_dir(), "replacement was removed by name");
    }

    #[cfg(unix)]
    #[test]
    fn linked_workspace_is_left_with_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = created(dir.path());
        let path = workspace.path().to_path_buf();
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::remove_dir(&path).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();

        assert!(workspace.remove_if_empty().is_err());

        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(target.is_dir());
    }

    #[test]
    fn missing_workspace_reports_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = created(dir.path());
        std::fs::remove_dir(workspace.path()).unwrap();

        assert!(workspace.remove_if_empty().is_err());
        assert!(dir.path().is_dir());
    }

    #[test]
    fn identity_is_not_captured_for_a_missing_directory() {
        let dir = tempfile::tempdir().unwrap();

        assert!(OwnedWorkspace::capture(dir.path().join("missing")).is_none());
    }
}
