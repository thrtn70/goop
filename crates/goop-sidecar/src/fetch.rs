//! Shared plumbing for the goop-native sidecar updaters.
//!
//! Both updaters (`gallery_dl_update` against Codeberg/Gitea, `yt_dlp_update`
//! against GitHub) do the same four things: ask a releases API for the latest
//! tag, refuse a tag that doesn't look like a version, compare it against what
//! we already run, and stream the matching asset into the resolver's writable
//! update dir. Only the hosts, the asset names and the message prefix differ,
//! so the mechanics live here once and each updater supplies its own.
//!
//! Every function takes a `label` (`"yt-dlp update"`, `"gallery-dl update"`)
//! purely so the error text names the sidecar the user actually asked about.

use futures_util::StreamExt;
use goop_core::GoopError;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// Sidecar binaries run ~10–30 MB; generous ceiling so a slow link doesn't
/// hang the IPC handler forever.
pub(crate) const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const API_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CHECKSUM_MANIFEST_BYTES: usize = 64 * 1024;

/// Serializes every sidecar update in the process.
///
/// Each updater derives both its temp file and its destination from the tool
/// name inside one shared `data_dir()/bin`, so two overlapping updates of the
/// same tool write into the *same* temp path and then race to rename it. The
/// nastier half is what follows: the loser's post-download "does it run?"
/// check can fail and delete the binary the winner just installed and already
/// reported as a success, leaving the resolver silently back on the bundled
/// copy with nothing surfaced anywhere.
///
/// Updating is a rare cold path — a button click, or one background check a
/// day — so serializing all of it outright is cheaper than working out which
/// pairs happen to be safe to overlap.
static UPDATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Hold this for the whole check-download-verify-revert sequence.
pub(crate) async fn lock_updates() -> tokio::sync::MutexGuard<'static, ()> {
    UPDATE_LOCK.lock().await
}

/// Why a download did not end with a new binary in place.
#[derive(Debug)]
pub(crate) enum FetchError {
    /// Every byte arrived, but the final rename over `dest` was refused.
    /// Nothing was replaced and the temp file is gone either way;
    /// `likely_busy` says whether this looks like a destination that is
    /// merely in use right now (retry later) or something permanently wrong.
    RenameFailed {
        source: GoopError,
        likely_busy: bool,
    },
    /// Anything else — the transfer itself, or writing the temp file.
    Failed(GoopError),
}

impl From<FetchError> for GoopError {
    fn from(e: FetchError) -> Self {
        match e {
            FetchError::RenameFailed { source, .. } | FetchError::Failed(source) => source,
        }
    }
}

/// Whether a failed rename means "the destination is busy right now" rather
/// than something permanently wrong.
///
/// Only Windows produces this. It keeps a running executable's image open and
/// refuses to rename over it — `ERROR_ACCESS_DENIED` (5) or
/// `ERROR_SHARING_VIOLATION` (32). Unix renames over a running binary happily:
/// the old inode stays alive for as long as the running process holds it, so a
/// failed rename there is a genuine failure (a full disk, a read-only mount, a
/// destination that isn't a plain file) and must not be dressed up as "try
/// again later" — that would retry forever and never tell anyone.
fn looks_busy(err: &std::io::Error) -> bool {
    #[cfg(windows)]
    {
        matches!(err.raw_os_error(), Some(5) | Some(32))
    }
    #[cfg(not(windows))]
    {
        let _ = err;
        false
    }
}

/// Both APIs we talk to (GitHub releases, Codeberg/Gitea releases) return the
/// tag under the same key, so one shape covers both.
#[derive(Deserialize)]
struct LatestRelease {
    tag_name: String,
}

/// Fetch the latest release tag (`"v1.32.4"`, `"2026.07.04"`) from a
/// releases-latest endpoint. Parsed via serde_json from the response body so
/// we don't need the `reqwest/json` feature.
pub(crate) async fn fetch_latest_tag(
    client: &reqwest::Client,
    api_latest_url: &str,
    label: &str,
) -> Result<String, GoopError> {
    let resp = client
        .get(api_latest_url)
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|e| GoopError::Queue(format!("{label}: fetch latest release: {e}")))?;
    if !resp.status().is_success() {
        // A bare "HTTP 403" reads like the release is unavailable. Both hosts
        // we talk to answer an exhausted quota that way, so name the likely
        // cause — an update that could not be *checked* must never be mistaken
        // for an update that is not needed.
        let hint = if resp.status().as_u16() == 403 {
            " — the release API refused the request, usually a temporary rate limit"
        } else {
            ""
        };
        return Err(GoopError::Queue(format!(
            "{label}: HTTP {} from {api_latest_url}{hint}",
            resp.status()
        )));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| GoopError::Queue(format!("{label}: read release body: {e}")))?;
    let release: LatestRelease = serde_json::from_str(&body)
        .map_err(|e| GoopError::Queue(format!("{label}: parse release JSON: {e}")))?;
    if release.tag_name.trim().is_empty() {
        return Err(GoopError::Queue(format!(
            "{label}: release has an empty tag_name"
        )));
    }
    Ok(release.tag_name)
}

