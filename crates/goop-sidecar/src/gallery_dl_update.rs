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
use crate::updater::{UpdateChecker, UpdateStatus};
use futures_util::StreamExt;
use goop_core::GoopError;
use serde::Deserialize;
use std::path::Path;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// Codeberg (Gitea) API endpoint for the latest stable release.
const CODEBERG_API_LATEST: &str =
    "https://codeberg.org/api/v1/repos/mikf/gallery-dl/releases/latest";
/// Base for release asset downloads: `<base>/<tag>/<asset>`.
const CODEBERG_DL_BASE: &str = "https://codeberg.org/mikf/gallery-dl/releases/download";
/// Shown on platforms with no upstream binary (macOS). Mirrors the message
/// used by `UpdateChecker::for_gallery_dl`.
const SHIPS_WITH_GOOP: &str = "gallery-dl ships with Goop and updates when you update Goop.";
/// gallery-dl binaries run ~10–15 MB; generous ceiling so a slow link doesn't
/// hang the IPC handler forever.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const API_TIMEOUT: Duration = Duration::from_secs(30);

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

    // One client for both the API lookup and the download (cold path, but
    // avoids a second DNS lookup + TLS handshake to the same host). Per-request
    // timeouts differ, so none is set globally here.
    let client = reqwest::Client::builder()
        .user_agent("goop")
        .build()
        .map_err(|e| GoopError::Queue(format!("gallery-dl update: http client: {e}")))?;

    let previous = current_version(resolver).await;
    let tag = fetch_latest_tag(&client, api_latest_url).await?;

    // `tag` comes from the API response and is interpolated into the asset URL
    // below; reject anything that isn't a plain version-ish token so a spoofed
    // or MITM'd response can't redirect the download or traverse the path.
    if !is_safe_tag(&tag) {
        return Err(GoopError::Queue(format!(
            "gallery-dl update: refusing suspicious release tag {tag:?}"
        )));
    }
    let latest = tag.trim_start_matches('v').to_string();

    // Only download when the upstream release is strictly newer than what we
    // already run. If the current version can't be determined, fall through
    // and (re)install.
    if let Some(prev) = &previous {
        if !is_newer(&latest, prev) {
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
    download_binary(&client, &url, &dest).await?;

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

#[derive(Deserialize)]
struct CodebergRelease {
    tag_name: String,
}

/// Fetch the latest release tag (e.g. `"v1.32.4"`) from the Codeberg/Gitea
/// API. Parsed via serde_json from the response body so we don't need the
/// `reqwest/json` feature.
async fn fetch_latest_tag(
    client: &reqwest::Client,
    api_latest_url: &str,
) -> Result<String, GoopError> {
    let resp = client
        .get(api_latest_url)
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|e| GoopError::Queue(format!("gallery-dl update: fetch latest release: {e}")))?;
    if !resp.status().is_success() {
        return Err(GoopError::Queue(format!(
            "gallery-dl update: HTTP {} from {api_latest_url}",
            resp.status()
        )));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| GoopError::Queue(format!("gallery-dl update: read release body: {e}")))?;
    let release: CodebergRelease = serde_json::from_str(&body)
        .map_err(|e| GoopError::Queue(format!("gallery-dl update: parse release JSON: {e}")))?;
    if release.tag_name.trim().is_empty() {
        return Err(GoopError::Queue(
            "gallery-dl update: release has an empty tag_name".into(),
        ));
    }
    Ok(release.tag_name)
}

/// Stream `url` to `dest`, writing to a sibling temp file first and renaming
/// into place so a partial download never replaces a good binary. Sets the
/// executable bit on unix. Creates the parent dir if missing.
///
/// No checksum/signature is verified here: the integrity barrier is HTTPS to a
/// pinned host (Codeberg) plus the post-download "does it run?" check in
/// `update_with` that reverts a binary which won't execute. This matches the
/// existing unverified-download posture of `tessdata::download_language` and
/// the app's ad-hoc (non-notarized) signing. gallery-dl publishes detached GPG
/// `.sig` files; verifying them would be stronger but needs the maintainer key
/// bundled + a PGP dependency — deferred as future hardening.
async fn download_binary(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
) -> Result<(), GoopError> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(GoopError::Io)?;
    }
    // `dest` is always `<update_dir>/gallery-dl[.exe]`, so it always has a file
    // name; the fallback only guards the theoretical root-path case.
    let file_name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("gallery-dl");
    let tmp = dest.with_file_name(format!("{file_name}.tmp-download"));

    let result = tokio::time::timeout(DOWNLOAD_TIMEOUT, async {
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| GoopError::Queue(format!("gallery-dl update: download: {e}")))?;
        if !resp.status().is_success() {
            return Err(GoopError::Queue(format!(
                "gallery-dl update: HTTP {} from {url}",
                resp.status()
            )));
        }
        let mut file = tokio::fs::File::create(&tmp).await.map_err(GoopError::Io)?;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|e| GoopError::Queue(format!("gallery-dl update: stream: {e}")))?;
            file.write_all(&chunk).await.map_err(GoopError::Io)?;
        }
        file.flush().await.map_err(GoopError::Io)?;
        Ok::<_, GoopError>(())
    })
    .await
    .map_err(|_| GoopError::Queue("gallery-dl update: download timed out".into()));

    // Flatten timeout + inner result; clean up the temp file on any failure.
    if let Err(e) = result.and_then(|inner| inner) {
        if let Err(rm) = tokio::fs::remove_file(&tmp).await {
            tracing::warn!(
                "gallery-dl update: failed to remove partial download {}: {rm}",
                tmp.display()
            );
        }
        return Err(e);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&tmp)
            .await
            .map_err(GoopError::Io)?
            .permissions();
        perms.set_mode(0o755);
        tokio::fs::set_permissions(&tmp, perms)
            .await
            .map_err(GoopError::Io)?;
    }

    tokio::fs::rename(&tmp, dest).await.map_err(GoopError::Io)?;
    Ok(())
}

