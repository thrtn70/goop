//! GitHub-backed app self-update for Goop.
//!
//! Flow:
//! 1. `check` fetches `releases/latest` from GitHub, parses the tag, compares
//!    via semver, and returns `Some(UpdateInfo)` when a strictly newer release
//!    exists with an asset matching the current platform.
//! 2. `download` streams the matched asset to a temp file while invoking a
//!    progress callback; the command layer wires that callback to a Tauri
//!    event for the UI's progress bar.
//! 3. The command layer then calls `tauri-plugin-opener` with the temp path
//!    so the user can install/mount directly from inside Goop.
//!
//! Signing / silent install / rollback are explicitly out of scope for v0.1.7.

use futures_util::StreamExt;
use goop_core::UpdateInfo;
use reqwest::{Client, Url};
use serde::Deserialize;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

const GITHUB_LATEST_RELEASE_URL: &str = "https://api.github.com/repos/thrtn70/goop/releases/latest";
const GITHUB_RELEASES_PAGE_URL: &str = "https://github.com/thrtn70/goop/releases/latest";

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    published_at: String,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize, Clone)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

/// Fetch the latest release and compare with `current_version`. Returns
/// `Ok(None)` when the current version is already >= the latest, or when no
/// asset exists for the running platform.
pub async fn check(current_version: &str) -> anyhow::Result<Option<UpdateInfo>> {
    let client = build_check_client(current_version)?;
    let release: GhRelease = client
        .get(GITHUB_LATEST_RELEASE_URL)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let latest_raw = strip_v_prefix(&release.tag_name);
    let current = parse_semver(current_version)?;
    let latest = parse_semver(latest_raw)?;
    if latest <= current {
        return Ok(None);
    }

    let platform = current_platform();
    let Some(asset) = pick_asset(&release.assets, platform) else {
        // Release exists but has no matching asset; treat as "no update".
        return Ok(None);
    };

    Ok(Some(UpdateInfo {
        current_version: current_version.to_string(),
        latest_version: latest_raw.to_string(),
        download_url: asset.browser_download_url.clone(),
        asset_size: asset.size,
        release_notes: release.body.unwrap_or_default(),
        published_at: release.published_at,
    }))
}

/// Stream a URL to a temp file, invoking `on_progress(downloaded, total)` as
/// bytes arrive. Returns the path to the downloaded file on success. The
/// filename preserves the URL's suffix (`.dmg` / `.msi` / `.exe`) so the
/// opener plugin can dispatch to the right system handler.
pub async fn download<F>(
    url: &str,
    current_version: &str,
    on_progress: F,
) -> anyhow::Result<PathBuf>
where
    F: Fn(u64, u64) + Send + Sync,
{
    validate_download_url(url)?;
    let client = build_download_client(current_version)?;
    let resp = client.get(url).send().await?.error_for_status()?;
    let total = resp.content_length().unwrap_or(0);

    let filename = filename_from_url(url);
    let out_path = std::env::temp_dir().join(filename);
    let mut file = tokio::fs::File::create(&out_path).await?;
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        file.write_all(&bytes).await?;
        downloaded = downloaded.saturating_add(bytes.len() as u64);
        on_progress(downloaded, total);
    }
    file.flush().await?;
    Ok(out_path)
}

pub fn releases_page_url() -> &'static str {
    GITHUB_RELEASES_PAGE_URL
}

/// Client for the GitHub JSON metadata call. 15s total-request timeout is
/// fine here — the response is a few KB.
fn build_check_client(current_version: &str) -> anyhow::Result<Client> {
    Ok(Client::builder()
        .user_agent(format!("goop-updater/{current_version}"))
        .timeout(Duration::from_secs(15))
        .build()?)
}

/// Client for streaming the installer payload. A total-request timeout
/// would abort mid-download for large assets (a 110 MB .dmg can't finish
/// in 15s on most connections), so we only bound the connection phase
/// and the per-read idle window. The stream itself can run as long as
/// it needs.
fn build_download_client(current_version: &str) -> anyhow::Result<Client> {
    Ok(Client::builder()
        .user_agent(format!("goop-updater/{current_version}"))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()?)
}

fn strip_v_prefix(raw: &str) -> &str {
    raw.strip_prefix('v').unwrap_or(raw)
}

fn parse_semver(raw: &str) -> anyhow::Result<semver::Version> {
    Ok(semver::Version::parse(strip_v_prefix(raw))?)
}

fn filename_from_url(url: &str) -> String {
    url.rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("goop-update.bin")
        .to_string()
}

fn validate_download_url(raw: &str) -> anyhow::Result<()> {
    let url = Url::parse(raw)?;
    if url.scheme() != "https" {
        anyhow::bail!("update download URL must use https");
    }
    match url.host_str() {
        Some("github.com" | "objects.githubusercontent.com") => Ok(()),
        _ => anyhow::bail!("update download URL host is not trusted"),
    }
}

