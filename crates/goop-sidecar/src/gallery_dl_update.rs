//! goop-native gallery-dl updater.
//!
//! gallery-dl's own `--update` is unusable for us: it downloads its
//! replacement binary from GitHub, but the project moved all release assets
//! to Codeberg (GitHub releases now carry none) and publishes no macOS build
//! at all. So instead of shelling out to `gallery-dl --update`, this module
//! asks Codeberg's (Gitea) API for the latest stable release and downloads
//! the matching per-platform binary into the resolver's writable update dir,
//! which the resolver prefers over the bundled sidecar
//! (`BinaryResolver::with_update_dir`).
//!
//! Platform coverage: Codeberg ships `gallery-dl.exe` (Windows x64) and
//! `gallery-dl.bin` (Linux) but **no macOS binary** — on macOS this stays a
//! ship-with-Goop no-op (gallery-dl is refreshed by bumping the pinned
//! version and shipping a new Goop release).

use crate::binaries::BinaryResolver;
use crate::fetch;
use crate::updater::{UpdateChecker, UpdateStatus};
use goop_core::GoopError;
use std::path::Path;

/// Codeberg (Gitea) API endpoint for the latest stable release.
const CODEBERG_API_LATEST: &str =
    "https://codeberg.org/api/v1/repos/mikf/gallery-dl/releases/latest";
/// Base for release asset downloads: `<base>/<tag>/<asset>`.
const CODEBERG_DL_BASE: &str = "https://codeberg.org/mikf/gallery-dl/releases/download";
/// Shown on platforms with no upstream binary (macOS). Mirrors the message
/// used by `UpdateChecker::for_gallery_dl`.
const SHIPS_WITH_GOOP: &str = "gallery-dl ships with Goop and updates when you update Goop.";
/// Prefix for this updater's error text, so a failure names the sidecar the
/// user actually asked about.
const LABEL: &str = "gallery-dl update";

/// Update the bundled gallery-dl from Codeberg, if a newer stable release
/// exists for this platform. macOS has no upstream binary, so it returns a
/// ship-with-Goop no-op.
pub async fn update(resolver: &BinaryResolver) -> Result<UpdateStatus, GoopError> {
    update_with(
        resolver,
        CODEBERG_API_LATEST,
        CODEBERG_DL_BASE,
        asset_for_target(),
    )
    .await
}

/// The Codeberg release asset for the current platform, or `None` when no
/// upstream binary exists (macOS — gallery-dl publishes none). goop ships
/// 64-bit Windows, so we use `gallery-dl.exe` (not the `_x86` variant).
fn asset_for_target() -> Option<&'static str> {
    if cfg!(target_os = "windows") {
        Some("gallery-dl.exe")
    } else if cfg!(target_os = "linux") {
        Some("gallery-dl.bin")
    } else {
        None
    }
}

/// Core update flow with the Codeberg URLs and platform asset injected so the
/// network paths are testable against a mock server.
async fn update_with(
    resolver: &BinaryResolver,
    api_latest_url: &str,
    dl_base: &str,
    asset: Option<&str>,
) -> Result<UpdateStatus, GoopError> {
    // No upstream binary for this platform (macOS): ship-with-Goop no-op.
    let Some(asset) = asset else {
        return Ok(UpdateStatus {
            attempted: false,
            previous_version: current_version(resolver).await,
            new_version: None,
            message: SHIPS_WITH_GOOP.to_string(),
        });
    };

    let Some(update_dir) = resolver.update_dir().map(Path::to_path_buf) else {
        return Err(GoopError::Queue(
            "gallery-dl update: no writable update directory is configured".into(),
        ));
    };

    // Held until this function returns, so the whole check-download-verify
    // sequence is atomic against any other update sharing the update dir.
    let _guard = fetch::lock_updates().await;

    // One client for both the API lookup and the download (cold path, but
    // avoids a second DNS lookup + TLS handshake to the same host). Per-request
    // timeouts differ, so none is set globally here.
    let client = reqwest::Client::builder()
        .user_agent("goop")
        .build()
        .map_err(|e| GoopError::Queue(format!("gallery-dl update: http client: {e}")))?;

    let previous = current_version(resolver).await;
    let tag = fetch::fetch_latest_tag(&client, api_latest_url, LABEL).await?;

    // `tag` comes from the API response and is interpolated into the asset URL
    // below; reject anything that isn't a plain version-ish token so a spoofed
    // or MITM'd response can't redirect the download or traverse the path.
    if !fetch::is_safe_tag(&tag) {
        return Err(GoopError::Queue(format!(
            "gallery-dl update: refusing suspicious release tag {tag:?}"
        )));
    }
    let latest = tag.trim_start_matches('v').to_string();

    // Only download when the upstream release is strictly newer than what we
    // already run. If the current version can't be determined, fall through
    // and (re)install.
    if let Some(prev) = &previous {
        if !fetch::is_newer(&latest, prev) {
            return Ok(UpdateStatus {
                attempted: false,
                previous_version: Some(prev.clone()),
                new_version: None,
                message: format!("gallery-dl is up to date ({prev})."),
            });
        }
    }

    let exe_name = if cfg!(windows) {
        "gallery-dl.exe"
    } else {
        "gallery-dl"
    };
    let dest = update_dir.join(exe_name);
    let url = format!("{dl_base}/{tag}/{asset}");
    // A refused rename collapses into the same error as any other download
    // failure here, which is exactly the behaviour this module already had.
    // yt-dlp distinguishes the busy case because its update can fire from a
    // background check while a job is running; gallery-dl's only runs from the
    // Settings button.
    fetch::download_binary(&client, &url, &dest, LABEL).await?;

    // The resolver now prefers `dest`; confirm the freshly downloaded binary
    // actually runs. If it doesn't (wrong arch, corrupt, truncated), remove it
    // so it can't shadow the working bundled copy. (Updates are user-initiated
    // and serialized through the single IPC handler, so nothing else races us
    // for `dest`.)
    match current_version(resolver).await {
        Some(v) => {
            let message = match &previous {
                Some(p) => format!("Updated gallery-dl {p} → {v}."),
                None => format!("Installed gallery-dl {v}."),
            };
            Ok(UpdateStatus {
                attempted: true,
                previous_version: previous,
                new_version: Some(v),
                message,
            })
        }
        None => {
            if let Err(e) = tokio::fs::remove_file(&dest).await {
                tracing::warn!(
                    "gallery-dl update: failed to remove non-running download {}: {e}",
                    dest.display()
                );
            }
            Err(GoopError::Queue(
                "gallery-dl update: the downloaded binary did not run; reverted to the bundled version".into(),
            ))
        }
    }
}

