use crate::fetch;
use goop_core::GoopError;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

/// The version of each self-updating sidecar Goop bundles, compiled in by
/// `build.rs` from the pins in `scripts/fetch-sidecars.sh`.
const BUNDLED_VERSIONS: [(&str, &str); 2] = [
    ("yt-dlp", env!("GOOP_BUNDLED_YT_DLP_VERSION")),
    ("gallery-dl", env!("GOOP_BUNDLED_GALLERY_DL_VERSION")),
];

/// Longest version marker read back. A real one is a dozen bytes; the cap
/// keeps a corrupt one from being read whole on every resolve.
const MAX_VERSION_MARKER_LEN: u64 = 64;

pub struct BinaryResolver {
    sidecar_dir: PathBuf,
    /// Writable dir holding goop-native sidecar updates (e.g. a gallery-dl
    /// downloaded from Codeberg). Checked BEFORE `sidecar_dir` so an in-app
    /// update shadows the binary shipped inside the (signed, read-only) app
    /// bundle without having to touch the bundle itself — but only while it
    /// is newer than the bundled copy (see `newer_update`). `None` disables
    /// the override (the historical behaviour).
    update_dir: Option<PathBuf>,
    /// The version of each sidecar in `sidecar_dir`, by name. Defaults to
    /// [`BUNDLED_VERSIONS`].
    bundled_versions: HashMap<String, String>,
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
            bundled_versions: BUNDLED_VERSIONS
                .iter()
                .map(|(name, version)| (name.to_string(), version.to_string()))
                .collect(),
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

    /// Declare which version of `name` `sidecar_dir` bundles, in place of the
    /// pin compiled in from `scripts/fetch-sidecars.sh`.
    pub fn with_bundled_version(mut self, name: &str, version: &str) -> Self {
        self.bundled_versions
            .insert(name.to_string(), version.to_string());
        self
    }

    /// The version of `name` that `sidecar_dir` bundles, if known.
    pub fn bundled_version(&self, name: &str) -> Option<&str> {
        self.bundled_versions.get(name).map(String::as_str)
    }

    /// Resolve a sidecar by name. Preference order:
    ///   1. an updated copy in `update_dir` (goop-native self-update), if it
    ///      is newer than the bundled copy,
    ///   2. the bundled copy in `sidecar_dir`,
    ///   3. `$PATH` (dev / Homebrew installs).
    pub fn resolve(&self, name: &str) -> Result<ResolvedBinary, GoopError> {
        let exe = exe_name(name);
        if let Some(updated) = self.newer_update(name, &exe) {
            return Ok(ResolvedBinary {
                name: name.to_string(),
                path: updated,
                source_is_path: false,
            });
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

    /// The version of the bundled copy of `name` an update has to beat:
    /// `None` when `sidecar_dir` holds no such binary, or its version is
    /// unknown, which leaves nothing for a verified update to lose against.
    pub(crate) fn bundled_copy_version(&self, name: &str) -> Option<&str> {
        let bundled = self.bundled_version(name)?;
        self.sidecar_dir
            .join(exe_name(name))
            .is_file()
            .then_some(bundled)
    }

    /// The update-dir copy of `exe`, if there is one and it is newer than the
    /// bundled copy (or there is no bundled copy).
    ///
    /// "Newer" is read from the version marker the updater wrote beside the
    /// binary after verifying it, so the check costs a small file read rather
    /// than a process spawn. A copy without a readable marker — anything
    /// installed before markers existed — is ignored: its version is unknown,
    /// and the bundled copy is the one this release shipped. If upstream
    /// really is newer, the next update check installs it again with a marker.
    fn newer_update(&self, name: &str, exe: &str) -> Option<PathBuf> {
        let path = self.update_dir.as_ref()?.join(exe);
        if !path.is_file() {
            return None;
        }
        let installed = read_version_marker(&path)?;
        match self.bundled_copy_version(name) {
            Some(bundled) => fetch::is_newer(&installed, bundled).then_some(path),
            None => Some(path),
        }
    }
}

/// The file name of sidecar `name` on this platform.
fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Where the version of the update-dir binary at `binary` is recorded:
/// `yt-dlp.version` beside `yt-dlp` (`yt-dlp.exe.version` on Windows).
pub(crate) fn version_marker(binary: &Path) -> PathBuf {
    let mut marker = binary.as_os_str().to_owned();
    marker.push(".version");
    PathBuf::from(marker)
}

/// Record `version` as the version of the update-dir binary at `binary`.
/// The resolver judges the binary by this, so an updater writes it only once
/// the download is in place, and removes it with [`discard_update`] if the
/// download turns out not to be that version.
pub(crate) async fn record_update_version(binary: &Path, version: &str) -> std::io::Result<()> {
    tokio::fs::write(version_marker(binary), version).await
}

/// Remove an update-dir binary and its version marker, logging (under
/// `label`) whatever can't be removed. The marker goes first: once it is gone
/// the resolver ignores the binary, even one Windows won't delete because it
/// is still running.
pub(crate) async fn discard_update(binary: &Path, label: &str) {
    for path in [version_marker(binary), binary.to_path_buf()] {
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!("{label}: failed to remove {}: {e}", path.display()),
        }
    }
}

/// The version recorded for `binary`, if its marker holds exactly one plain
/// version token.
fn read_version_marker(binary: &Path) -> Option<String> {
    let mut text = String::new();
    std::fs::File::open(version_marker(binary))
        .ok()?
        .take(MAX_VERSION_MARKER_LEN + 1)
        .read_to_string(&mut text)
        .ok()?;
    let version = text.trim();
    let well_formed = text.len() as u64 <= MAX_VERSION_MARKER_LEN
        && fetch::is_safe_tag(version)
        && fetch::parse_version(version).is_some();
    well_formed.then(|| version.to_string())
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

    /// What the updater leaves in the update dir: the binary, and beside it
    /// `<exe>.version` holding the version it verified (`None` = a copy
    /// installed before markers existed).
    fn install_update(dir: &Path, stem: &str, version: Option<&str>) -> PathBuf {
        let p = touch(dir, stem);
        if let Some(v) = version {
            std::fs::write(dir.join(format!("{}.version", exe_name(stem))), v).unwrap();
        }
        p
    }

    /// A bundled dir holding `stem`, and a resolver that knows it bundles
    /// `bundled_version` of it and has `updated` as its update dir.
    fn resolver(
        bundled: &TempDir,
        updated: &TempDir,
        stem: &str,
        bundled_version: &str,
    ) -> (BinaryResolver, PathBuf) {
        let path = touch(bundled.path(), stem);
        let r = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updated.path().to_path_buf())
            .with_bundled_version(stem, bundled_version);
        (r, path)
    }

