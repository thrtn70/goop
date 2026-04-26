//! Map ugly yt-dlp stderr dumps to short, actionable user-facing messages.
//!
//! yt-dlp's default error output includes full URLs, internal extractor
//! paths, and Python-style tracebacks. None of that is useful to a Goop
//! user. We pattern-match a small set of common failures and return a
//! one-sentence replacement that hints at what the user can do — most often,
//! enable cookies-from-browser or update yt-dlp.
//!
//! Patterns are checked in order; the first match wins. Unmatched stderr
//! falls back to the raw text (the caller decides how to render it).

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
        "yt-dlp doesn't support this URL. Make sure the link points directly to a video page.",
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
];

/// Return a friendly replacement message if `stderr` matches any known
/// failure pattern. Returns `None` to indicate the caller should keep the
/// raw stderr.
pub fn friendly_message(stderr: &str) -> Option<String> {
    PATTERNS
        .iter()
        .find(|(needle, _)| stderr.contains(needle))
        .map(|(_, friendly)| (*friendly).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_no_video_in_tweet() {
        let stderr = "ERROR: [twitter] 1234567890: No video could be found in this tweet\n";
        let m = friendly_message(stderr).expect("should match");
        assert!(m.contains("Cookies from browser"));
        assert!(m.contains("login"));
    }

    #[test]
    fn maps_age_gate() {
        let stderr =
            "ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.";
        assert!(friendly_message(stderr)
            .unwrap()
            .contains("age verification"));
    }

    #[test]
    fn maps_private_video() {
        let stderr = "ERROR: [youtube] xyz: Private video. Sign in if you've been granted access.";
        assert!(friendly_message(stderr).unwrap().contains("private"));
    }

    #[test]
    fn maps_rate_limit() {
        let stderr = "ERROR: HTTP Error 429: Too Many Requests";
        // First match wins; HTTP Error 429 ranks above Too Many Requests in the table.
        assert!(friendly_message(stderr).unwrap().contains("rate-limited"));
    }

    #[test]
    fn maps_unsupported_url() {
        let stderr = "ERROR: Unsupported URL: https://example.com/foo";
        let m = friendly_message(stderr).unwrap();
        assert!(m.contains("yt-dlp doesn't support"));
    }

    #[test]
    fn maps_video_unavailable() {
        let stderr = "ERROR: [youtube] xyz: Video unavailable. This content isn't available.";
        let m = friendly_message(stderr).unwrap();
        assert!(m.contains("unavailable"));
    }

    #[test]
    fn maps_geo_restriction() {
        let stderr = "ERROR: This video is geo restricted to particular countries";
        assert!(friendly_message(stderr).unwrap().contains("region-locked"));
    }

    #[test]
    fn maps_authentication_failure() {
        let stderr =
            "ERROR: [twitter] 12345: Error(s) while querying API: Could not authenticate you";
        let m = friendly_message(stderr).expect("should match");
        assert!(m.contains("rejected your cookies"));
        assert!(m.contains("non-private"));
    }

    #[test]
    fn maps_missing_login_cookies() {
        let stderr = "ERROR: could not find login cookies for chrome";
        assert!(friendly_message(stderr).unwrap().contains("non-private"));
    }

    #[test]
    fn returns_none_for_unknown_errors() {
        let stderr = "ERROR: random unexpected failure with no known pattern";
        assert!(friendly_message(stderr).is_none());
    }

    #[test]
    fn matches_inside_multi_line_stderr() {
        let stderr = "[twitter] Extracting URL: https://x.com/foo/status/123\n\
             [twitter] 123: Downloading guest token\n\
             [twitter] 123: Downloading tweet API JSON\n\
             ERROR: [twitter] 123: No video could be found in this tweet\n";
        assert!(friendly_message(stderr).is_some());
    }
}
