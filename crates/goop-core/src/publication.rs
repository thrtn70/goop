use crate::{GoopError, JobResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;

pub trait PublicationObserver: Send + Sync {
    fn before_publish(
        &self,
        staged: &Path,
        destination: &Path,
        result: &JobResult,
    ) -> Result<(), GoopError>;

    fn published(&self, destination: &Path, result: &JobResult) -> Result<(), GoopError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "schema", rename_all = "snake_case")]
pub enum FileIdentity {
    MacosV1 {
        device: u64,
        inode: u64,
        birth_seconds: i64,
        birth_nanoseconds: i64,
        size: u64,
        modified_seconds: i64,
        modified_nanoseconds: i64,
        sha256: [u8; 32],
    },
    WindowsV1 {
        volume_serial: u64,
        file_id: [u8; 16],
        creation_time: u64,
        size: u64,
        last_write_time: u64,
        sha256: [u8; 32],
    },
}

impl FileIdentity {
    /// Capture a regular, singly-linked file through a no-follow handle.
    ///
    /// The native object identity proves that a rename retained the same file.
    /// Stable metadata and the digest additionally reject in-place changes and
    /// conservative inode/file-id reuse cases during later reconciliation.
    pub fn capture(path: &Path) -> Result<Self, GoopError> {
        capture(path)
    }

    pub fn verify(&self, path: &Path) -> Result<(), GoopError> {
        let current = Self::capture(path)?;
        if &current == self {
            Ok(())
        } else {
            Err(GoopError::InvalidRequest(
                "published output identity no longer matches the prepared file".into(),
            ))
        }
    }
}

