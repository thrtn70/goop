//! Shared fixtures for the updater tests.

use std::path::Path;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

/// An unrelated process holding a writer on the inode an update downloads,
/// which is the state a sibling thread's forked child leaves behind when it
/// forks while the download is being written: it keeps a copy of the
/// writer until it reaches its own exec, and until then Linux refuses to
/// run the file (`ETXTBSY`).
///
/// It opens the download's temp name before the updater does, so the
/// updater's create truncates that same inode instead of making a new one,
/// and the rename into place keeps it. It lets go half a second after the
/// installed binary appears — long after the updater's version check has
/// first tried to run it.
pub(crate) struct WriterHolder(Child);

impl WriterHolder {
    pub(crate) fn hold(temp: &Path, installed: &Path) -> Self {
        // `>>` rather than `>`: the holder must not truncate what the
        // updater writes. The wait for `installed` is bounded so a test
        // that fails before installing anything does not leave it behind.
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg(
                "exec 9>>\"$0\"; i=0; \
                 while [ ! -e \"$1\" ] && [ \"$i\" -lt 1000 ]; do sleep 0.01; i=$((i+1)); done; \
                 sleep 0.5",
            )
            .arg(temp)
            .arg(installed)
            .spawn()
            .unwrap();
        let holder = Self(child);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !temp.exists() {
            assert!(
                Instant::now() < deadline,
                "writer holder did not create {} within 2s",
                temp.display()
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        holder
    }
}

impl Drop for WriterHolder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
