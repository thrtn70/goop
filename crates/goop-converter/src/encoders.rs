//! Hardware-accelerated encoder detection and selection.
//!
//! `ffmpeg -encoders` lists every codec compiled into the bundled binary.
//! At app startup we shell out once, parse the names, and remember which
//! GPU encoders are available. The conversion path can then swap a software
//! encoder (e.g. `libx264`) for the platform's preferred HW alternative
//! when the user opts in.
//!
//! The set of HW encoder names we look for is intentionally narrow — only
//! the families ffmpeg's official builds expose on macOS and Windows that
//! Goop targets:
//! - macOS: VideoToolbox (`h264_videotoolbox`, `hevc_videotoolbox`)
//! - Windows: NVENC (`h264_nvenc`), AMF (`h264_amf`), QSV (`h264_qsv`)

use goop_sidecar::BinaryResolver;
use std::collections::HashSet;
use tokio::process::Command;

/// Names we search for. Order within each platform tier matters for the
/// `preferred_h264()` lookup — the first one available wins.
const KNOWN_HW_ENCODERS: &[&str] = &[
    // macOS
    "h264_videotoolbox",
    "hevc_videotoolbox",
    // Windows — NVENC first (best perf when present), then QSV (broad Intel
    // support), then AMF (AMD).
    "h264_nvenc",
    "hevc_nvenc",
    "h264_qsv",
    "hevc_qsv",
    "h264_amf",
    "hevc_amf",
];

/// Names ranked by preference for the h.264 family. First-available wins.
const H264_PREFERENCE: &[&str] = &[
    "h264_videotoolbox", // macOS
    "h264_nvenc",        // NVIDIA
    "h264_qsv",          // Intel
    "h264_amf",          // AMD
];

/// Snapshot of HW encoder availability at the time of detection. Cheap to
/// clone; safe to share across worker tasks.
#[derive(Debug, Clone, Default)]
pub struct DetectedEncoders {
    available: HashSet<String>,
}

impl DetectedEncoders {
    /// Construct an empty set — used by tests and as the safe fallback when
    /// detection itself fails.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Build from a parsed list of encoder names (e.g. test fixtures).
    pub fn from_names<I, S>(iter: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            available: iter.into_iter().map(Into::into).collect(),
        }
    }

    pub fn is_available(&self, name: &str) -> bool {
        self.available.contains(name)
    }

    /// Best HW h.264 encoder available, or `None` if no HW codec was found.
    pub fn preferred_h264(&self) -> Option<&'static str> {
        H264_PREFERENCE
            .iter()
            .copied()
            .find(|n| self.available.contains(*n))
    }

    /// Number of recognised HW encoders found. Useful for telemetry / logs.
    pub fn count(&self) -> usize {
        self.available.len()
    }
}

/// Whether `name` is one of the encoder names we recognise as hardware.
pub fn is_hw_encoder(name: &str) -> bool {
    KNOWN_HW_ENCODERS.contains(&name)
}

/// Detect which HW encoders the bundled ffmpeg supports. Runs `ffmpeg -encoders`
/// once. On any error (binary missing, parse failure, timeout) returns an
/// empty set so the caller falls back transparently to software encoding.
pub async fn detect(resolver: &BinaryResolver) -> DetectedEncoders {
    let bin = match resolver.resolve("ffmpeg") {
        Ok(b) => b,
        Err(_) => return DetectedEncoders::empty(),
    };
    let out = match Command::new(&bin.path).arg("-encoders").output().await {
        Ok(o) => o,
        Err(_) => return DetectedEncoders::empty(),
    };
    if !out.status.success() {
        return DetectedEncoders::empty();
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    parse_encoders(&stdout)
}

/// Parse the stdout of `ffmpeg -encoders` and pluck out the names matching
/// `KNOWN_HW_ENCODERS`.
///
/// Each encoder line in ffmpeg's output looks like:
/// ` V....D h264_videotoolbox    VideoToolbox H.264 Encoder`
/// — six flag chars, a name, and a description. We split on whitespace and
/// take the column right after the flag block.
pub fn parse_encoders(stdout: &str) -> DetectedEncoders {
    let mut found = HashSet::new();
    for line in stdout.lines() {
        let trimmed = line.trim_start();
        // Encoder lines start with a 6-char flag block whose first char is
        // 'V' (video), 'A' (audio), or 'S' (subtitle). The header lines and
        // separators don't begin with letters, so this is a cheap filter.
        let first = match trimmed.chars().next() {
            Some(c) => c,
            None => continue,
        };
        if !matches!(first, 'V' | 'A' | 'S') {
            continue;
        }
        // Split into [flags, name, ...description].
        let mut parts = trimmed.split_whitespace();
        let _flags = parts.next();
        let name = match parts.next() {
            Some(n) => n,
            None => continue,
        };
        if KNOWN_HW_ENCODERS.contains(&name) {
            found.insert(name.to_string());
        }
    }
    DetectedEncoders { available: found }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_MAC_OUTPUT: &str = "\
Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ------
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 V....D hevc_videotoolbox    VideoToolbox H.265 Encoder (codec hevc)
 V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC encoder
 V..... libvpx-vp9           libvpx VP9
 A..... aac                  AAC (Advanced Audio Coding)
";

    const SAMPLE_WIN_OUTPUT: &str = "\
Encoders:
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D h264_qsv             H.264 / AVC / MPEG-4 AVC (Intel Quick Sync Video)
 V..... libx264              libx264 H.264
";

    #[test]
    fn parses_mac_output_with_videotoolbox() {
        let det = parse_encoders(SAMPLE_MAC_OUTPUT);
        assert!(det.is_available("h264_videotoolbox"));
        assert!(det.is_available("hevc_videotoolbox"));
        assert!(!det.is_available("h264_nvenc"));
        assert_eq!(det.preferred_h264(), Some("h264_videotoolbox"));
    }

    #[test]
    fn parses_win_output_prefers_nvenc_over_qsv() {
        let det = parse_encoders(SAMPLE_WIN_OUTPUT);
        assert!(det.is_available("h264_nvenc"));
        assert!(det.is_available("h264_qsv"));
        // NVENC ranks above QSV in H264_PREFERENCE.
        assert_eq!(det.preferred_h264(), Some("h264_nvenc"));
    }

    #[test]
    fn ignores_software_encoders() {
        let det = parse_encoders("V..... libx264 libx264 H.264 / AVC encoder");
        assert!(!det.is_available("libx264"));
        assert_eq!(det.count(), 0);
        assert_eq!(det.preferred_h264(), None);
    }

    #[test]
    fn empty_on_garbage_input() {
        let det = parse_encoders("not\nan\nffmpeg\nlisting");
        assert_eq!(det.count(), 0);
        assert_eq!(det.preferred_h264(), None);
    }

    #[test]
    fn is_hw_encoder_recognises_known_names() {
        assert!(is_hw_encoder("h264_videotoolbox"));
        assert!(is_hw_encoder("h264_nvenc"));
        assert!(is_hw_encoder("hevc_amf"));
        assert!(!is_hw_encoder("libx264"));
        assert!(!is_hw_encoder("aac"));
    }

    #[test]
    fn from_names_round_trip() {
        let det = DetectedEncoders::from_names(["h264_videotoolbox", "hevc_videotoolbox"]);
        assert_eq!(det.count(), 2);
        assert_eq!(det.preferred_h264(), Some("h264_videotoolbox"));
    }
}