/// `gallery-dl --version` via the resolver, or `None` if it can't be resolved
/// or run. After a successful download the resolver points at the updated dir.
async fn current_version(resolver: &BinaryResolver) -> Option<String> {
    UpdateChecker::for_gallery_dl(resolver)
        .current_version()
        .await
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // ---- pure logic -----------------------------------------------------

    #[test]
    fn asset_matches_current_platform() {
        let a = asset_for_target();
        #[cfg(target_os = "macos")]
        assert_eq!(a, None, "macOS has no upstream binary");
        #[cfg(target_os = "windows")]
        assert_eq!(a, Some("gallery-dl.exe"));
        #[cfg(target_os = "linux")]
        assert_eq!(a, Some("gallery-dl.bin"));
    }

    // ---- orchestration --------------------------------------------------

    #[tokio::test]
    async fn no_asset_platform_is_ship_with_goop_noop() {
        let bundled = TempDir::new().unwrap();
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf());
        let status = update_with(
            &resolver,
            "http://unused.invalid",
            "http://unused.invalid",
            None,
        )
        .await
        .expect("noop ok");
        assert!(!status.attempted);
        assert!(status.message.contains("ships with Goop"));
    }

    #[tokio::test]
    async fn update_with_rejects_suspicious_tag_and_skips_download() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"tag_name":"../../etc/passwd"}"#),
            )
            .mount(&server)
            .await;
        // No download mock: a path-traversing tag must be rejected before any
        // asset fetch.
        let bundled = TempDir::new().unwrap();
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf());
        let err = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("gallery-dl.bin"),
        )
        .await
        .expect_err("suspicious tag must error");
        assert!(matches!(err, GoopError::Queue(_)));
        assert!(!updates.path().join("gallery-dl").exists());
    }

    // The full download+verify path executes the downloaded file, so it uses a
    // shell-script stand-in and is unix-only (macOS dev + Linux CI).
    #[cfg(unix)]
    fn write_script(path: &Path, version: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, format!("#!/bin/sh\necho {version}\n")).unwrap();
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_with_downloads_when_newer_available() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"tag_name":"v9.99.0"}"#))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/dl/v9.99.0/gallery-dl.bin"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(b"#!/bin/sh\necho 9.99.0\n".to_vec()),
            )
            .mount(&server)
            .await;

        let bundled = TempDir::new().unwrap();
        write_script(&bundled.path().join("gallery-dl"), "1.0.0"); // current = 1.0.0
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf());

        let status = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("gallery-dl.bin"),
        )
        .await
        .expect("update ok");

        assert!(status.attempted);
        assert_eq!(status.previous_version.as_deref(), Some("1.0.0"));
        assert_eq!(status.new_version.as_deref(), Some("9.99.0"));
        assert!(
            updates.path().join("gallery-dl").is_file(),
            "updated binary must land in the update dir"
        );
        assert!(status.message.contains("9.99.0"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_with_reports_up_to_date_and_skips_download() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"tag_name":"v1.0.0"}"#))
            .mount(&server)
            .await;
        // Intentionally no download mock: hitting it would 404 → expect() fails.

        let bundled = TempDir::new().unwrap();
        write_script(&bundled.path().join("gallery-dl"), "9.99.0"); // already newer than latest
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf());

        let status = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("gallery-dl.bin"),
        )
        .await
        .expect("ok");

        assert!(!status.attempted);
        assert!(status.message.to_lowercase().contains("up to date"));
        assert!(
            !updates.path().join("gallery-dl").exists(),
            "must not download when already up to date"
        );
    }
}
