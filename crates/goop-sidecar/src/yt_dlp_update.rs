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
//! bundled one (`BinaryResolver::with_update_dir`) for as long as the version
//! recorded beside it is newer. The signed bundle is never touched.
//!
//! The download is checked against the SHA-256 in the release's
//! `SHA2-256SUMS`, and that manifest is only believed once its signature
//! verifies against yt-dlp's key, pinned in `SIGNING_KEYS`.
//!
//! Platform coverage: yt-dlp publishes `yt-dlp_macos` (arm64-capable
//! universal), `yt-dlp.exe` (Windows x64) and `yt-dlp_linux`. goop ships macOS
//! arm64 + Windows x64; the Linux asset exists for dev/CI only.

use crate::binaries::{self, BinaryResolver};
use crate::fetch::{self, FetchError};
use crate::signature::TrustedKey;
use crate::updater::{UpdateChecker, UpdateStatus};
use goop_core::GoopError;
use std::path::{Path, PathBuf};

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
/// The key yt-dlp signs `SHA2-256SUMS` with: `public.key` in the yt-dlp
/// repository, unchanged since yt-dlp started signing releases in 2023. A
/// rotation upstream needs a Goop release that adds the new key here; until
/// then updates are refused with an error naming the key that signed.
const SIGNING_KEYS: &[TrustedKey] = &[TrustedKey {
    fingerprint: "AC0CBBE6848D6A873464AF4E57CF65933B5A7581",
    armored: include_str!("../keys/yt-dlp.asc"),
}];