/// Return the SHA-256 bound to one exact filename in an upstream checksum
/// manifest. Both yt-dlp and gallery-dl publish the conventional
/// `<hex><whitespace><filename>` form. Ambiguous duplicates fail closed.
pub(crate) fn checksum_for_asset(manifest: &str, asset: &str) -> Option<String> {
    let mut found = None;
    for line in manifest.lines() {
        let mut fields = line.split_whitespace();
        let Some(digest) = fields.next() else {
            continue;
        };
        let Some(name) = fields.next() else {
            continue;
        };
        if fields.next().is_some() || name.trim_start_matches('*') != asset {
            continue;
        }
        if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        if found.is_some() {
            return None;
        }
        found = Some(digest.to_ascii_lowercase());
    }
    found
}

/// Fetch and parse the vendor's release checksum manifest before downloading
/// an executable. Missing, malformed, or ambiguous entries are errors.
pub(crate) async fn fetch_checksum(
    client: &reqwest::Client,
    checksum_url: &str,
    asset: &str,
    label: &str,
) -> Result<String, GoopError> {
    let resp = client
        .get(checksum_url)
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|e| GoopError::Queue(format!("{label}: fetch checksum manifest: {e}")))?;
    if !resp.status().is_success() {
        return Err(GoopError::Queue(format!(
            "{label}: HTTP {} from {checksum_url}",
            resp.status()
        )));
    }
    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| GoopError::Queue(format!("{label}: read checksum manifest: {e}")))?;
        if body.len().saturating_add(chunk.len()) > MAX_CHECKSUM_MANIFEST_BYTES {
            return Err(GoopError::Queue(format!(
                "{label}: checksum manifest is too large"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(body)
        .map_err(|e| GoopError::Queue(format!("{label}: checksum manifest is not UTF-8: {e}")))?;
    checksum_for_asset(&body, asset).ok_or_else(|| {
        GoopError::Queue(format!(
            "{label}: checksum manifest has no valid SHA-256 for {asset}"
        ))
    })
}

/// Stream `url` to `dest`, writing to a sibling temp file first and renaming
/// into place so a partial download never replaces a good binary. Sets the
/// executable bit on unix. Creates the parent dir if missing.
///
/// The payload is SHA-256 checked before the atomic rename. Callers obtain the
/// expected digest from the vendor's release manifest; the post-download
/// "does it run?" check remains a second, independent compatibility barrier.
pub(crate) async fn download_binary(
    client: &reqwest::Client,
    url: &str,
    expected_sha256: &str,
    dest: &Path,
    label: &str,
) -> Result<(), FetchError> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| FetchError::Failed(GoopError::Io(e)))?;
    }
    // `dest` is always `<update_dir>/<tool>[.exe]`, so it always has a file
    // name; the fallback only guards the theoretical root-path case.
    let file_name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("sidecar");
    let tmp = dest.with_file_name(format!("{file_name}.tmp-download"));

    let result = tokio::time::timeout(DOWNLOAD_TIMEOUT, async {
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| GoopError::Queue(format!("{label}: download: {e}")))?;
        if !resp.status().is_success() {
            return Err(GoopError::Queue(format!(
                "{label}: HTTP {} from {url}",
                resp.status()
            )));
        }
        let mut file = tokio::fs::File::create(&tmp).await.map_err(GoopError::Io)?;
        let mut stream = resp.bytes_stream();
        let mut hasher = Sha256::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| GoopError::Queue(format!("{label}: stream: {e}")))?;
            file.write_all(&chunk).await.map_err(GoopError::Io)?;
            hasher.update(&chunk);
        }
        file.flush().await.map_err(GoopError::Io)?;
        let actual = format!("{:x}", hasher.finalize());
        if actual != expected_sha256.to_ascii_lowercase() {
            return Err(GoopError::Queue(format!(
                "{label}: SHA-256 mismatch for {url}: expected {expected_sha256}, got {actual}"
            )));
        }
        Ok::<_, GoopError>(())
    })
    .await
    .map_err(|_| GoopError::Queue(format!("{label}: download timed out")));

    // Flatten timeout + inner result; clean up the temp file on any failure.
    if let Err(e) = result.and_then(|inner| inner) {
        remove_temp(&tmp, label).await;
        return Err(FetchError::Failed(e));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let apply = async {
            let mut perms = tokio::fs::metadata(&tmp).await?.permissions();
            perms.set_mode(0o755);
            tokio::fs::set_permissions(&tmp, perms).await
        };
        if let Err(e) = apply.await {
            remove_temp(&tmp, label).await;
            return Err(FetchError::Failed(GoopError::Io(e)));
        }
    }

    // The only step left is the swap. A refused rename is its own outcome:
    // the bytes are all here and nothing was damaged. Whether the caller may
    // treat that as "not now" depends on why it was refused — see `looks_busy`.
    if let Err(e) = tokio::fs::rename(&tmp, dest).await {
        remove_temp(&tmp, label).await;
        let likely_busy = looks_busy(&e);
        return Err(FetchError::RenameFailed {
            source: GoopError::Io(e),
            likely_busy,
        });
    }
    Ok(())
}