/// Parse a dotted version (`"1.32.4"` or tag `"v1.32.4"`) into its leading
/// numeric components. Per component we keep only the leading digits so a
/// suffix like `"4-dev"` still contributes `4`; parsing stops at the first
/// component with no leading digits. Returns `None` if there's no leading
/// number at all.
fn parse_version(s: &str) -> Option<Vec<u64>> {
    let s = s.trim().trim_start_matches('v');
    let mut out = Vec::new();
    for part in s.split('.') {
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            break;
        }
        match digits.parse::<u64>() {
            Ok(n) => out.push(n),
            Err(_) => break,
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Compare two parsed versions, zero-padding the shorter (so `1.32` == `1.32.0`).
fn cmp_versions(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            std::cmp::Ordering::Equal => continue,
            ord => return ord,
        }
    }
    std::cmp::Ordering::Equal
}

/// True when `latest` is strictly newer than `current`. If either side can't
/// be parsed, returns `false` — we never auto-update on ambiguity.
fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => cmp_versions(&l, &c) == std::cmp::Ordering::Greater,
        _ => false,
    }
}

/// Whether a release tag is safe to interpolate into the download URL. Real
/// gallery-dl tags look like `v1.32.4`; we accept a conservative
/// version-token charset and forbid `..` so a spoofed `tag_name` can't perform
/// path traversal or otherwise reshape the URL.
fn is_safe_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 32
        && !tag.contains("..")
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
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

    #[test]
    fn parse_version_handles_tags_and_suffixes() {
        assert_eq!(parse_version("1.32.4"), Some(vec![1, 32, 4]));
        assert_eq!(parse_version("v1.32.4"), Some(vec![1, 32, 4]));
        assert_eq!(parse_version(" 1.32.10 "), Some(vec![1, 32, 10]));
        assert_eq!(parse_version("1.32"), Some(vec![1, 32]));
        assert_eq!(parse_version("1.32.4-dev"), Some(vec![1, 32, 4]));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("abc"), None);
        assert_eq!(parse_version("v"), None);
    }

    #[test]
    fn is_newer_compares_correctly() {
        assert!(is_newer("1.32.4", "1.32.0"));
        assert!(is_newer("1.33.0", "1.32.99"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(is_newer("1.32.10", "1.32.9")); // numeric, not lexical
        assert!(!is_newer("1.32.0", "1.32.4"));
        assert!(!is_newer("1.32.4", "1.32.4"));
        assert!(!is_newer("1.32", "1.32.0")); // equal via zero-pad
        assert!(!is_newer("garbage", "1.0.0")); // unparseable → no update
        assert!(!is_newer("1.0.0", "garbage"));
    }

    #[test]
    fn is_safe_tag_accepts_versions_and_rejects_injection() {
        assert!(is_safe_tag("v1.32.4"));
        assert!(is_safe_tag("1.32.4"));
        assert!(is_safe_tag("v1.32.4-dev1"));
        assert!(!is_safe_tag(""));
        assert!(!is_safe_tag("../../evil"));
        assert!(!is_safe_tag("v1.0/../etc"));
        assert!(!is_safe_tag("v1..0")); // no ".."
        assert!(!is_safe_tag("v1.0 0")); // whitespace
        assert!(!is_safe_tag(&"9".repeat(40))); // over length cap
    }

    // ---- network primitives (mock server) -------------------------------

    #[tokio::test]
    async fn fetch_latest_tag_parses_codeberg_json() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"tag_name":"v1.32.4","name":"gallery-dl 1.32.4"}"#),
            )
            .mount(&server)
            .await;
        let tag = fetch_latest_tag(&reqwest::Client::new(), &format!("{}/latest", server.uri()))
            .await
            .expect("tag");
        assert_eq!(tag, "v1.32.4");
    }

    #[tokio::test]
    async fn fetch_latest_tag_errors_on_http_failure() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let err = fetch_latest_tag(&reqwest::Client::new(), &format!("{}/latest", server.uri()))
            .await
            .expect_err("should error");
        assert!(matches!(err, GoopError::Queue(_)));
    }

    #[tokio::test]
    async fn download_binary_writes_file_and_cleans_temp() {
        let server = MockServer::start().await;
        let payload = b"#!/bin/sh\necho hello\n".to_vec();
        Mock::given(method("GET"))
            .and(path("/dl/v1.0.0/gallery-dl.bin"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(payload.clone()))
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let dest = dir.path().join("gallery-dl");
        download_binary(
            &reqwest::Client::new(),
            &format!("{}/dl/v1.0.0/gallery-dl.bin", server.uri()),
            &dest,
        )
        .await
        .expect("download ok");

        assert!(dest.is_file());
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
        assert!(
            !dir.path().join("gallery-dl.tmp-download").exists(),
            "temp file must be renamed away"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dest).unwrap().permissions().mode();
            assert!(mode & 0o111 != 0, "executable bit must be set on unix");
        }
    }

    #[tokio::test]
    async fn download_binary_errors_and_leaves_no_temp_on_404() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/dl/v1.0.0/gallery-dl.bin"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let dest = dir.path().join("gallery-dl");
        let err = download_binary(
            &reqwest::Client::new(),
            &format!("{}/dl/v1.0.0/gallery-dl.bin", server.uri()),
            &dest,
        )
        .await
        .expect_err("404 should error");
        assert!(matches!(err, GoopError::Queue(_)));
        assert!(!dest.exists());
        assert!(!dir.path().join("gallery-dl.tmp-download").exists());
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
