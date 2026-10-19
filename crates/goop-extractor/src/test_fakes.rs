//! Fake sidecars for the tests that drive an extractor end-to-end.
//!
//! A "fake" is a `/bin/sh` script written into a temp dir that a
//! `BinaryResolver` is pointed at, so a test can pin down what this crate
//! does with a sidecar's exit code, stdout and stderr without a network.
//!
//! The writing itself is `goop_core::test_scripts::write_script`, shared
//! with every other crate's tests: a script is not runnable the moment it
//! is written, and that module explains why and waits it out. This keeps
//! only the dir-and-name shape the tests here call it with.
//!
//! Unix-only: the fakes are shell scripts. The logic they exercise is
//! platform-independent, so the coverage gap on Windows is acceptable.

/// Writes `body` into `dir/name` as a runnable `/bin/sh` script, and
/// returns only once it can actually be run.
pub(crate) fn write_fake(dir: &std::path::Path, name: &str, body: &str) {
    goop_core::test_scripts::write_script(&dir.join(name), body);
}