/// Best-effort temp cleanup. A leftover `.tmp-download` is harmless but the
/// resolver shares this directory, so don't leave litter next to the binaries.
async fn remove_temp(tmp: &Path, label: &str) {
    if let Err(e) = tokio::fs::remove_file(tmp).await {
        // Not an error worth propagating: the caller is already returning a
        // failure, and the file may simply never have been created.
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(
                "{label}: failed to remove partial download {}: {e}",
                tmp.display()
            );
        }
    }
}

/// Parse a dotted version (`"1.32.4"`, tag `"v1.32.4"`, or yt-dlp's bare date
/// `"2026.07.04"`) into its leading numeric components. Per component we keep
/// only the leading digits so a suffix like `"4-dev"` still contributes `4`;
/// parsing stops at the first component with no leading digits. Returns `None`
/// if there's no leading number at all.
pub(crate) fn parse_version(s: &str) -> Option<Vec<u64>> {
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
pub(crate) fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => cmp_versions(&l, &c) == std::cmp::Ordering::Greater,
        _ => false,
    }
}

/// Whether a release tag is safe to interpolate into the download URL. Real
/// tags look like `v1.32.4` or `2026.07.04`; we accept a conservative
/// version-token charset and forbid `..` so a spoofed `tag_name` can't perform
/// path traversal or otherwise reshape the URL.
pub(crate) fn is_safe_tag(tag: &str) -> bool {
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
    fn parse_version_handles_yt_dlp_bare_dates() {
        // yt-dlp tags releases by date, and zero-padded components must not
        // be read as octal or as strings — "09" is nine.
        assert_eq!(parse_version("2026.07.04"), Some(vec![2026, 7, 4]));
        assert_eq!(parse_version("2026.06.09"), Some(vec![2026, 6, 9]));
        // Nightly builds append a build stamp.
        assert_eq!(
            parse_version("2026.07.04.232303"),
            Some(vec![2026, 7, 4, 232303])
        );
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
    fn is_newer_orders_yt_dlp_dates() {
        // The shipped sidecar and the live release at the time of writing.
        assert!(is_newer("2026.07.04", "2026.06.09"));
        assert!(!is_newer("2026.06.09", "2026.07.04"));
        assert!(!is_newer("2026.07.04", "2026.07.04"));
        // A day/month rollover must not compare lexically: "2026.7.4" would
        // sort after "2026.12.1" as text, but not as numbers.
        assert!(is_newer("2026.12.01", "2026.07.04"));
    }

    #[test]
    fn is_safe_tag_accepts_versions_and_rejects_injection() {
        assert!(is_safe_tag("v1.32.4"));
        assert!(is_safe_tag("1.32.4"));
        assert!(is_safe_tag("v1.32.4-dev1"));
        assert!(is_safe_tag("2026.07.04"));
        assert!(!is_safe_tag(""));
        assert!(!is_safe_tag("../../evil"));
        assert!(!is_safe_tag("v1.0/../etc"));
        assert!(!is_safe_tag("v1..0")); // no ".."
        assert!(!is_safe_tag("v1.0 0")); // whitespace
        assert!(!is_safe_tag(&"9".repeat(40))); // over length cap
    }

    #[test]
    fn looks_busy_only_fires_for_windows_lock_errors() {
        use std::io::{Error, ErrorKind};
        // What Windows returns while the destination executable is still
        // running. On unix these codes are EIO and EPIPE and mean nothing of
        // the sort, which is exactly why the check is platform-gated.
        assert_eq!(looks_busy(&Error::from_raw_os_error(5)), cfg!(windows));
        assert_eq!(looks_busy(&Error::from_raw_os_error(32)), cfg!(windows));

        // Nothing else counts anywhere. A full disk or a destination that
        // isn't a plain file will never resolve itself by waiting, so calling
        // it "busy" would retry forever and never report the real problem.
        for e in [
            Error::from(ErrorKind::NotFound),
            Error::from(ErrorKind::AlreadyExists),
            Error::from(ErrorKind::InvalidInput),
            Error::from_raw_os_error(28), // ENOSPC / ERROR_* — not a lock
        ] {
            assert!(!looks_busy(&e), "{e:?} must not read as a busy destination");
        }
    }

    /// `UPDATE_LOCK` is process-wide and a dozen other acquisitions in this
    /// binary hold it across a mock download and a subprocess spawn, so no
    /// assertion here may rest on how *long* a step takes. Measured on the
    /// version that did: re-acquiring after a release took 0 ms with
    /// `--test-threads 1` and 3.7–7.2 s at 64 threads on a loaded machine,
    /// because that wait is other tests' queued updates draining rather than
    /// anything the lock is doing — a 5 s deadline there failed 7 runs in 14.
    /// Both halves below are ordering claims instead.
    #[tokio::test]
    async fn update_lock_excludes_a_second_holder() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let guard = lock_updates().await;

        // A second caller, queued behind the guard on purpose — the shape two
        // overlapping updates actually take. It reports back whether the
        // release had already happened by the time it got in.
        let released = Arc::new(AtomicBool::new(false));
        let mut second = tokio::spawn({
            let released = Arc::clone(&released);
            async move {
                let _guard = lock_updates().await;
                released.load(Ordering::SeqCst)
            }
        });

        // Exclusion. A deadline is sound on this half: it can only fail by the
        // second caller getting *through* while the guard is alive, so a slow
        // machine makes it less likely to fire, never more.
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut second)
                .await
                .is_err(),
            "a second update must not proceed while one is in flight"
        );

        released.store(true, Ordering::SeqCst);
        drop(guard);

        // Release. What makes this assertion true is the flag — the waiter got
        // in, and only after the guard went away. The ceiling is a backstop and
        // nothing else: `cargo test` has no per-test timeout, so a lock that
        // stopped releasing would otherwise hang the workspace run until CI's
        // own limit hours later instead of naming the test that broke. It sits
        // an order of magnitude above the 7.2 s worst case measured above, so
        // unlike the 5 s deadline it replaces, it is not what the test passing
        // depends on and must not be re-tuned as though it were.
        let reacquired = tokio::time::timeout(Duration::from_secs(60), second)
            .await
            .expect("the queued update never got in — the lock stopped releasing")
            .expect("the second holder panicked");
        assert!(
            reacquired,
            "the queued update must get in only once the guard is released"
        );
    }

    // ---- network primitives (mock server) -------------------------------

    #[tokio::test]
    async fn fetch_latest_tag_parses_release_json() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"tag_name":"v1.32.4","name":"gallery-dl 1.32.4"}"#),
            )
            .mount(&server)
            .await;
        let tag = fetch_latest_tag(
            &reqwest::Client::new(),
            &format!("{}/latest", server.uri()),
            "test update",
        )
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
        let err = fetch_latest_tag(
            &reqwest::Client::new(),
            &format!("{}/latest", server.uri()),
            "test update",
        )
        .await
        .expect_err("should error");
        assert!(matches!(err, GoopError::Queue(_)));
    }

    #[tokio::test]
    async fn fetch_latest_tag_errors_on_empty_tag() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"tag_name":"  "}"#))
            .mount(&server)
            .await;
        let err = fetch_latest_tag(
            &reqwest::Client::new(),
            &format!("{}/latest", server.uri()),
            "test update",
        )
        .await
        .expect_err("empty tag must error");
        assert!(matches!(err, GoopError::Queue(_)));
    }

    #[test]
    fn checksum_manifest_requires_an_exact_asset_name() {
        let manifest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  other\n\
                        bfdeaeb08cffb6a36438bcd12dda25417e3cdd36f1e7e482a2849d539225288b  asset\n";
        assert_eq!(
            checksum_for_asset(manifest, "asset").as_deref(),
            Some("bfdeaeb08cffb6a36438bcd12dda25417e3cdd36f1e7e482a2849d539225288b")
        );
        assert_eq!(checksum_for_asset(manifest, "missing"), None);
        assert_eq!(checksum_for_asset("not-a-hash  asset\n", "asset"), None);
    }

    #[tokio::test]
    async fn download_binary_writes_file_and_cleans_temp() {
        let server = MockServer::start().await;
        let payload = b"#!/bin/sh\necho hello\n".to_vec();
        Mock::given(method("GET"))
            .and(path("/dl/v1.0.0/asset"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(payload.clone()))
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let dest = dir.path().join("tool");
        download_binary(
            &reqwest::Client::new(),
            &format!("{}/dl/v1.0.0/asset", server.uri()),
            "bfdeaeb08cffb6a36438bcd12dda25417e3cdd36f1e7e482a2849d539225288b",
            &dest,
            "test update",
        )
        .await
        .expect("download ok");

        assert!(dest.is_file());
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
        assert!(
            !dir.path().join("tool.tmp-download").exists(),
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
            .and(path("/dl/v1.0.0/asset"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let dest = dir.path().join("tool");
        let err = download_binary(
            &reqwest::Client::new(),
            &format!("{}/dl/v1.0.0/asset", server.uri()),
            "bfdeaeb08cffb6a36438bcd12dda25417e3cdd36f1e7e482a2849d539225288b",
            &dest,
            "test update",
        )
        .await
        .expect_err("404 should error");
        assert!(matches!(err, FetchError::Failed(_)));
        assert!(!dest.exists());
        assert!(!dir.path().join("tool.tmp-download").exists());
    }

    /// A refused rename must be reported separately from a failed download —
    /// the bytes arrived, only the swap didn't — and must not leave the temp
    /// file behind. Provoked with a destination the OS refuses to rename onto
    /// (a non-empty directory). That is emphatically NOT a busy destination,
    /// so `likely_busy` must stay false and the caller must treat it as a real
    /// failure rather than something that will fix itself.
    #[tokio::test]
    async fn download_binary_reports_a_refused_rename_distinctly() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/dl/v1.0.0/asset"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"payload".to_vec()))
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let dest = dir.path().join("tool");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("occupied"), b"x").unwrap();

        let err = download_binary(
            &reqwest::Client::new(),
            &format!("{}/dl/v1.0.0/asset", server.uri()),
            "239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5",
            &dest,
            "test update",
        )
        .await
        .expect_err("rename onto a non-empty dir must fail");
        assert!(
            matches!(
                err,
                FetchError::RenameFailed {
                    likely_busy: false,
                    ..
                }
            ),
            "a rename onto a directory is a real failure, not a busy destination: {err:?}"
        );
        assert!(
            !dir.path().join("tool.tmp-download").exists(),
            "temp file must be cleaned up when the rename is refused"
        );
    }

    #[tokio::test]
    async fn download_binary_rejects_a_checksum_mismatch_before_rename() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/asset"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"payload".to_vec()))
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let dest = dir.path().join("tool");
        std::fs::write(&dest, b"known-good").unwrap();

        let err = download_binary(
            &reqwest::Client::new(),
            &format!("{}/asset", server.uri()),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            &dest,
            "test update",
        )
        .await
        .expect_err("mismatched payload must fail");

        assert!(matches!(err, FetchError::Failed(_)));
        assert_eq!(std::fs::read(&dest).unwrap(), b"known-good");
        assert!(!dir.path().join("tool.tmp-download").exists());
    }

    #[tokio::test]
    async fn checksum_manifest_rejects_an_oversized_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/SHA256SUMS"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![
                b'a';
                MAX_CHECKSUM_MANIFEST_BYTES
                    + 1
            ]))
            .mount(&server)
            .await;

        let err = fetch_checksum(
            &reqwest::Client::new(),
            &format!("{}/SHA256SUMS", server.uri()),
            "asset",
            "test update",
        )
        .await
        .expect_err("oversized checksum manifest must fail");

        assert!(err.to_string().contains("too large"));
    }
}
