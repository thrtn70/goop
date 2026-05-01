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
            other => Self::Unknown(other.to_string()),
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
    (
        "HTTPError: 401",
        "The site requires authentication. Enable \"Cookies from browser\" in Settings if you have a logged-in account.",
    ),
    (
        "HTTPError: 403",
        "The site blocked the request. Your cookies may have expired — re-log in to the site in your browser, then try again.",
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
            m.to_lowercase().contains("close")
                || m.to_lowercase().contains("quit"),
            "friendly text should tell the user to close/quit the browser: {m}"
        );
    }

    #[test]
    fn friendly_message_handles_browser_not_installed() {
        let stderr = r#"ERROR: could not find opera cookies database in "C:\Users\x\AppData\Roaming\Opera Software\Opera Stable""#;
        let m = friendly_message(stderr).expect("missing-cookies-DB must map to friendly text");
        assert!(
            m.to_lowercase().contains("install")
                || m.to_lowercase().contains("different browser"),
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
        assert!(!is_cookie_db_error("ERROR: HTTP Error 429: Too Many Requests"));
        assert!(!is_cookie_db_error("ERROR: Sign in to confirm your age"));
        assert!(!is_cookie_db_error(""));
        // Partial match must still require both halves of the key phrase
        assert!(!is_cookie_db_error("Could not copy file to disk"));
        assert!(!is_cookie_db_error(
            "could not find login cookies in chrome"
        ));
    }
}
