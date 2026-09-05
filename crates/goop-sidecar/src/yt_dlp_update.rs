//! goop-native yt-dlp updater.
//!
//! yt-dlp's own `-U` rewrites the running binary **in place**. Inside a signed
//! macOS bundle that binary lives in `Contents/MacOS` next to the app's own
//! executable, so a self-update mutates the notarized bundle — and under
//! `/Applications` it needs to write to a root-owned directory it usually
//! can't. Either way the app's signature no longer matches what was shipped.
//!
//! So Goop updates yt-dlp the same way it updates gallery-dl: ask GitHub for
//! the latest release, download the per-platform binary into the resolver's
//! writable update dir, and let `BinaryResolver` prefer that copy over the
//! bundled one (`BinaryResolver::with_update_dir`). The signed bundle is never
//! touched.
//!
//! Platform coverage: yt-dlp publishes `yt-dlp_macos` (arm64-capable
//! universal), `yt-dlp.exe` (Windows x64) and `yt-dlp_linux`. goop ships macOS
//! arm64 + Windows x64; the Linux asset exists for dev/CI only.

use crate::binaries::BinaryResolver;
use crate::fetch::{self, FetchError};
use crate::updater::{UpdateChecker, UpdateStatus};
use goop_core::GoopError;
use std::path::Path;

/// Prefix for this updater's error text, so a failure names the sidecar the
/// user actually asked about.
const LABEL: &str = "yt-dlp update";

/// GitHub releases API endpoint for the latest stable release. yt-dlp tags
/// releases by date (`2026.07.04`), which `fetch::parse_version` reads as
/// ordinary dotted numbers.
const GITHUB_API_LATEST: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
/// Base for release asset downloads: `<base>/<tag>/<asset>`.
const GITHUB_DL_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/download";
/// Shown on platforms yt-dlp publishes no binary for.
const NO_BINARY_FOR_PLATFORM: &str = "yt-dlp publishes no binary for this platform.";

/// Update the bundled yt-dlp from GitHub, if a newer release exists for this
/// platform.
pub async fn update(resolver: &BinaryResolver) -> Result<UpdateStatus, GoopError> {
    update_with(
        resolver,
        GITHUB_API_LATEST,
        GITHUB_DL_BASE,
        asset_for_target(),
    )
    .await
}

/// The GitHub release asset for the current platform. `None` on platforms
/// yt-dlp publishes nothing for.
fn asset_for_target() -> Option<&'static str> {
    if cfg!(target_os = "windows") {
        // goop ships 64-bit Windows, so the plain `.exe` (not `_x86`, not
        // `_arm64`).
        Some("yt-dlp.exe")
    } else if cfg!(target_os = "macos") {
        Some("yt-dlp_macos")
    } else if cfg!(target_os = "linux") {
        Some("yt-dlp_linux")
    } else {
        None
    }
}