// ---------------------------------------------------------------------------
// Platform + asset matching
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacAarch64,
    MacX64,
    Windows,
}

fn current_platform() -> Platform {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Platform::MacAarch64
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        Platform::MacX64
    }
    #[cfg(target_os = "windows")]
    {
        Platform::Windows
    }
    // Linux is not a release target; we still need *some* return value so
    // the audit job's clippy compile passes. The updater is never invoked
    // on Linux in practice (the in-app updater UI is hidden by the build).
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Platform::MacAarch64
    }
}

fn pick_asset(assets: &[GhAsset], platform: Platform) -> Option<&GhAsset> {
    assets.iter().find(|a| asset_matches(&a.name, platform))
}

fn asset_matches(name: &str, platform: Platform) -> bool {
    let lower = name.to_lowercase();
    match platform {
        Platform::MacAarch64 => {
            lower.ends_with(".dmg")
                && (lower.contains("aarch64") || lower.contains("arm64") || lower.contains("apple"))
        }
        Platform::MacX64 => {
            lower.ends_with(".dmg") && (lower.contains("x86_64") || lower.contains("x64"))
        }
        Platform::Windows => lower.ends_with(".msi") || lower.ends_with(".exe"),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> GhAsset {
        GhAsset {
            name: name.into(),
            browser_download_url: format!("https://x/y/{name}"),
            size: 100,
        }
    }

    #[test]
    fn strip_v_prefix_handles_both_forms() {
        assert_eq!(strip_v_prefix("v0.1.7"), "0.1.7");
        assert_eq!(strip_v_prefix("0.1.7"), "0.1.7");
    }

    #[test]
    fn parse_semver_handles_v_prefix() {
        assert!(parse_semver("v0.1.7").is_ok());
        assert!(parse_semver("0.1.7").is_ok());
    }

    #[test]
    fn semver_comparison_catches_double_digit_patches() {
        let a = parse_semver("0.1.10").unwrap();
        let b = parse_semver("0.1.9").unwrap();
        assert!(a > b, "0.1.10 must compare greater than 0.1.9");
    }

    #[test]
    fn asset_matches_mac_aarch64() {
        assert!(asset_matches(
            "Goop_0.1.7_aarch64.dmg",
            Platform::MacAarch64
        ));
        assert!(asset_matches("goop_0.1.7_arm64.dmg", Platform::MacAarch64));
        assert!(!asset_matches("Goop_0.1.7_x64.dmg", Platform::MacAarch64));
        assert!(!asset_matches(
            "Goop_0.1.7_aarch64.zip",
            Platform::MacAarch64
        ));
    }

    #[test]
    fn asset_matches_mac_x64() {
        assert!(asset_matches("Goop_0.1.7_x64.dmg", Platform::MacX64));
        assert!(asset_matches("goop_0.1.7_x86_64.dmg", Platform::MacX64));
        assert!(!asset_matches("Goop_0.1.7_aarch64.dmg", Platform::MacX64));
    }

    #[test]
    fn asset_matches_windows() {
        assert!(asset_matches("Goop_0.1.7_x64.msi", Platform::Windows));
        assert!(asset_matches("Goop_0.1.7_setup.exe", Platform::Windows));
        assert!(!asset_matches("Goop_0.1.7_x64.dmg", Platform::Windows));
    }

    #[test]
    fn pick_asset_picks_first_match() {
        let assets = vec![
            asset("Goop_0.1.7_x64.dmg"),
            asset("Goop_0.1.7_aarch64.dmg"),
            asset("Goop_0.1.7_x64.msi"),
        ];
        assert_eq!(
            pick_asset(&assets, Platform::MacAarch64).unwrap().name,
            "Goop_0.1.7_aarch64.dmg"
        );
        assert_eq!(
            pick_asset(&assets, Platform::Windows).unwrap().name,
            "Goop_0.1.7_x64.msi"
        );
    }

    #[test]
    fn filename_from_url_preserves_extension() {
        assert_eq!(
            filename_from_url("https://github.com/x/y/releases/download/v0.1.7/Goop_0.1.7_x64.msi"),
            "Goop_0.1.7_x64.msi"
        );
        assert_eq!(
            filename_from_url("https://example.com/path/file.dmg"),
            "file.dmg"
        );
    }

    #[test]
    fn filename_from_url_falls_back_when_empty() {
        assert_eq!(filename_from_url("https://host/"), "goop-update.bin");
    }

    #[test]
    fn validates_update_download_hosts() {
        assert!(validate_download_url(
            "https://github.com/thrtn70/goop/releases/download/v0.1.8/Goop.msi"
        )
        .is_ok());
        assert!(validate_download_url(
            "https://objects.githubusercontent.com/github-production-release-asset"
        )
        .is_ok());
        assert!(
            validate_download_url("http://github.com/thrtn70/goop/releases/download/x").is_err()
        );
        assert!(validate_download_url("https://example.com/Goop.msi").is_err());
    }
}