fn digest(mut file: &File) -> Result<[u8; 32], GoopError> {
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

#[cfg(target_os = "macos")]
fn capture(path: &Path) -> Result<FileIdentity, GoopError> {
    use std::os::darwin::fs::MetadataExt as DarwinMetadataExt;
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    let path_c = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        GoopError::InvalidRequest("publication path contains an embedded NUL".into())
    })?;
    // SAFETY: path is a valid NUL-terminated buffer and the returned descriptor
    // is immediately transferred to File for exactly-once close.
    let descriptor = unsafe {
        libc::open(
            path_c.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: `descriptor` is newly owned by this function.
    let file = unsafe { File::from_raw_fd(descriptor) };
    let before = file.metadata()?;
    validate_macos_metadata(&before)?;
    let sha256 = digest(&file)?;
    let after = file.metadata()?;
    validate_macos_metadata(&after)?;
    if stable_macos_metadata(&before) != stable_macos_metadata(&after) {
        return Err(GoopError::InvalidRequest(
            "output changed while its publication identity was being captured".into(),
        ));
    }
    let path_metadata = std::fs::symlink_metadata(path)?;
    validate_macos_metadata(&path_metadata)?;
    if stable_macos_metadata(&before) != stable_macos_metadata(&path_metadata) {
        return Err(GoopError::InvalidRequest(
            "output path changed while its publication identity was being captured".into(),
        ));
    }
    Ok(FileIdentity::MacosV1 {
        device: before.dev(),
        inode: before.ino(),
        birth_seconds: before.st_birthtime(),
        birth_nanoseconds: before.st_birthtime_nsec(),
        size: before.size(),
        modified_seconds: before.mtime(),
        modified_nanoseconds: before.mtime_nsec(),
        sha256,
    })
}

#[cfg(target_os = "macos")]
fn validate_macos_metadata(metadata: &std::fs::Metadata) -> Result<(), GoopError> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.file_type().is_block_device()
        || metadata.file_type().is_char_device()
        || metadata.file_type().is_fifo()
        || metadata.file_type().is_socket()
        || metadata.nlink() != 1
    {
        return Err(GoopError::InvalidRequest(
            "publication identity requires a regular file with exactly one link".into(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn stable_macos_metadata(metadata: &std::fs::Metadata) -> (u64, u64, i64, i64, u64, i64, i64) {
    use std::os::darwin::fs::MetadataExt as DarwinMetadataExt;
    use std::os::unix::fs::MetadataExt;
    (
        metadata.dev(),
        metadata.ino(),
        metadata.st_birthtime(),
        metadata.st_birthtime_nsec(),
        metadata.size(),
        metadata.mtime(),
        metadata.mtime_nsec(),
    )
}

#[cfg(target_os = "windows")]
fn capture(path: &Path) -> Result<FileIdentity, GoopError> {
    let file = open_windows_no_follow(path)?;
    let stable_before = stable_windows_file(&file)?;
    let sha256 = digest(&file)?;
    let stable_after = stable_windows_file(&file)?;
    if stable_before != stable_after {
        return Err(GoopError::InvalidRequest(
            "output changed while its publication identity was being captured".into(),
        ));
    }
    let path_file = open_windows_no_follow(path)?;
    if stable_before != stable_windows_file(&path_file)? {
        return Err(GoopError::InvalidRequest(
            "output path changed while its publication identity was being captured".into(),
        ));
    }
    let (volume_serial, file_id, creation_time, size, last_write_time) = stable_before;
    Ok(FileIdentity::WindowsV1 {
        volume_serial,
        file_id,
        creation_time,
        size,
        last_write_time,
        sha256,
    })
}

#[cfg(target_os = "windows")]
fn open_windows_no_follow(path: &Path) -> Result<File, GoopError> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    Ok(std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?)
}

#[cfg(target_os = "windows")]
fn stable_windows_file(file: &File) -> Result<(u64, [u8; 16], u64, u64, u64), GoopError> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_ID_INFO,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    // SAFETY: the File owns a valid handle for this call and `information`
    // points to writable storage for the complete result structure.
    if unsafe {
        GetFileInformationByHandle(file.as_raw_handle() as HANDLE, information.as_mut_ptr())
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: a successful call initializes the full structure.
    let information = unsafe { information.assume_init() };
    if information.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0
        || information.nNumberOfLinks != 1
    {
        return Err(GoopError::InvalidRequest(
            "publication identity requires a regular file with exactly one link".into(),
        ));
    }
    let mut identity = MaybeUninit::<FILE_ID_INFO>::zeroed();
    // SAFETY: the File owns a valid handle for this call and `identity` points
    // to a correctly sized FILE_ID_INFO buffer.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
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
            "filesystem does not expose a stable file identity".into(),
        ));
    }
    let creation_time = (u64::from(information.ftCreationTime.dwHighDateTime) << 32)
        | u64::from(information.ftCreationTime.dwLowDateTime);
    let size = (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow);
    let last_write_time = (u64::from(information.ftLastWriteTime.dwHighDateTime) << 32)
        | u64::from(information.ftLastWriteTime.dwLowDateTime);
    Ok((
        identity.VolumeSerialNumber,
        identity.FileId.Identifier,
        creation_time,
        size,
        last_write_time,
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn capture(_path: &Path) -> Result<FileIdentity, GoopError> {
    Err(GoopError::InvalidRequest(
        "publication identity is unsupported on this platform".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn identity_verifies_the_same_file_after_a_rename() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("staged");
        let published = dir.path().join("published");
        std::fs::write(&staged, b"published bytes").unwrap();

        let identity = FileIdentity::capture(&staged).unwrap();
        let serialized = serde_json::to_string(&identity).unwrap();
        assert_eq!(
            serde_json::from_str::<FileIdentity>(&serialized).unwrap(),
            identity
        );
        std::fs::rename(&staged, &published).unwrap();

        identity.verify(&published).unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn identity_rejects_in_place_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("output");
        std::fs::write(&path, b"first bytes").unwrap();
        let identity = FileIdentity::capture(&path).unwrap();

        std::fs::write(&path, b"other bytes").unwrap();

        assert!(identity.verify(&path).is_err());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn identity_rejects_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("output");
        let replacement = dir.path().join("replacement");
        std::fs::write(&path, b"same bytes").unwrap();
        std::fs::write(&replacement, b"same bytes").unwrap();
        let identity = FileIdentity::capture(&path).unwrap();

        std::fs::remove_file(&path).unwrap();
        std::fs::rename(&replacement, &path).unwrap();

        assert!(identity.verify(&path).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn identity_rejects_symlinks_and_hardlinks() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let symlink = dir.path().join("symlink");
        let hardlink = dir.path().join("hardlink");
        std::fs::write(&source, b"bytes").unwrap();
        std::os::unix::fs::symlink(&source, &symlink).unwrap();
        assert!(FileIdentity::capture(&symlink).is_err());

        std::fs::hard_link(&source, &hardlink).unwrap();
        assert!(FileIdentity::capture(&source).is_err());
    }
}
