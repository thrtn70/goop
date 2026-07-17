use crate::error::GoopError;
use fs4::FileExt;
use std::fs::OpenOptions;
use std::path::Path;

/// Holds an exclusive advisory lock on `<data_dir>/queue.lock` for its entire
/// lifetime. Only the process holding this guard owns the queue and may run
/// boot reconciliation or start worker loops. The OS releases the lock when the
/// process exits (or the guard is dropped), so a crash needs no manual cleanup.
pub struct InstanceGuard {
    _file: std::fs::File,
}

impl InstanceGuard {
    /// Try to become the sole owner of `data_dir`.
    ///
    /// - `Ok(Some(guard))` — this process now owns the queue.
    /// - `Ok(None)` — another live instance already holds the lock.
    /// - `Err(_)` — the lock file could not be opened; callers treat this as
    ///   "not the owner" and refuse to reconcile.
    pub fn try_acquire(data_dir: &Path) -> Result<Option<Self>, GoopError> {
        std::fs::create_dir_all(data_dir)?;
        let path = data_dir.join("queue.lock");
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)?;
        // Fully-qualified call: `std::fs::File` gained its own inherent
        // `try_lock` (stable since Rust 1.89), which shadows the `FileExt`
        // trait method under dot-call syntax. UFCS forces resolution to
        // `fs4::FileExt::try_lock`, whose `Result` uses `fs4::TryLockError`.
        match FileExt::try_lock(&file) {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(fs4::TryLockError::WouldBlock) => Ok(None),
            Err(fs4::TryLockError::Error(e)) => Err(GoopError::Io(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn first_acquire_succeeds() {
        let dir = tempdir().unwrap();
        let guard = InstanceGuard::try_acquire(dir.path()).unwrap();
        assert!(guard.is_some());
    }

    #[test]
    fn second_acquire_while_held_returns_none() {
        let dir = tempdir().unwrap();
        let _held = InstanceGuard::try_acquire(dir.path()).unwrap().unwrap();
        let second = InstanceGuard::try_acquire(dir.path()).unwrap();
        assert!(second.is_none());
    }

    #[test]
    fn reacquire_after_drop_succeeds() {
        let dir = tempdir().unwrap();
        {
            let _held = InstanceGuard::try_acquire(dir.path()).unwrap().unwrap();
        } // lock released when the guard drops
        let again = InstanceGuard::try_acquire(dir.path()).unwrap();
        assert!(again.is_some());
    }
}