    #[test]
    fn an_update_newer_than_the_bundled_copy_wins() {
        let bundled = TempDir::new().unwrap();
        let updated = TempDir::new().unwrap();
        let (r, _) = resolver(&bundled, &updated, "yt-dlp", "2026.10.21");
        let want = install_update(updated.path(), "yt-dlp", Some("2026.11.02"));
        let got = r.resolve("yt-dlp").expect("resolves updated");
        assert_eq!(
            got.path, want,
            "a newer update_dir copy must win over bundled"
        );
        assert!(!got.source_is_path);
    }

    /// The bug this guards: a user self-updated to an older yt-dlp, then
    /// installed a Goop that bundles a newer one. The old copy must not keep
    /// running just because it sits in the update dir.
    #[test]
    fn an_older_self_update_does_not_shadow_a_newer_bundled_copy() {
        let bundled = TempDir::new().unwrap();
        let updated = TempDir::new().unwrap();
        let (r, want) = resolver(&bundled, &updated, "yt-dlp", "2026.10.21");
        install_update(updated.path(), "yt-dlp", Some("2026.08.19"));
        let got = r.resolve("yt-dlp").expect("resolves bundled");
        assert_eq!(got.path, want);
    }

    #[test]
    fn an_update_at_the_bundled_version_does_not_shadow_it() {
        let bundled = TempDir::new().unwrap();
        let updated = TempDir::new().unwrap();
        let (r, want) = resolver(&bundled, &updated, "yt-dlp", "2026.10.21");
        install_update(updated.path(), "yt-dlp", Some("2026.10.21"));
        let got = r.resolve("yt-dlp").expect("resolves bundled");
        assert_eq!(got.path, want, "a tie goes to the bundled copy");
    }

    /// Every copy installed before version markers existed has none, and its
    /// version is unknown without running it, so it can't be trusted to be
    /// newer than what this Goop bundles.
    #[test]
    fn an_update_without_a_version_marker_is_ignored() {
        let bundled = TempDir::new().unwrap();
        let updated = TempDir::new().unwrap();
        let (r, want) = resolver(&bundled, &updated, "yt-dlp", "2026.10.21");
        install_update(updated.path(), "yt-dlp", None);
        let got = r.resolve("yt-dlp").expect("resolves bundled");
        assert_eq!(got.path, want);
    }