/// Update the bundled yt-dlp from GitHub, if a newer release exists for this
/// platform.
pub async fn update(resolver: &BinaryResolver) -> Result<UpdateStatus, GoopError> {
    update_with(
        resolver,
        GITHUB_API_LATEST,
        GITHUB_DL_BASE,
        asset_for_target(),
        SIGNING_KEYS,
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

/// Core update flow with the URLs, platform asset and trusted signing keys
/// injected so the network paths are testable against a mock server and a
/// throwaway key.
async fn update_with(
    resolver: &BinaryResolver,
    api_latest_url: &str,
    dl_base: &str,
    asset: Option<&str>,
    keys: &[TrustedKey],
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

    // Held until this function returns, so the whole check-download-vet-install
    // sequence is atomic against any other update. Without it two callers
    // share one temp path and both judge their download against the same
    // stale current version.
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

    // The resolver ignores an update-dir copy that is no newer than the
    // bundled one, so installing such a release would change nothing.
    if let Some(bundled) = resolver.bundled_copy_version("yt-dlp") {
        if !fetch::is_newer(&latest, bundled) {
            return Ok(UpdateStatus {
                attempted: false,
                previous_version: previous,
                new_version: None,
                message: format!("yt-dlp {latest} is not newer than the bundled {bundled}."),
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
    let expected =
        fetch::fetch_verified_checksum(&client, &checksum_url, asset, keys, LABEL).await?;
    let downloaded = fetch::download_binary(&client, &url, &expected, &dest, LABEL, |staged| {
        vet(staged, resolver, &latest, previous.as_deref())
    });
    let installed = match downloaded.await {
        Ok(installed) => installed,
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
    };

    // The resolver prefers an update-dir copy only while the version recorded
    // beside it is newer than the bundled one. `installed` is the version the
    // vetted binary itself reported, so the marker can't hold a number the
    // binary doesn't have.
    if let Err(e) = binaries::record_update_version(&dest, &installed).await {
        binaries::discard_update(&dest, LABEL).await;
        return Err(GoopError::Queue(format!(
            "yt-dlp update: could not record the installed version: {e}"
        )));
    }

    let message = match &previous {
        Some(p) => format!("Updated yt-dlp {p} → {installed}."),
        None => format!("Installed yt-dlp {installed}."),
    };
    Ok(UpdateStatus {
        attempted: true,
        previous_version: previous,
        new_version: Some(installed),
        message,
    })
}

/// Run the staged download before it replaces anything, and refuse it unless
/// it runs, is the release its tag names, and is newer than what it would
/// replace (`fetch::vet_version`). A refusal leaves the resolver running
/// whatever it ran before. Returns the version that will be installed.
async fn vet(
    staged: PathBuf,
    resolver: &BinaryResolver,
    latest: &str,
    previous: Option<&str>,
) -> Result<String, GoopError> {
    let reported = UpdateChecker::for_yt_dlp(resolver)
        .version_at(&staged)
        .await
        .ok();
    fetch::vet_version(reported, latest, previous).map_err(|reason| {
        GoopError::Queue(format!("yt-dlp update: {reason}; nothing was installed"))
    })
}

/// `yt-dlp --version` via the resolver, or `None` if it can't be resolved or
/// run. Once an update is installed and its version recorded, the resolver
/// points at the updated dir.
async fn current_version(resolver: &BinaryResolver) -> Option<String> {
    UpdateChecker::for_yt_dlp(resolver)
        .current_version()
        .await
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signature::test_support::{fixture, OTHER_KEY_FINGERPRINT, TEST_KEY};
    use std::path::Path;
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn serve_latest(server: &MockServer, tag: &str) {
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(format!(r#"{{"tag_name":"{tag}"}}"#)),
            )
            .mount(server)
            .await;
    }

    async fn serve_fixture(server: &MockServer, at: String, name: &str) {
        Mock::given(method("GET"))
            .and(path(at))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(fixture(name)))
            .mount(server)
            .await;
    }

    /// Serve a release's checksum manifest with the test key's signature over
    /// it, the way yt-dlp publishes `SHA2-256SUMS` next to `SHA2-256SUMS.sig`.
    async fn serve_signed_sums(server: &MockServer, tag: &str, sums: &str) {
        serve_fixture(server, format!("/dl/{tag}/SHA2-256SUMS"), sums).await;
        serve_fixture(
            server,
            format!("/dl/{tag}/SHA2-256SUMS.sig"),
            &format!("{sums}.sig"),
        )
        .await;
    }

    /// Serve the asset, but fail the test if it is ever fetched: a refused
    /// signature has to stop the update before the download starts.
    async fn forbid_download(server: &MockServer, tag: &str) {
        Mock::given(method("GET"))
            .and(path(format!("/dl/{tag}/yt-dlp_linux")))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(b"#!/bin/sh\necho 0\n".to_vec()),
            )
            .expect(0)
            .mount(server)
            .await;
    }

    /// Run an update that must be refused, check it wrote nothing at all into
    /// the update dir, and hand back the error.
    async fn refused_update(server: &MockServer) -> GoopError {
        let bundled = TempDir::new().unwrap();
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf());
        let err = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
            &[TEST_KEY],
        )
        .await
        .expect_err("the update must be refused");
        assert!(
            std::fs::read_dir(updates.path()).unwrap().next().is_none(),
            "a refused update must leave the update dir untouched"
        );
        err
    }

    // ---- the checksum file's signature ----------------------------------

    /// The key production trusts — yt-dlp's own `public.key` — loads under
    /// its pinned fingerprint and verifies a real release's manifest.
    #[test]
    fn pinned_key_verifies_a_real_release() {
        let verified = crate::signature::verify_detached(
            SIGNING_KEYS,
            &fixture("yt-dlp-2026.10.21.SHA2-256SUMS"),
            &fixture("yt-dlp-2026.10.21.SHA2-256SUMS.sig"),
            std::time::SystemTime::now(),
        );
        assert_eq!(verified, Ok(()));
    }

    // Tag 2099.01.01 is newer than any yt-dlp on PATH, which the resolver
    // falls back to when nothing is bundled, so these always reach the
    // signature check.

    #[tokio::test]
    async fn missing_signature_installs_nothing() {
        let server = MockServer::start().await;
        serve_latest(&server, "2099.01.01").await;
        serve_fixture(
            &server,
            "/dl/2099.01.01/SHA2-256SUMS".into(),
            "yt-dlp-newer.sums",
        )
        .await;
        forbid_download(&server, "2099.01.01").await;

        let err = refused_update(&server).await;
        assert!(err.to_string().contains("SHA2-256SUMS.sig"), "{err}");
    }

    #[tokio::test]
    async fn malformed_signature_installs_nothing() {
        let server = MockServer::start().await;
        serve_latest(&server, "2099.01.01").await;
        serve_fixture(
            &server,
            "/dl/2099.01.01/SHA2-256SUMS".into(),
            "yt-dlp-newer.sums",
        )
        .await;
        serve_fixture(
            &server,
            "/dl/2099.01.01/SHA2-256SUMS.sig".into(),
            "message.txt.asc",
        )
        .await;
        forbid_download(&server, "2099.01.01").await;

        let err = refused_update(&server).await;
        assert!(err.to_string().contains("malformed"), "{err}");
    }

    /// Exactly what a compromised release looks like: a manifest naming a
    /// different binary, next to a signature that is genuine — for some
    /// other manifest.
    #[tokio::test]
    async fn swapped_manifest_installs_nothing() {
        let server = MockServer::start().await;
        serve_latest(&server, "2099.01.01").await;
        serve_fixture(
            &server,
            "/dl/2099.01.01/SHA2-256SUMS".into(),
            "yt-dlp-broken.sums",
        )
        .await;
        serve_fixture(
            &server,
            "/dl/2099.01.01/SHA2-256SUMS.sig".into(),
            "yt-dlp-newer.sums.sig",
        )
        .await;
        forbid_download(&server, "2099.01.01").await;

        let err = refused_update(&server).await;
        assert!(err.to_string().contains("does not match"), "{err}");
    }

    /// Also what an upstream key rotation looks like, so the error names the
    /// key that signed.
    #[tokio::test]
    async fn signature_by_an_untrusted_key_installs_nothing() {
        let server = MockServer::start().await;
        serve_latest(&server, "2099.01.01").await;
        serve_fixture(
            &server,
            "/dl/2099.01.01/SHA2-256SUMS".into(),
            "yt-dlp-newer.sums",
        )
        .await;
        serve_fixture(
            &server,
            "/dl/2099.01.01/SHA2-256SUMS.sig".into(),
            "yt-dlp-newer.sums.other.sig",
        )
        .await;
        forbid_download(&server, "2099.01.01").await;

        let err = refused_update(&server).await;
        assert!(err.to_string().contains(OTHER_KEY_FINGERPRINT), "{err}");
    }

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
            &[TEST_KEY],
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
            &[TEST_KEY],
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
            &[TEST_KEY],
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
            &[TEST_KEY],
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
        serve_signed_sums(&server, "2099.01.01", "yt-dlp-newer.sums").await;
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
            &[TEST_KEY],
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
        serve_signed_sums(&server, "2026.07.04", "yt-dlp-newer.sums").await;
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
            .with_update_dir(updates.path().to_path_buf())
            .with_bundled_version("yt-dlp", "2026.06.09");

        let status = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
            &[TEST_KEY],
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
        assert_eq!(
            std::fs::read_to_string(updates.path().join("yt-dlp.version")).unwrap(),
            "2026.07.04",
            "the resolver only prefers an update whose version is recorded"
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
            .with_update_dir(updates.path().to_path_buf())
            .with_bundled_version("yt-dlp", "2026.06.09");

        let status = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
            &[TEST_KEY],
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
    /// both would read the stale version up front and both would install,
    /// through a temp file they share.
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
        serve_signed_sums(&server, "2026.07.04", "yt-dlp-newer.sums").await;
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
            .with_update_dir(updates.path().to_path_buf())
            .with_bundled_version("yt-dlp", "2026.06.09");

        let api = format!("{}/latest", server.uri());
        let dl = format!("{}/dl", server.uri());
        let (a, b) = tokio::join!(
            update_with(&resolver, &api, &dl, Some("yt-dlp_linux"), &[TEST_KEY]),
            update_with(&resolver, &api, &dl, Some("yt-dlp_linux"), &[TEST_KEY]),
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

    /// A download that won't execute (wrong arch, truncated, corrupt) must
    /// never replace the working copy.
    #[cfg(unix)]
    #[tokio::test]
    async fn update_with_refuses_a_binary_that_does_not_run() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"tag_name":"2026.07.04"}"#),
            )
            .mount(&server)
            .await;
        serve_signed_sums(&server, "2026.07.04", "yt-dlp-broken.sums").await;
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
            .with_update_dir(updates.path().to_path_buf())
            .with_bundled_version("yt-dlp", "2026.06.09");

        let err = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
            &[TEST_KEY],
        )
        .await
        .expect_err("a binary that won't run must error");
        assert!(matches!(err, GoopError::Queue(_)));
        assert!(
            !updates.path().join("yt-dlp").exists(),
            "a broken download must never reach the update dir"
        );
        assert!(!updates.path().join("yt-dlp.version").exists());
        assert_eq!(
            current_version(&resolver).await.as_deref(),
            Some("2026.06.09"),
            "the bundled copy must still be the one that runs"
        );
    }

    /// A compromised release can replay an older manifest, signature and
    /// binary — every one of them genuine — under a newer tag. Each check
    /// before the install passes; only the version the binary reports gives
    /// it away.
    #[cfg(unix)]
    #[tokio::test]
    async fn update_with_refuses_a_replayed_older_release() {
        let server = MockServer::start().await;
        serve_latest(&server, "2026.07.04").await;
        serve_signed_sums(&server, "2026.07.04", "yt-dlp-older.sums").await;
        Mock::given(method("GET"))
            .and(path("/dl/2026.07.04/yt-dlp_linux"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(b"#!/bin/sh\necho 2026.01.01\n".to_vec()),
            )
            .mount(&server)
            .await;

        let bundled = TempDir::new().unwrap();
        write_script(&bundled.path().join("yt-dlp"), "2026.06.09");
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf())
            .with_bundled_version("yt-dlp", "2026.06.09");

        let err = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
            &[TEST_KEY],
        )
        .await
        .expect_err("a downgrade must be refused");
        assert!(err.to_string().contains("2026.01.01"), "{err}");
        assert!(
            !updates.path().join("yt-dlp").exists(),
            "an older binary must never reach the update dir"
        );
        assert_eq!(
            current_version(&resolver).await.as_deref(),
            Some("2026.06.09")
        );
    }

    /// A refused download must not cost the user the update they already
    /// have. Vetting it after it had been renamed over the old one would
    /// leave only the bundled copy once the refusal removed it.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_download_keeps_the_previous_update() {
        let server = MockServer::start().await;
        serve_latest(&server, "2026.10.21").await;
        serve_signed_sums(&server, "2026.10.21", "yt-dlp-older.sums").await;
        Mock::given(method("GET"))
            .and(path("/dl/2026.10.21/yt-dlp_linux"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(b"#!/bin/sh\necho 2026.01.01\n".to_vec()),
            )
            .mount(&server)
            .await;

        let bundled = TempDir::new().unwrap();
        write_script(&bundled.path().join("yt-dlp"), "2026.06.09");
        let updates = TempDir::new().unwrap();
        write_script(&updates.path().join("yt-dlp"), "2026.10.01");
        // The resolver only runs an update whose version is recorded beside it.
        std::fs::write(updates.path().join("yt-dlp.version"), "2026.10.01").unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf())
            .with_bundled_version("yt-dlp", "2026.06.09");

        update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
            &[TEST_KEY],
        )
        .await
        .expect_err("a downgrade must be refused");
        assert_eq!(
            current_version(&resolver).await.as_deref(),
            Some("2026.10.01"),
            "the update installed before the refused one must still be the one that runs"
        );
    }

    /// A genuine release can also be replayed under a tag that is not its
    /// own, and still be newer than what is installed. The binary has to be
    /// the release the tag names.
    #[cfg(unix)]
    #[tokio::test]
    async fn update_with_refuses_a_binary_older_than_its_tag() {
        let server = MockServer::start().await;
        serve_latest(&server, "2026.10.21").await;
        serve_signed_sums(&server, "2026.10.21", "yt-dlp-newer.sums").await;
        Mock::given(method("GET"))
            .and(path("/dl/2026.10.21/yt-dlp_linux"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(b"#!/bin/sh\necho 2026.07.04\n".to_vec()),
            )
            .mount(&server)
            .await;

        let bundled = TempDir::new().unwrap();
        write_script(&bundled.path().join("yt-dlp"), "2026.06.09");
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf())
            .with_bundled_version("yt-dlp", "2026.06.09");

        let err = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
            &[TEST_KEY],
        )
        .await
        .expect_err("a binary older than its tag must be refused");
        assert!(err.to_string().contains("2026.10.21"), "{err}");
        assert!(!updates.path().join("yt-dlp").exists());
        assert!(!updates.path().join("yt-dlp.version").exists());
        assert_eq!(
            current_version(&resolver).await.as_deref(),
            Some("2026.06.09")
        );
    }

    /// The marker must be the version the binary itself reports, or the
    /// resolver would compare the bundled copy against a number the installed
    /// binary doesn't have. A binary may report a release newer than its tag
    /// and still be installed, so the marker can't simply be the tag.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_marker_records_the_version_the_binary_reports() {
        let server = MockServer::start().await;
        serve_latest(&server, "2026.07.01").await;
        serve_signed_sums(&server, "2026.07.01", "yt-dlp-newer.sums").await;
        Mock::given(method("GET"))
            .and(path("/dl/2026.07.01/yt-dlp_linux"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(b"#!/bin/sh\necho 2026.07.04\n".to_vec()),
            )
            .mount(&server)
            .await;

        let bundled = TempDir::new().unwrap();
        write_script(&bundled.path().join("yt-dlp"), "2026.06.09");
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf())
            .with_bundled_version("yt-dlp", "2026.06.09");

        let status = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
            &[TEST_KEY],
        )
        .await
        .expect("update ok");

        assert_eq!(status.new_version.as_deref(), Some("2026.07.04"));
        assert_eq!(
            std::fs::read_to_string(updates.path().join("yt-dlp.version")).unwrap(),
            "2026.07.04",
            "the marker must hold the version the binary reports, not its tag"
        );
        assert_eq!(
            current_version(&resolver).await.as_deref(),
            Some("2026.07.04")
        );
    }

    /// The bug a version-aware resolver fixes, seen from the updater: a copy
    /// self-updated before markers existed, older than the bundled yt-dlp,
    /// must neither run nor be reported as the current version.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stale_self_update_is_not_taken_for_the_current_version() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"tag_name":"2026.10.21"}"#),
            )
            .mount(&server)
            .await;
        // No download mock: the bundled copy is already the latest release.

        let bundled = TempDir::new().unwrap();
        write_script(&bundled.path().join("yt-dlp"), "2026.10.21");
        let updates = TempDir::new().unwrap();
        write_script(&updates.path().join("yt-dlp"), "2026.08.19");
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf())
            .with_bundled_version("yt-dlp", "2026.10.21");

        let status = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
            &[TEST_KEY],
        )
        .await
        .expect("ok");

        assert!(!status.attempted);
        assert_eq!(status.previous_version.as_deref(), Some("2026.10.21"));
        assert!(status.message.contains("up to date (2026.10.21)"));
    }

    /// The resolver would ignore an installed release that is no newer than
    /// the bundled copy, so the updater must not download one — here because
    /// the bundled binary won't run, which leaves no version to compare with.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_release_no_newer_than_the_bundled_copy_is_not_downloaded() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"tag_name":"2026.07.04"}"#),
            )
            .mount(&server)
            .await;
        // No download mocks: fetching the checksums would 404 and error.

        let bundled = TempDir::new().unwrap();
        std::fs::write(bundled.path().join("yt-dlp"), [0u8, 1, 2, 3]).unwrap();
        let updates = TempDir::new().unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf())
            .with_bundled_version("yt-dlp", "2026.07.04");

        let status = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
            &[TEST_KEY],
        )
        .await
        .expect("ok");

        assert!(!status.attempted);
        assert!(
            status
                .message
                .contains("not newer than the bundled 2026.07.04"),
            "{}",
            status.message
        );
        assert!(!updates.path().join("yt-dlp").exists());
    }

    /// With the bundled yt-dlp gone (quarantined by antivirus, say), an
    /// update to the very version Goop bundles is the repair, so it must be
    /// installed and used. An earlier, older update supplies the current
    /// version, which keeps the test independent of any yt-dlp on the
    /// machine's PATH; the release is 2026.07.04 because that is the stand-in
    /// the signed fixtures cover.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_missing_bundled_copy_is_replaced_by_the_same_release() {
        let server = MockServer::start().await;
        serve_latest(&server, "2026.07.04").await;
        serve_signed_sums(&server, "2026.07.04", "yt-dlp-newer.sums").await;
        Mock::given(method("GET"))
            .and(path("/dl/2026.07.04/yt-dlp_linux"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(b"#!/bin/sh\necho 2026.07.04\n".to_vec()),
            )
            .mount(&server)
            .await;

        let bundled = TempDir::new().unwrap(); // the bundled copy is gone
        let updates = TempDir::new().unwrap();
        write_script(&updates.path().join("yt-dlp"), "2026.06.09");
        std::fs::write(updates.path().join("yt-dlp.version"), "2026.06.09").unwrap();
        let resolver = BinaryResolver::new(bundled.path().to_path_buf())
            .with_update_dir(updates.path().to_path_buf())
            .with_bundled_version("yt-dlp", "2026.07.04");

        let status = update_with(
            &resolver,
            &format!("{}/latest", server.uri()),
            &format!("{}/dl", server.uri()),
            Some("yt-dlp_linux"),
            &[TEST_KEY],
        )
        .await
        .expect("update ok");

        assert!(status.attempted);
        assert_eq!(status.previous_version.as_deref(), Some("2026.06.09"));
        assert_eq!(status.new_version.as_deref(), Some("2026.07.04"));
        assert_eq!(
            resolver.resolve("yt-dlp").unwrap().path,
            updates.path().join("yt-dlp")
        );
    }
}