/// Core update flow with the URLs and platform asset injected so the network
/// paths are testable against a mock server.
async fn update_with(
    resolver: &BinaryResolver,
    api_latest_url: &str,
    dl_base: &str,
    asset: Option<&str>,
) -> Result<UpdateStatus, GoopError> {
    let Some(asset) = asset else {
        return Ok(UpdateStatus {
            attempted: false,
            previous_version: current_version(resolver).await,
            new_version: None,
            message: NO_BINARY_FOR_PLATFORM.to_string(),
        });
    };

    let Some(update_dir) = resolver.update_dir().map(Path::to_path_buf) else {
        return Err(GoopError::Queue(
            "yt-dlp update: no writable update directory is configured".into(),
        ));
    };

    // Held until this function returns, so the whole check-download-verify
    // sequence is atomic against any other update. Without it a second caller
    // can fail its own verify and delete the binary this one just installed.
    let _guard = fetch::lock_updates().await;

    // One client for both the API lookup and the download (cold path, but
    // avoids a second DNS lookup + TLS handshake). GitHub rejects requests
    // without a User-Agent outright, so the builder's is not optional here.
    let client = reqwest::Client::builder()
        .user_agent("goop")
        .build()
        .map_err(|e| GoopError::Queue(format!("yt-dlp update: http client: {e}")))?;

    let previous = current_version(resolver).await;
    let tag = fetch::fetch_latest_tag(&client, api_latest_url, LABEL).await?;

    // `tag` comes from the API response and is interpolated into the asset URL
    // below; reject anything that isn't a plain version-ish token so a spoofed
    // or MITM'd response can't redirect the download or traverse the path.
    if !fetch::is_safe_tag(&tag) {
        return Err(GoopError::Queue(format!(
            "yt-dlp update: refusing suspicious release tag {tag:?}"
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
                message: format!("yt-dlp is up to date ({prev})."),
            });
        }
    }

    let exe_name = if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    };
    let dest = update_dir.join(exe_name);
    let url = format!("{dl_base}/{tag}/{asset}");
    let checksum_url = format!("{dl_base}/{tag}/SHA2-256SUMS");
    let expected = fetch::fetch_checksum(&client, &checksum_url, asset, LABEL).await?;
    match fetch::download_binary(&client, &url, &expected, &dest, LABEL).await {
        Ok(()) => {}
        // The bytes arrived but the swap was refused — almost always Windows
        // refusing to rename over a yt-dlp that is still running a job. That
        // is a "not now", not a failure: nothing was replaced, the next check
        // will retry, and reporting it as an error would train the user to
        // ignore a real one.
        Err(FetchError::RenameFailed {
            source,
            likely_busy: true,
        }) => {
            tracing::warn!("yt-dlp update: deferred, destination busy: {source}");
            return Ok(UpdateStatus {
                attempted: true,
                previous_version: previous,
                new_version: None,
                message: "yt-dlp is in use right now, so the update was deferred. It will be \
                          applied the next time you check."
                    .to_string(),
            });
        }
        // A rename that failed for any other reason is a real failure. Calling
        // it a deferral would retry forever and never say what was wrong.
        Err(FetchError::RenameFailed { source, .. }) => return Err(source),
        Err(FetchError::Failed(e)) => return Err(e),
    }

    // The resolver now prefers `dest`; confirm the freshly downloaded binary
    // actually runs. If it doesn't (wrong arch, corrupt, truncated), remove it
    // so it can't shadow the working bundled copy.
    match current_version(resolver).await {
        Some(v) => {
            let message = match &previous {
                Some(p) => format!("Updated yt-dlp {p} → {v}."),
                None => format!("Installed yt-dlp {v}."),
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
                    "yt-dlp update: failed to remove non-running download {}: {e}",
                    dest.display()
                );
            }
            Err(GoopError::Queue(
                "yt-dlp update: the downloaded binary did not run; reverted to the bundled version"
                    .into(),
            ))
        }
    }
}