    #[test]
    fn an_update_with_a_malformed_version_marker_is_ignored() {
        let long = "9".repeat(200);
        // Valid once trimmed, but longer than the cap: only part of the file
        // is read, so the rest of it is unknown.
        let padded = format!("2099.01.01{}", " ".repeat(100));
        for marker in [
            "",
            "not-a-version",
            "2099.01.01\nrm -rf /",
            "2099.01.01 2099.01.02",
            &long,
            &padded,
        ] {
            let bundled = TempDir::new().unwrap();
            let updated = TempDir::new().unwrap();
            let (r, want) = resolver(&bundled, &updated, "yt-dlp", "2026.10.21");
            install_update(updated.path(), "yt-dlp", Some(marker));
            let got = r.resolve("yt-dlp").expect("resolves bundled");
            assert_eq!(
                got.path, want,
                "marker {marker:?} must not count as a version"
            );
        }
    }

    /// gallery-dl's pin carries a `v` (`v1.32.11`) and its `--version` does
    /// not (`1.32.4`); the two must still compare as versions.
    #[test]
    fn gallery_dl_updates_compare_against_a_v_prefixed_pin() {
        let bundled = TempDir::new().unwrap();
        let updated = TempDir::new().unwrap();
        let (r, want) = resolver(&bundled, &updated, "gallery-dl", "v1.32.11");
        let update = install_update(updated.path(), "gallery-dl", Some("1.32.4"));
        assert_eq!(
            r.resolve("gallery-dl").unwrap().path,
            want,
            "1.32.4 < v1.32.11"
        );
        install_update(updated.path(), "gallery-dl", Some("1.32.17"));
        assert_eq!(
            r.resolve("gallery-dl").unwrap().path,
            update,
            "1.32.17 > v1.32.11"
        );
    }

    #[test]
    fn an_update_with_a_marker_wins_when_no_bundled_version_is_known() {
        let bundled = TempDir::new().unwrap();
        let updated = TempDir::new().unwrap();
        touch(bundled.path(), "some-tool");
        let want = install_update(updated.path(), "some-tool", Some("1.0.0"));
        let r = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updated.path().to_path_buf());
        assert_eq!(r.bundled_version("some-tool"), None);
        assert_eq!(r.resolve("some-tool").unwrap().path, want);
    }

    /// The compiled-in pins are the ones `scripts/fetch-sidecars.sh` downloads,
    /// so a pin bump can't leave the resolver comparing against a stale one.
    #[test]
    fn a_new_resolver_knows_the_versions_fetch_sidecars_bundles() {
        let script_path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/fetch-sidecars.sh");
        let script = std::fs::read_to_string(&script_path).unwrap();
        let r = BinaryResolver::new(PathBuf::from("/nonexistent"));
        for (name, var) in [
            ("yt-dlp", "YT_DLP_VERSION"),
            ("gallery-dl", "GALLERY_DL_VERSION"),
        ] {
            let pinned = crate::pins::read_pin(&script, var).expect("script pins it");
            assert_eq!(r.bundled_version(name), Some(pinned), "{name}");
        }
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

    /// With no bundled copy there is nothing to protect, so a verified update
    /// is used whatever its version. That is the repair path when the
    /// bundled binary is gone (quarantined by antivirus, say).
    #[test]
    fn a_marked_update_wins_when_the_bundled_copy_is_missing() {
        let bundled = TempDir::new().unwrap(); // empty
        let updated = TempDir::new().unwrap();
        let r = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updated.path().to_path_buf())
            .with_bundled_version("goop-test-tool", "2.0.0");
        for marker in ["2.0.0", "1.0.0"] {
            let want = install_update(updated.path(), "goop-test-tool", Some(marker));
            let got = r.resolve("goop-test-tool").expect("resolves updated");
            assert_eq!(got.path, want, "marker {marker}");
        }
    }

    #[test]
    fn an_unmarked_update_is_ignored_even_when_the_bundled_copy_is_missing() {
        let bundled = TempDir::new().unwrap(); // empty
        let updated = TempDir::new().unwrap();
        install_update(updated.path(), "goop-test-tool", None);
        let r = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updated.path().to_path_buf());
        assert!(r.resolve("goop-test-tool").is_err());
    }
}
