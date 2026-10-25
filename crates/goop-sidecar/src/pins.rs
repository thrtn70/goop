//! Reads the sidecar version pins out of `scripts/fetch-sidecars.sh`.
//!
//! Shared by `build.rs`, which compiles the bundled yt-dlp and gallery-dl
//! versions into the crate, and by the tests that hold the compiled values to
//! the script.

/// The value of `var` in a line `VAR="value"`, if the script defines it
/// exactly once and the value looks like a version (`2026.10.21`, `v1.32.11`).
/// Anything else — no definition, two of them, or a value that is not a plain
/// version token — is `None`, so a malformed pin fails the build instead of
/// compiling in a version the resolver would compare against.
pub(crate) fn read_pin<'a>(script: &'a str, var: &str) -> Option<&'a str> {
    let prefix = format!("{var}=\"");
    let mut values = script
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix(&prefix)?.strip_suffix('"'));
    let value = values.next()?;
    (values.next().is_none() && is_version(value)).then_some(value)
}

/// Dot-separated numbers with an optional leading `v`, and nothing else.
fn is_version(value: &str) -> bool {
    let numbers = value.strip_prefix('v').unwrap_or(value);
    numbers
        .split('.')
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPT: &str = r#"#!/usr/bin/env bash
set -euo pipefail
# YT_DLP_VERSION="1999.01.01" is what a comment looks like
YT_DLP_VERSION="2026.10.21"
YT_DLP_WINDOWS_SHA256="33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555"
GALLERY_DL_VERSION="v1.32.11"
GALLERY_DL_BASE="https://codeberg.org/mikf/gallery-dl/releases/download/${GALLERY_DL_VERSION}"
"#;

    #[test]
    fn reads_each_pinned_version() {
        assert_eq!(read_pin(SCRIPT, "YT_DLP_VERSION"), Some("2026.10.21"));
        assert_eq!(read_pin(SCRIPT, "GALLERY_DL_VERSION"), Some("v1.32.11"));
    }

    /// Windows CI checks the script out with CRLF line endings.
    #[test]
    fn reads_pins_from_a_crlf_checkout() {
        let crlf = SCRIPT.replace('\n', "\r\n");
        assert_eq!(read_pin(&crlf, "YT_DLP_VERSION"), Some("2026.10.21"));
        assert_eq!(read_pin(&crlf, "GALLERY_DL_VERSION"), Some("v1.32.11"));
    }

    #[test]
    fn a_missing_pin_is_none() {
        assert_eq!(read_pin(SCRIPT, "MUPDF_VERSION"), None);
    }

    #[test]
    fn a_pin_defined_twice_is_none() {
        let twice = format!("{SCRIPT}YT_DLP_VERSION=\"2026.11.02\"\n");
        assert_eq!(read_pin(&twice, "YT_DLP_VERSION"), None);
    }

    #[test]
    fn a_value_that_is_not_a_version_is_none() {
        for value in [
            "",
            "latest",
            "${OTHER_VERSION}",
            "2026.10.21 2026.11.02",
            "../x",
        ] {
            let script = format!("YT_DLP_VERSION=\"{value}\"\n");
            assert_eq!(read_pin(&script, "YT_DLP_VERSION"), None, "{value:?}");
        }
    }
}
