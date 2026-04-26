//! Trait abstraction for registering child-process PIDs by job, so the
//! scheduler can pause/resume them without coupling worker crates
//! (`goop-converter`, `goop-pdf`) to the scheduler's internal map type.
//!
//! Workers that spawn pausable child processes call `register(job_id, pid)`
//! immediately after `spawn()` and `unregister(job_id)` on every exit path
//! (success, error, cancel). Use `register_guard` to get an RAII handle that
//! unregisters on drop.

use crate::job::JobId;
use std::sync::Arc;

/// Implemented by anything that tracks the live PIDs of running jobs.
/// The scheduler in `goop-queue` provides a `DashMap`-backed implementation;
/// tests and code paths that don't need pause/resume can pass `NoopRegistry`.
pub trait PidRegistry: Send + Sync + 'static {
    fn register(&self, id: JobId, pid: u32);
    fn unregister(&self, id: JobId);
    /// Returns the PID currently registered for `id`, or `None`.
    fn lookup(&self, id: JobId) -> Option<u32>;
}

/// No-op registry — useful for tests and for worker call sites where pause
/// support is not wired up yet.
pub struct NoopRegistry;

impl PidRegistry for NoopRegistry {
    fn register(&self, _id: JobId, _pid: u32) {}
    fn unregister(&self, _id: JobId) {}
    fn lookup(&self, _id: JobId) -> Option<u32> {
        None
    }
}

/// RAII guard returned by `register_guard`. Calls `unregister(id)` on drop,
/// even on panic — so cancel, error, and success paths all clean up.
pub struct PidGuard {
    registry: Arc<dyn PidRegistry>,
    id: JobId,
}

impl PidGuard {
    pub fn new(registry: Arc<dyn PidRegistry>, id: JobId, pid: u32) -> Self {
        registry.register(id, pid);
        Self { registry, id }
    }
}

impl Drop for PidGuard {
    fn drop(&mut self) {
        self.registry.unregister(self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    #[derive(Default)]
    struct CountingRegistry {
        registered: Mutex<Vec<(JobId, u32)>>,
        unregistered: Mutex<Vec<JobId>>,
    }

    impl PidRegistry for CountingRegistry {
        fn register(&self, id: JobId, pid: u32) {
            self.registered.lock().push((id, pid));
        }
        fn unregister(&self, id: JobId) {
            self.unregistered.lock().push(id);
        }
        fn lookup(&self, id: JobId) -> Option<u32> {
            self.registered
                .lock()
                .iter()
                .rev()
                .find(|(rid, _)| *rid == id)
                .map(|(_, pid)| *pid)
        }
    }

    #[test]
    fn guard_registers_on_construct_and_unregisters_on_drop() {
        let reg: Arc<CountingRegistry> = Arc::new(CountingRegistry::default());
        let id = JobId::new();
        {
            let _g = PidGuard::new(reg.clone(), id, 1234);
            assert_eq!(reg.registered.lock().as_slice(), &[(id, 1234)]);
            assert!(reg.unregistered.lock().is_empty());
        }
        assert_eq!(reg.unregistered.lock().as_slice(), &[id]);
    }

    #[test]
    fn noop_registry_does_nothing_and_compiles() {
        let r = NoopRegistry;
        r.register(JobId::new(), 42);
        r.unregister(JobId::new());
    }
}
