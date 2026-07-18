use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

#[derive(Debug, Error)]
pub enum GoopError {
    #[error("sidecar binary not found: {0}")]
    SidecarMissing(String),
    /// `stderr` is RAW stderr from the subprocess. The dispatch fallback
    /// (`crates/goop-extractor/src/backend.rs::dispatch`) inspects this
    /// to decide whether to retry with the other extractor — so it must
    /// stay in its raw form here. User-facing rendering happens via
    /// `GoopError::user_message()` (see below) which applies
    /// `friendly_message` once at the boundary.
    #[error("subprocess failed: {binary}: {stderr}")]
    SubprocessFailed { binary: String, stderr: String },
    #[error("queue store error: {0}")]
    Queue(String),
    #[error("config error: {0}")]
    Config(String),
    #[error("cancelled")]
    Cancelled,
    /// Control-flow sibling of `Cancelled`: the job's pause signal fired
    /// and the worker stopped gracefully, keeping its partial files. The
    /// scheduler maps this to `JobState::Paused`; it must never be
    /// persisted as a job failure or cross the IPC boundary as one.
    #[error("paused")]
    Paused,
    /// Transient network failure eligible for automatic retry. Constructed
    /// where transport structure is still visible (reqwest error kinds,
    /// HTTP status codes) — classifying stringified errors after the fact
    /// is fragile. The message is the full human-readable description.
    #[error("network error: {0}")]
    Network(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
}

impl GoopError {
    /// Render this error as a single user-facing string. For
    /// `SubprocessFailed` this swaps the raw stderr for a friendly
    /// pattern match if one applies; everything else falls through to
    /// the standard `Display` impl.
    ///
    /// Use this at the boundary where the error reaches a human:
    /// IPC return values to the frontend, and `JobState::Error.message`
    /// when persisting terminal state. Internal dispatch logic that
    /// inspects stderr (e.g. the bidirectional fallback decision) must
    /// continue to use the raw `stderr` field on `SubprocessFailed` —
    /// applying `friendly_message` there would clobber the very tokens
    /// the matchers are looking for.
    pub fn user_message(&self) -> String {
        match self {
            Self::SubprocessFailed { binary, stderr } => {
                let body = friendly_message(stderr).unwrap_or_else(|| stderr.clone());
                format!("{binary}: {body}")
            }
            other => other.to_string(),
        }
    }
}

/// Serializable error surface for Tauri IPC.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "code", content = "message")]
pub enum IpcError {
    SidecarMissing(String),
    SubprocessFailed(String),
    Queue(String),
    Config(String),
    Cancelled,
    Unknown(String),
}

impl From<GoopError> for IpcError {
    fn from(e: GoopError) -> Self {
        match e {
            GoopError::SidecarMissing(x) => Self::SidecarMissing(x),
            GoopError::SubprocessFailed { binary, stderr } => {
                // Apply friendly_message at the boundary, not at the
                // wrapper level. The raw stderr is preserved on the
                // `GoopError` variant for any caller that still wants
                // to inspect it before crossing the IPC boundary.
                let body = friendly_message(&stderr).unwrap_or(stderr);
                Self::SubprocessFailed(format!("{binary}: {body}"))
            }
            GoopError::Queue(x) => Self::Queue(x),
            GoopError::Config(x) => Self::Config(x),
            GoopError::Cancelled => Self::Cancelled,
            // Defensive: Paused is scheduler control flow and should be
            // consumed before any IPC boundary. If it ever leaks, surface
            // it as a queue-domain message rather than "unknown".
            GoopError::Paused => Self::Queue("paused".into()),
            // Deliberately exhaustive from here — no wildcard, so adding
            // a GoopError variant forces an explicit decision about its
            // IPC shape instead of silently landing in Unknown.
            e @ GoopError::Network(_) => Self::Unknown(e.to_string()),
            e @ GoopError::Io(_) => Self::Unknown(e.to_string()),
            e @ GoopError::Serde(_) => Self::Unknown(e.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// Friendly stderr → user-facing message mapping.
//
// Both yt-dlp and gallery-dl emit verbose Python tracebacks and full URLs
// by default. None of that is useful to a Goop user. We pattern-match a
// small set of common failures and return a one-sentence replacement.
// Patterns are checked in order; the first match wins. Unmatched stderr
// falls back to the raw text (the caller decides how to render it).
// ---------------------------------------------------------------------------

const PATTERNS: &[(&str, &str)] = &[
    (
        "No video could be found in this tweet",
        "This tweet's video may require login. Try enabling \"Cookies from browser\" in Settings, or update yt-dlp from Settings if it's been a while.",
    ),
    (
        "Sign in to confirm your age",
        "This video requires age verification. Enable \"Cookies from browser\" in Settings to use your existing browser session.",
    ),
    (
        "Private video",
        "This video is private. Enable \"Cookies from browser\" in Settings if you have access through a logged-in account.",
    ),
    (
        "Login required",
        "This content requires login. Enable \"Cookies from browser\" in Settings to use your existing browser session.",
    ),
    (
        "account is suspended",
        "The account hosting this video is suspended.",
    ),
    (
        "members-only content",
        "This video is members-only. Enable \"Cookies from browser\" in Settings if you're a member.",
    ),
    (
        "Could not authenticate you",
        "The site rejected your cookies. Make sure you're logged in to that account in a regular (non-private) browser window, then close it and retry — yt-dlp can't read cookies from incognito sessions.",
    ),
    (
        "could not find login cookies",
        "yt-dlp couldn't find login cookies in the selected browser. Open the browser, log in to the site in a regular (non-private) window, close it, and try again.",
    ),
    (
        "No supported browsers found",
        "Goop couldn't read cookies from the selected browser. Make sure the browser is installed and you've granted the necessary permissions.",
    ),
    // Cookie-DB read failures — paired with `is_cookie_db_error` in the
    // extractor wrapper, which auto-retries without cookies. These
    // friendly strings are the backstop when the retry-without also fails
    // (URL genuinely needs cookies) so the user sees guidance instead of
    // raw stderr. Order: keep below `could not find login cookies` so the
    // more-specific pattern still wins. Keys narrowed to "cookie database"
    // (singular, matches "Could not copy {Browser} cookie database") and
    // "cookies database" (plural, matches "could not find {browser}
    // cookies database in <path>") so a hypothetical unrelated
    // "Could not copy file to ..." error doesn't show cookie guidance.
    (
        "cookie database",
        "Couldn't read your browser cookies. Quit the browser completely and try again, or pick a different browser in Settings — Goop will retry without cookies automatically.",
    ),
    (
        "cookies database",
        "Goop couldn't find that browser's cookies database. Make sure the browser is installed and you've used it at least once, or pick a different browser in Settings.",
    ),
    (
        "HTTP Error 429",
        "The site rate-limited the request. Wait a few minutes before trying again.",
    ),
    (
        "Too Many Requests",
        "The site rate-limited the request. Wait a few minutes before trying again.",
    ),
    (
        "Unsupported URL",
        "Neither extractor recognized this URL. Make sure the link points directly to a media page (post, album, video, or file).",
    ),
    (
        "Video unavailable",
        "This video is unavailable. It may have been removed, region-locked, or made private.",
    ),
    (
        "This live event will begin in",
        "This live stream hasn't started yet.",
    ),
    (
        "is geo restricted",
        "This video is region-locked and isn't available in your location.",
    ),
    // gallery-dl patterns. Order matters less here — these patterns
    // are unique to gallery-dl's traceback format and won't collide
    // with the yt-dlp ones above.
    (
        "No suitable extractor found",
        "Neither extractor recognized this URL. Make sure the link points directly to a media page (post, album, or file).",
    ),
    // 401/403, in BOTH dialects: yt-dlp writes "HTTP Error 403" (urllib,
    // space) and gallery-dl "HTTPError: 403" (requests, colon). The pairs
    // must stay in lockstep — keying only gallery-dl's dialect leaves the
    // yt-dlp case falling through to raw Python stderr, which is exactly
    // the output the commons.wikimedia.org report opened with. Both sit
    // BELOW the specific auth-wall patterns above so an age-gate or
    // private-video 403 still reports its actual cause.
    (
        "HTTPError: 401",
        "The site requires authentication. Enable \"Cookies from browser\" in Settings if you have a logged-in account.",
    ),
    (
        "HTTP Error 401",
        "The site requires authentication. Enable \"Cookies from browser\" in Settings if you have a logged-in account.",
    ),
    // A 403 only reaches the user after the other extractor has had its
    // turn too (see `warrants_other_extractor`), so a stale session is one
    // candidate rather than the diagnosis — name the other one instead of
    // sending a never-logged-in user off to re-log-in for nothing.
    (
        "HTTPError: 403",
        "The site blocked the request. Your cookies may have expired — re-log in to the site in your browser and try again — or the site may be blocking automated downloads.",
    ),
    (
        "HTTP Error 403",
        "The site blocked the request. Your cookies may have expired — re-log in to the site in your browser and try again — or the site may be blocking automated downloads.",
    ),
    (
        "HTTPError: 404",
        "The post or album is gone. The site may have removed it.",
    ),
    (
        "HTTPError: 429",
        "The site rate-limited the request. Wait a few minutes before trying again.",
    ),
    (
        "[Errno 2] No such file or directory",
        "Couldn't write to the output folder. Check that the folder exists and Goop has permission to write there.",
    ),
];

/// Return a friendly replacement message if `stderr` matches any known
/// failure pattern. Returns `None` when no pattern matches — the caller
/// decides whether to surface the raw text or its own fallback.
pub fn friendly_message(stderr: &str) -> Option<String> {
    PATTERNS
        .iter()
        .find(|(needle, _)| stderr.contains(needle))
        .map(|(_, friendly)| (*friendly).to_string())
}

/// True when the raw stderr indicates the chosen extractor doesn't
/// recognise the URL — the dispatch layer uses this to decide whether
/// to retry with the other extractor before surfacing the failure to
/// the user.
///
/// Both yt-dlp (`Unsupported URL`) and gallery-dl (`Unsupported URL` /
/// `No suitable extractor found`) signal this case. Because
/// `friendly_message` is now applied only at the IPC boundary, the
/// dispatch path always sees the raw stderr — no friendly-text matching
/// is necessary here.
pub fn is_no_matching_extractor(stderr: &str) -> bool {
    stderr.contains("Unsupported URL") || stderr.contains("No suitable extractor")
}

/// True when the raw stderr indicates the chosen extractor couldn't read
/// the user's browser cookie database — either the DB was locked /
/// encrypted (Chrome v127+ DPAPI on Windows, Firefox profile lock) or
/// the DB simply doesn't exist (browser not installed, non-default
/// profile path).
///
/// The wrapper layer uses this to decide whether to retry the spawn
/// without `--cookies-from-browser` before surfacing the failure. Only
/// matches when BOTH sentinel halves are present so unrelated errors
/// containing one half (e.g. "Could not copy file to disk", "could not
/// find login cookies") don't trigger spurious retries.
pub fn is_cookie_db_error(stderr: &str) -> bool {
    (stderr.contains("Could not copy") && stderr.contains("cookie database"))
        || (stderr.contains("could not find") && stderr.contains("cookies database"))
}

/// True when the raw stderr indicates the site refused the chosen
/// extractor (401/403) in a way the OTHER extractor might not hit.
///
/// A block is a statement about the request, not about the content: sites
/// routinely serve 403 to yt-dlp's user-agent while gallery-dl fetches the
/// same page fine (`commons.wikimedia.org` is the motivating case). So a
/// block earns a second attempt where a 404 would not.
///
/// The deny list is checked FIRST and wins, mirroring
/// `is_transient_network_stderr`. A 401/403 carrying one of those markers
/// is a real auth wall or a removed item — the other extractor hits the
/// same wall, so the second spawn buys nothing and its weaker verdict
/// ("No suitable extractor") would only mask the accurate message.
///
/// Only 401 and 403 qualify. 404/410 mean gone; 429 means a second spawn
/// seconds later just extends the ban; 5xx belongs to
/// `is_transient_network_stderr`. Unmatched stderr is NOT a block — the
/// cost of a false positive is a wasted spawn, of a false negative one
/// click of the Retry button.
pub fn is_access_blocked_stderr(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    const NOT_A_BLOCK: &[&str] = &[
        "private video",
        "sign in to confirm",
        "members-only",
        "login required",
        "account is suspended",
        "is geo restricted",
        "video unavailable",
        "could not authenticate you",
        // Cookie-DB read failures own their retry-without-cookies path in
        // the extractor wrapper (see `is_cookie_db_error`); treating them
        // as a block here would pre-empt it with a doomed cross-extractor
        // spawn that fails for the very same reason.
        "cookie database",
        "cookies database",
        "could not find login cookies",
    ];
    if NOT_A_BLOCK.iter().any(|p| s.contains(p)) {
        return false;
    }
    const BLOCKED: &[&str] = &[
        // yt-dlp / urllib style
        "http error 401",
        "http error 403",
        // gallery-dl / requests style
        "httperror: 401",
        "httperror: 403",
    ];
    BLOCKED.iter().any(|p| s.contains(p))
}

/// True when the primary extractor's failure earns a second attempt with
/// the OTHER extractor: either it didn't recognise the URL, or the site
/// blocked it. Every other failure — and all control flow — propagates on
/// the first attempt.
pub fn warrants_other_extractor(err: &GoopError) -> bool {
    match err {
        GoopError::SubprocessFailed { stderr, .. } => {
            is_no_matching_extractor(stderr) || is_access_blocked_stderr(stderr)
        }
        _ => false,
    }
}

/// What to do once BOTH extractors have failed.
#[derive(Debug)]
pub enum BothFailed {
    /// Neither extractor recognised the URL. That *pair* of verdicts is
    /// the signal it may be a plain file worth streaming directly.
    TryDirect,
    /// Show the user this error.
    Surface(GoopError),
}

/// Decide what the user sees when both extractors failed, and whether the
/// URL still deserves a direct-download attempt.
///
/// The rule: **a no-matching-extractor verdict never wins over a real
/// one.** "Unsupported URL" is the least informative thing either tool can
/// say, so a fallback that shrugs must not overwrite a primary that came
/// back with something concrete — otherwise a site that 403s yt-dlp and is
/// unknown to gallery-dl reports as "Neither extractor recognized this
/// URL", which is false.
///
/// Only two shrugs earn the direct downloader. A block is not evidence the
/// URL is a plain file, so it must not reach `direct` — which would
/// happily stream the site's 403 error page as if it were media.
pub fn both_failed(primary: GoopError, fallback: GoopError) -> BothFailed {
    match (shrugged(&primary), shrugged(&fallback)) {
        (true, true) => BothFailed::TryDirect,
        (_, true) => BothFailed::Surface(primary),
        _ => BothFailed::Surface(fallback),
    }
}

/// True when the extractor's only verdict was "I don't handle this URL".
///
/// `stderr` is an accumulated tail of a whole run rather than a single
/// line, so nothing structurally prevents a shrug marker and a block
/// marker sharing one blob. A block wins that tie: it is the more specific
/// claim, and mis-reading one as a shrug is the costlier direction — two
/// shrugs send the URL to the direct downloader, which would stream the
/// site's 403 error page as if it were media.
fn shrugged(err: &GoopError) -> bool {
    match err {
        GoopError::SubprocessFailed { stderr, .. } => {
            is_no_matching_extractor(stderr) && !is_access_blocked_stderr(stderr)
        }
        _ => false,
    }
}

/// True when raw yt-dlp / gallery-dl stderr indicates a transient network
/// failure worth an automatic retry (connection drop, timeout, 5xx).
///
/// The deny list is checked FIRST and wins: yt-dlp runs its own internal
/// retries, so a line like "HTTP Error 404 ... giving up after 10 retries"
/// carries both a permanent marker and a transient-looking one — it must
/// not retry. 429 is deliberately on the deny list for the subprocess
/// paths: by the time it escapes the extractor's internal retries it is a
/// real rate limit, and hammering the site again seconds later only
/// extends the ban. Unmatched stderr is NOT transient — a false-positive
/// retry on a permanent error wastes half a minute; a false negative
/// costs one click of the Retry button.
pub fn is_transient_network_stderr(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    const PERMANENT: &[&str] = &[
        // yt-dlp / urllib style
        "http error 400",
        "http error 401",
        "http error 403",
        "http error 404",
        "http error 410",
        "http error 429",
        // gallery-dl / requests style
        "httperror: 400",
        "httperror: 401",
        "httperror: 403",
        "httperror: 404",
        "httperror: 410",
        "httperror: 429",
        "too many requests",
        "unsupported url",
        "no suitable extractor",
        "video unavailable",
        "private video",
        "sign in to confirm",
        // TLS trust failures don't heal on retry
        "certificate",
    ];
    if PERMANENT.iter().any(|p| s.contains(p)) {
        return false;
    }
    const TRANSIENT: &[&str] = &[
        "http error 500",
        "http error 502",
        "http error 503",
        "http error 504",
        "httperror: 500",
        "httperror: 502",
        "httperror: 503",
        "httperror: 504",
        "connection reset",
        "connection refused",
        "connection aborted",
        // "The read operation timed out", "Connection timed out"
        "timed out",
        // EAI_AGAIN — the resolver itself says temporary
        "temporary failure in name resolution",
        // requests/urllib3 (gallery-dl)
        "remote end closed connection",
        "connection broken",
        "incompleteread",
        "max retries exceeded",
        // yt-dlp internal-retry exhaustion (permanent causes are caught
        // by the deny list above)
        "giving up after",
    ];
    TRANSIENT.iter().any(|p| s.contains(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goop_error_converts_to_ipc_error() {
        let ge = GoopError::SidecarMissing("ffmpeg".into());
        let ie: IpcError = ge.into();
        assert!(matches!(ie, IpcError::SidecarMissing(ref s) if s == "ffmpeg"));
    }

    #[test]
    fn ipc_error_serializes_with_tag() {
        let ie = IpcError::Cancelled;
        let s = serde_json::to_string(&ie).unwrap();
        assert_eq!(s, r#"{"code":"cancelled"}"#);
    }

    #[test]
    fn ipc_error_from_subprocess_failed_applies_friendly_message() {
        let ge = GoopError::SubprocessFailed {
            binary: "yt-dlp".into(),
            stderr: "ERROR: Sign in to confirm your age. blah".into(),
        };
        let ie: IpcError = ge.into();
        match ie {
            IpcError::SubprocessFailed(msg) => {
                assert!(msg.contains("yt-dlp:"));
                assert!(msg.contains("age verification"));
            }
            _ => panic!("expected SubprocessFailed"),
        }
    }

    #[test]
    fn ipc_error_from_subprocess_failed_falls_through_for_unknown() {
        let ge = GoopError::SubprocessFailed {
            binary: "yt-dlp".into(),
            stderr: "ERROR: random unmapped failure".into(),
        };
        let ie: IpcError = ge.into();
        match ie {
            IpcError::SubprocessFailed(msg) => {
                assert!(msg.contains("yt-dlp:"));
                assert!(msg.contains("random unmapped failure"));
            }
            _ => panic!("expected SubprocessFailed"),
        }
    }

    #[test]
    fn user_message_renders_friendly_for_known_pattern() {
        let ge = GoopError::SubprocessFailed {
            binary: "gallery-dl".into(),
            stderr: "[bunkr][album] HTTPError: 404 Not Found".into(),
        };
        let m = ge.user_message();
        assert!(m.starts_with("gallery-dl:"));
        assert!(m.contains("gone"));
    }

    #[test]
    fn user_message_falls_through_to_raw_for_unknown() {
        let ge = GoopError::SubprocessFailed {
            binary: "yt-dlp".into(),
            stderr: "weird unmapped error".into(),
        };
        let m = ge.user_message();
        assert!(m.starts_with("yt-dlp:"));
        assert!(m.contains("weird unmapped error"));
    }

    #[test]
    fn user_message_passes_through_non_subprocess_variants() {
        let ge = GoopError::Cancelled;
        assert_eq!(ge.user_message(), "cancelled");
    }

    #[test]
    fn friendly_message_returns_none_for_unknown() {
        assert!(friendly_message("ERROR: random unexpected failure").is_none());
    }

    #[test]
    fn friendly_message_de_branded_unsupported_url() {
        // Both yt-dlp and gallery-dl emit "Unsupported URL"; the friendly
        // text must not single out either extractor.
        let m = friendly_message("ERROR: Unsupported URL: https://example.com/foo").unwrap();
        assert!(m.contains("Neither extractor recognized"));
    }

    #[test]
    fn detects_no_matching_extractor_for_yt_dlp_raw_stderr() {
        assert!(is_no_matching_extractor(
            "ERROR: Unsupported URL: https://example.com"
        ));
    }

    #[test]
    fn detects_no_matching_extractor_for_gallery_dl_raw_stderr() {
        assert!(is_no_matching_extractor(
            "gallery-dl: error: No suitable extractor found for 'https://example.com'"
        ));
    }

    #[test]
    fn does_not_detect_no_matching_extractor_on_other_failures() {
        assert!(!is_no_matching_extractor("HTTPError: 404 Not Found"));
        assert!(!is_no_matching_extractor("Private video"));
        // Now that the friendly text isn't checked, the FRIENDLY string
        // for a no-matching-extractor case correctly does NOT trigger
        // the matcher — by design. Friendly text is applied only after
        // dispatch decisions have been made.
        assert!(!is_no_matching_extractor(
            "Neither extractor recognized this URL."
        ));
    }

    #[test]
    fn friendly_message_handles_chrome_cookie_copy_failure() {
        let stderr = "ERROR: Could not copy Chrome cookie database. \
                      See https://github.com/yt-dlp/yt-dlp/issues/7271 for more info";
        let m = friendly_message(stderr).expect("Chrome cookie-copy must map to friendly text");
        assert!(
            m.to_lowercase().contains("cookies"),
            "friendly text should mention cookies: {m}"
        );
        assert!(
            m.to_lowercase().contains("close") || m.to_lowercase().contains("quit"),
            "friendly text should tell the user to close/quit the browser: {m}"
        );
    }

    #[test]
    fn friendly_message_handles_browser_not_installed() {
        let stderr = r#"ERROR: could not find opera cookies database in "C:\Users\x\AppData\Roaming\Opera Software\Opera Stable""#;
        let m = friendly_message(stderr).expect("missing-cookies-DB must map to friendly text");
        assert!(
            m.to_lowercase().contains("install") || m.to_lowercase().contains("different browser"),
            "friendly text should mention install or different-browser: {m}"
        );
    }

    #[test]
    fn friendly_message_login_cookies_pattern_still_takes_precedence() {
        // Existing more-specific pattern must still win when "could not find"
        // appears next to "login cookies" — order matters in PATTERNS.
        let stderr = "ERROR: could not find login cookies in chrome";
        let m = friendly_message(stderr).expect("must match the existing pattern");
        assert!(
            m.contains("login cookies"),
            "more-specific pattern should win: {m}"
        );
    }

    #[test]
    fn is_cookie_db_error_matches_chrome_copy_failure() {
        let stderr = "ERROR: Could not copy Chrome cookie database. \
                      See https://github.com/yt-dlp/yt-dlp/issues/7271 for more info";
        assert!(is_cookie_db_error(stderr));
    }

    #[test]
    fn is_cookie_db_error_matches_missing_browser_db() {
        let stderr = r#"ERROR: could not find opera cookies database in "C:\Users\x\AppData\Roaming\Opera Software\Opera Stable""#;
        assert!(is_cookie_db_error(stderr));
    }

    #[test]
    fn is_cookie_db_error_matches_firefox_locked() {
        let stderr = "ERROR: Could not copy Firefox cookie database (profile locked)";
        assert!(is_cookie_db_error(stderr));
    }

    #[test]
    fn friendly_message_does_not_show_cookie_text_for_unrelated_could_not_copy() {
        // Regression: an earlier draft used "Could not copy" as the
        // pattern, which would have matched this hypothetical non-cookie
        // error and shown misleading guidance. The narrowed pattern
        // ("cookie database") avoids the false positive.
        let stderr = "ERROR: Could not copy file to output directory";
        assert!(
            friendly_message(stderr).is_none(),
            "non-cookie 'Could not copy' should not match cookie patterns"
        );
    }

    #[test]
    fn is_cookie_db_error_ignores_unrelated_errors() {
        assert!(!is_cookie_db_error(
            "ERROR: HTTP Error 429: Too Many Requests"
        ));
        assert!(!is_cookie_db_error("ERROR: Sign in to confirm your age"));
        assert!(!is_cookie_db_error(""));
        // Partial match must still require both halves of the key phrase
        assert!(!is_cookie_db_error("Could not copy file to disk"));
        assert!(!is_cookie_db_error(
            "could not find login cookies in chrome"
        ));
    }

    #[test]
    fn paused_maps_to_queue_ipc_error() {
        let ie: IpcError = GoopError::Paused.into();
        assert!(matches!(ie, IpcError::Queue(ref m) if m == "paused"));
    }

    #[test]
    fn network_error_user_message_includes_description() {
        let ge = GoopError::Network("direct download: stream: connection reset".into());
        assert!(ge.user_message().contains("connection reset"));
    }

    #[test]
    fn transient_stderr_matches_ytdlp_network_failures() {
        for s in [
            "ERROR: unable to download video data: HTTP Error 503: Service Unavailable",
            "ERROR: Unable to connect: <urlopen error [Errno 111] Connection refused>",
            "ERROR: The read operation timed out",
            "ERROR: [download] Got error: [Errno 54] Connection reset by peer",
            "ERROR: giving up after 10 retries",
            "ERROR: <urlopen error [Errno -3] Temporary failure in name resolution>",
        ] {
            assert!(is_transient_network_stderr(s), "should be transient: {s}");
        }
    }

    #[test]
    fn transient_stderr_matches_gallery_dl_requests_failures() {
        for s in [
            "ConnectionError: HTTPSConnectionPool(host='x.com', port=443): Max retries exceeded with url",
            "ChunkedEncodingError: Connection broken: IncompleteRead(512 bytes read)",
            "ReadTimeout: HTTPSConnectionPool(host='x.com', port=443): Read timed out. (read timeout=30)",
            "RemoteDisconnected: Remote end closed connection without response",
            "HTTPError: 502 Bad Gateway",
        ] {
            assert!(is_transient_network_stderr(s), "should be transient: {s}");
        }
    }

    /// Real yt-dlp stderr captured from
    /// `https://commons.wikimedia.org/wiki/Category:Kittens` — the site
    /// serves 403 to yt-dlp's user-agent while gallery-dl fetches the same
    /// page fine. Kept verbatim so the matcher is tested against the
    /// dialect yt-dlp actually emits, not a paraphrase of it.
    const COMMONS_403: &str = "ERROR: [generic] Unable to download webpage: \
         HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)";

    fn err(binary: &str, stderr: &str) -> GoopError {
        GoopError::SubprocessFailed {
            binary: binary.into(),
            stderr: stderr.into(),
        }
    }

    /// Which extractor's error `both_failed` chose to show.
    fn surfaced(v: BothFailed) -> String {
        match v {
            BothFailed::Surface(GoopError::SubprocessFailed { binary, .. }) => binary,
            other => panic!("expected Surface(SubprocessFailed), got {other:?}"),
        }
    }

    #[test]
    fn friendly_403_names_the_automated_block_not_just_cookies() {
        // By the time a 403 is surfaced, the other extractor has already had
        // its turn (see `warrants_other_extractor`), so the block is likely
        // aimed at automated access rather than at a stale session. Offering
        // ONLY the cookie remedy sends a user who was never logged in — the
        // commons.wikimedia.org case — off to re-log-in for nothing.
        //
        // Both dialects must be covered. yt-dlp writes "HTTP Error 403"
        // (space) and gallery-dl "HTTPError: 403"; testing only the latter
        // would leave the very stderr that motivated this fallback
        // (COMMONS_403) falling through to raw Python output.
        for stderr in [COMMONS_403, "[site][album] HTTPError: 403 Forbidden"] {
            let m = friendly_message(stderr)
                .unwrap_or_else(|| panic!("403 must map to friendly text: {stderr}"));
            let lc = m.to_lowercase();
            assert!(lc.contains("cookies"), "keep the cookie remedy: {m}");
            assert!(
                lc.contains("automated"),
                "must also name the automated-access block: {m}"
            );
        }
    }

    #[test]
    fn friendly_401_covers_both_dialects() {
        for stderr in [
            "ERROR: Unable to download webpage: HTTP Error 401: Unauthorized",
            "[site][album] HTTPError: 401 Unauthorized",
        ] {
            let m = friendly_message(stderr)
                .unwrap_or_else(|| panic!("401 must map to friendly text: {stderr}"));
            assert!(
                m.to_lowercase().contains("authentication") || m.to_lowercase().contains("log in"),
                "401 should point at authentication: {m}"
            );
        }
    }

    #[test]
    fn a_403_age_gate_still_reports_the_age_gate() {
        // Ordering guard: the specific auth-wall patterns sit above the
        // generic 401/403 entries, so a stderr carrying both must report the
        // actionable cause, not "the site blocked the request".
        let m = friendly_message("ERROR: Sign in to confirm your age. HTTP Error 403: Forbidden")
            .unwrap();
        assert!(m.contains("age verification"), "specific must win: {m}");
    }

    #[test]
    fn access_blocked_matches_both_extractor_dialects() {
        for s in [
            COMMONS_403,
            "ERROR: Unable to download webpage: HTTP Error 401: Unauthorized",
            "[site][album] HTTPError: 403 Forbidden",
            "[site][album] HTTPError: 401 Unauthorized",
        ] {
            assert!(is_access_blocked_stderr(s), "should be a block: {s}");
        }
    }

    #[test]
    fn access_blocked_deny_list_wins_over_the_status_code() {
        // Each of these is a real auth wall or a removed item: the other
        // extractor hits the same wall, so a second spawn buys nothing.
        for s in [
            "ERROR: Private video. Sign in if you've been granted access. HTTP Error 403",
            "ERROR: Sign in to confirm your age. HTTP Error 403: Forbidden",
            "ERROR: Join this channel to get access to members-only content (HTTP Error 403)",
            "ERROR: Login required. HTTP Error 401: Unauthorized",
            "ERROR: This account is suspended: HTTP Error 403",
            "ERROR: The uploader has not made this video available: is geo restricted (403)",
            "ERROR: [generic] Video unavailable. HTTP Error 403",
            "ERROR: Could not authenticate you. HTTPError: 401",
            // Cookie-DB failures own their retry-without-cookies path in the
            // extractor wrapper; hijacking them here would pre-empt it.
            "ERROR: Could not copy Chrome cookie database. HTTP Error 403",
            "ERROR: could not find opera cookies database in path. HTTP Error 403",
            "ERROR: could not find login cookies in chrome. HTTP Error 403",
        ] {
            assert!(!is_access_blocked_stderr(s), "should NOT be a block: {s}");
        }
    }

    #[test]
    fn access_blocked_ignores_statuses_a_second_spawn_cannot_help() {
        for s in [
            // Gone is gone, for either extractor.
            "ERROR: HTTP Error 404: Not Found",
            "HTTPError: 410 Gone",
            // A second spawn seconds later only extends a rate-limit ban.
            "ERROR: HTTP Error 429: Too Many Requests",
            "HTTPError: 429 Too Many Requests",
            // 5xx is is_transient_network_stderr's job, not ours.
            "ERROR: HTTP Error 503: Service Unavailable",
            "ERROR: Unsupported URL: https://example.com",
            "",
            "ERROR: random unmapped failure",
        ] {
            assert!(!is_access_blocked_stderr(s), "should NOT be a block: {s}");
        }
    }

    /// `dispatch_once`'s contract: the cross-extractor fallback cannot
    /// compound with `with_retry`'s transient retries, because their
    /// trigger sets are disjoint. Asserted rather than left as a comment —
    /// an overlap would silently multiply spawns (5 attempts x 2 extractors).
    #[test]
    fn access_blocked_is_disjoint_from_the_transient_and_unsupported_sets() {
        for s in [
            COMMONS_403,
            "ERROR: Unable to download webpage: HTTP Error 401: Unauthorized",
            "[site][album] HTTPError: 403 Forbidden",
            "[site][album] HTTPError: 401 Unauthorized",
        ] {
            assert!(is_access_blocked_stderr(s));
            assert!(
                !is_transient_network_stderr(s),
                "a block must never also be transient, or the fallback \
                 compounds with the retry budget: {s}"
            );
            assert!(
                !is_no_matching_extractor(s),
                "a block must never also read as no-matching-extractor: {s}"
            );
        }
    }

    #[test]
    fn warrants_other_extractor_covers_both_unsupported_and_blocked() {
        assert!(warrants_other_extractor(&err(
            "yt-dlp",
            "ERROR: Unsupported URL: https://example.com"
        )));
        assert!(warrants_other_extractor(&err("yt-dlp", COMMONS_403)));
    }

    #[test]
    fn warrants_other_extractor_refuses_everything_else() {
        // A permanent failure must not cost a second doomed spawn...
        assert!(!warrants_other_extractor(&err(
            "gallery-dl",
            "HTTPError: 404 Not Found"
        )));
        // ...and control flow must never "try harder": the user stopped it.
        assert!(!warrants_other_extractor(&GoopError::Cancelled));
        assert!(!warrants_other_extractor(&GoopError::Paused));
        // The direct downloader's typed errors are not an extractor verdict.
        assert!(!warrants_other_extractor(&GoopError::Network(
            "Unsupported URL inside a network message must not count".into()
        )));
    }

    #[test]
    fn a_blocked_blob_is_never_read_as_a_shrug() {
        // `stderr` is an accumulated tail of a whole run, not a single line,
        // so nothing structurally stops a shrug marker and a block marker
        // sharing one blob. If that happened, treating it as a shrug would
        // let two of them reach `TryDirect` — streaming the site's 403 page
        // as if it were media. Resolve the ambiguity toward the block: it is
        // the more specific claim, and being wrong costs only a message.
        let blob = "ERROR: Unsupported URL: https://x\nERROR: HTTP Error 403: Forbidden";
        let v = both_failed(err("yt-dlp", blob), err("gallery-dl", blob));
        assert!(
            !matches!(v, BothFailed::TryDirect),
            "a blob carrying a 403 must never reach the direct downloader"
        );
    }

    #[test]
    fn both_unsupported_earns_a_direct_download_attempt() {
        let v = both_failed(
            err(
                "yt-dlp",
                "ERROR: Unsupported URL: https://example.com/f.bin",
            ),
            err("gallery-dl", "No suitable extractor found for 'https://x'"),
        );
        assert!(
            matches!(v, BothFailed::TryDirect),
            "two 'unrecognised' verdicts are the plain-file signal"
        );
    }

    #[test]
    fn block_then_unsupported_surfaces_the_block() {
        // Regression for the bug this rule exists to prevent: a 403 whose
        // fallback doesn't know the site must NOT be reported to the user
        // as "Neither extractor recognized this URL" — that is false, and
        // strictly less useful than the 403 we actually got.
        let v = both_failed(
            err("yt-dlp", COMMONS_403),
            err("gallery-dl", "No suitable extractor found for 'https://x'"),
        );
        assert_eq!(surfaced(v), "yt-dlp");
    }

    #[test]
    fn block_then_unsupported_never_falls_through_to_direct() {
        // A 403 on a web page is not evidence the URL is a plain file, so
        // it must not reach the direct downloader (which would stream the
        // site's 403 error page as if it were media).
        let v = both_failed(
            err("yt-dlp", COMMONS_403),
            err("gallery-dl", "ERROR: Unsupported URL: https://x"),
        );
        assert!(!matches!(v, BothFailed::TryDirect));
    }

    #[test]
    fn unsupported_then_real_error_surfaces_the_fallbacks_verdict() {
        // Unchanged behaviour: the fallback actually engaged with the URL,
        // so its error describes it better than the primary's shrug.
        let v = both_failed(
            err("yt-dlp", "ERROR: Unsupported URL: https://example.com"),
            err("gallery-dl", "HTTPError: 401 Unauthorized"),
        );
        assert_eq!(surfaced(v), "gallery-dl");
    }

    #[test]
    fn two_real_errors_surface_the_fallbacks_verdict() {
        // Both engaged; neither shrugged. Keep today's behaviour (the last
        // error wins) rather than inventing a preference between them.
        let v = both_failed(
            err("yt-dlp", COMMONS_403),
            err("gallery-dl", "HTTPError: 401 Unauthorized"),
        );
        assert_eq!(surfaced(v), "gallery-dl");
    }

    #[test]
    fn transient_stderr_deny_list_wins() {
        for s in [
            // Permanent cause + transient-looking retry-exhaustion marker:
            // deny list must win.
            "ERROR: HTTP Error 404: Not Found. Giving up after 10 fragment retries",
            "ERROR: HTTP Error 429: Too Many Requests",
            "HTTPError: 429 Too Many Requests",
            "ERROR: Unsupported URL: https://example.com",
            "ERROR: Sign in to confirm your age",
            "ERROR: certificate verify failed: unable to get local issuer certificate",
            "ERROR: [generic] Video unavailable",
            "",
            "ERROR: random unmapped failure",
        ] {
            assert!(
                !is_transient_network_stderr(s),
                "should NOT be transient: {s}"
            );
        }
    }
}