/// `yt-dlp --version` via the resolver, or `None` if it can't be resolved or
/// run. After a successful download the resolver points at the updated dir.
async fn current_version(resolver: &BinaryResolver) -> Option<String> {
    UpdateChecker::for_yt_dlp(resolver)
        .current_version()
        .await
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn asset_matches_current_platform() {
        let a = asset_for_target();
        #[cfg(target_os = "macos")]
        assert_eq!(a, Some("yt-dlp_macos"));
        #[cfg(target_os = "windows")]
        assert_eq!(a, Some("yt-dlp.exe"));
        #[cfg(target_os = "linux")]
        assert_eq!(a, Some("yt-dlp_linux"));
    }

    #[tokio::test]
    async fn no_asset_platform_is_a_noop() {
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
        assert!(status.message.contains("no binary for this platform"));
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
            Some("yt-dlp_linux"),
        )
        .await
        .expect_err("suspicious tag must error");
        assert!(matches!(err, GoopError::Queue(_)));
        assert!(!updates.path().join("yt-dlp").exists());
    }

    /// GitHub answers an exhausted unauthenticated quota with 403. That must
    /// surface as an error — reading it as "no update available" would leave a
    /// stale extractor in place while telling the user it was current.
    #[tokio::test]
    async fn rate_limited_lookup_is_an_error_not_a_silent_no_update() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(
                ResponseTemplate::new(403)
                    .set_body_string(r#"{"message":"API rate limit exceeded for 1.2.3.4."}"#),
            )
            .mount(&server)
            .await;
        let bundled = TempDir::new().unwrap();
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf());
        let err = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
        )
        .await
        .expect_err("403 must be an error");
        assert!(matches!(err, GoopError::Queue(_)));
        assert!(!updates.path().join("yt-dlp").exists());
    }

    #[tokio::test]
    async fn server_error_on_lookup_installs_nothing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let bundled = TempDir::new().unwrap();
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf());
        let err = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
        )
        .await
        .expect_err("500 must be an error");
        assert!(matches!(err, GoopError::Queue(_)));
        assert!(!updates.path().join("yt-dlp").exists());
    }

    #[tokio::test]
    async fn missing_asset_installs_nothing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"tag_name":"2099.01.01"}"#),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/dl/2099.01.01/SHA2-256SUMS"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                "d8c3364ccace3861c2269d044b69fdf8813f1b332928a5f58003550cae9b4d71  yt-dlp_linux\n",
            ))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/dl/2099.01.01/yt-dlp_linux"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let bundled = TempDir::new().unwrap();
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf());
        let err = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
        )
        .await
        .expect_err("404 asset must error");
        assert!(matches!(err, GoopError::Queue(_)));
        assert!(!updates.path().join("yt-dlp").exists());
        assert!(!updates.path().join("yt-dlp.tmp-download").exists());
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
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"tag_name":"2026.07.04"}"#),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/dl/2026.07.04/SHA2-256SUMS"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                "d8c3364ccace3861c2269d044b69fdf8813f1b332928a5f58003550cae9b4d71  yt-dlp_linux\n",
            ))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/dl/2026.07.04/yt-dlp_linux"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(b"#!/bin/sh\necho 2026.07.04\n".to_vec()),
            )
            .mount(&server)
            .await;

        let bundled = TempDir::new().unwrap();
        write_script(&bundled.path().join("yt-dlp"), "2026.06.09");
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf());

        let status = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
        )
        .await
        .expect("update ok");

        assert!(status.attempted);
        assert_eq!(status.previous_version.as_deref(), Some("2026.06.09"));
        assert_eq!(status.new_version.as_deref(), Some("2026.07.04"));
        assert!(
            updates.path().join("yt-dlp").is_file(),
            "updated binary must land in the update dir, never in the bundle"
        );
        assert!(status.message.contains("2026.07.04"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_with_reports_up_to_date_and_skips_download() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"tag_name":"2026.06.09"}"#),
            )
            .mount(&server)
            .await;
        // Intentionally no download mock: hitting it would 404 → expect() fails.

        let bundled = TempDir::new().unwrap();
        write_script(&bundled.path().join("yt-dlp"), "2026.06.09");
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf());

        let status = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
        )
        .await
        .expect("ok");

        assert!(!status.attempted);
        assert!(status.message.to_lowercase().contains("up to date"));
        assert!(
            !updates.path().join("yt-dlp").exists(),
            "must not download when already up to date"
        );
    }

    /// Two updates fired at once must not both install. Serialized, the first
    /// downloads and the second — reading the version *after* the first
    /// finished — finds itself already current and does nothing. Unserialized,
    /// both would read the stale version up front and both would attempt,
    /// which is the race where the loser's failed verify deletes the winner's
    /// freshly installed binary.
    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_updates_are_serialized_so_only_one_installs() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"tag_name":"2026.07.04"}"#),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/dl/2026.07.04/SHA2-256SUMS"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                "d8c3364ccace3861c2269d044b69fdf8813f1b332928a5f58003550cae9b4d71  yt-dlp_linux\n",
            ))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/dl/2026.07.04/yt-dlp_linux"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(b"#!/bin/sh\necho 2026.07.04\n".to_vec()),
            )
            .mount(&server)
            .await;

        let bundled = TempDir::new().unwrap();
        write_script(&bundled.path().join("yt-dlp"), "2026.06.09");
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf());

        let api = format!("{}/latest", server.uri());
        let dl = format!("{}/dl", server.uri());
        let (a, b) = tokio::join!(
            update_with(&resolver, &api, &dl, Some("yt-dlp_linux")),
            update_with(&resolver, &api, &dl, Some("yt-dlp_linux")),
        );
        let a = a.expect("first update ok");
        let b = b.expect("second update ok");

        let attempted = [&a, &b].iter().filter(|s| s.attempted).count();
        assert_eq!(
            attempted, 1,
            "exactly one of two concurrent updates may install; got {a:?} and {b:?}"
        );
        assert_eq!(
            current_version(&resolver).await.as_deref(),
            Some("2026.07.04"),
            "the installed binary must survive the other call's run"
        );
    }

    /// A download that lands but won't execute (wrong arch, truncated,
    /// corrupt) must be removed so it can't shadow the working bundled copy.
    #[cfg(unix)]
    #[tokio::test]
    async fn update_with_reverts_a_binary_that_does_not_run() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"tag_name":"2026.07.04"}"#),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/dl/2026.07.04/SHA2-256SUMS"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                "054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8  yt-dlp_linux\n",
            ))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/dl/2026.07.04/yt-dlp_linux"))
            .respond_with(
                // Not a script and not an executable image — exec fails.
                ResponseTemplate::new(200).set_body_bytes(vec![0x00, 0x01, 0x02, 0x03]),
            )
            .mount(&server)
            .await;

        let bundled = TempDir::new().unwrap();
        write_script(&bundled.path().join("yt-dlp"), "2026.06.09");
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf());

        let err = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
        )
        .await
        .expect_err("a binary that won't run must error");
        assert!(matches!(err, GoopError::Queue(_)));
        assert!(
            !updates.path().join("yt-dlp").exists(),
            "the broken download must be removed, not left to shadow the bundled copy"
        );
        assert_eq!(
            current_version(&resolver).await.as_deref(),
            Some("2026.06.09"),
            "the bundled copy must be working again after the revert"
        );
    }
}
