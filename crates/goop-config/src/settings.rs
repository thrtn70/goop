use goop_core::{path::expand, GoopError, HistoryViewMode};
use serde::{Deserialize, Serialize};
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    Light,
    Dark,
    #[default]
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct Settings {
    pub output_dir: String,
    pub theme: Theme,
    pub yt_dlp_last_update_ms: Option<i64>,
    pub extract_concurrency: usize,
    pub convert_concurrency: usize,
    #[serde(default = "default_auto_check_updates")]
    pub auto_check_updates: bool,
    #[serde(default)]
    pub dismissed_update_version: Option<String>,
    #[serde(default)]
    pub history_view_mode: HistoryViewMode,
    #[serde(default = "default_queue_sidebar_width")]
    pub queue_sidebar_width: u32,
    #[serde(default = "default_hw_acceleration_enabled")]
    pub hw_acceleration_enabled: bool,
    /// When set, every yt-dlp spawn (probe + download) is invoked with
    /// `--cookies-from-browser <name>`. Lets users download videos from
    /// sites that require login (Twitter, Instagram, etc.) by reusing
    /// their existing browser session. `None` = no cookies passed.
    #[serde(default)]
    pub cookies_from_browser: Option<String>,
}

/// yt-dlp's full list of supported browsers for `--cookies-from-browser`.
/// Anything not in this list is rejected at the settings boundary so a
/// stale config or future client can't smuggle arbitrary args into the
/// yt-dlp spawn.
pub const SUPPORTED_BROWSERS: &[&str] = &[
    "brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale",
];

pub fn is_supported_browser(name: &str) -> bool {
    SUPPORTED_BROWSERS.contains(&name)
}

fn default_auto_check_updates() -> bool {
    true
}

fn default_queue_sidebar_width() -> u32 {
    288
}

fn default_hw_acceleration_enabled() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            output_dir: goop_core::path::default_output_dir()
                .to_string_lossy()
                .into_owned(),
            theme: Theme::default(),
            yt_dlp_last_update_ms: None,
            extract_concurrency: (num_cpus::get() / 2).max(2),
            convert_concurrency: (num_cpus::get() / 4).max(1),
            auto_check_updates: true,
            dismissed_update_version: None,
            history_view_mode: HistoryViewMode::default(),
            queue_sidebar_width: default_queue_sidebar_width(),
            hw_acceleration_enabled: default_hw_acceleration_enabled(),
            cookies_from_browser: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct SettingsPatch {
    pub output_dir: Option<String>,
    pub theme: Option<Theme>,
    pub yt_dlp_last_update_ms: Option<i64>,
    pub extract_concurrency: Option<usize>,
    pub convert_concurrency: Option<usize>,
    pub auto_check_updates: Option<bool>,
    pub dismissed_update_version: Option<String>,
    pub history_view_mode: Option<HistoryViewMode>,
    pub queue_sidebar_width: Option<u32>,
    pub hw_acceleration_enabled: Option<bool>,
    /// Tri-state on the wire:
    /// - field absent → no change
    /// - `Some(Some("chrome"))` → set to a specific browser
    /// - `Some(None)` → clear (turn cookies off)
    pub cookies_from_browser: Option<Option<String>>,
}

pub fn load(path: &Path) -> Result<Settings, GoopError> {
    if !path.exists() {
        return Ok(Settings::default());
    }
    let s = std::fs::read_to_string(path)?;
    serde_json::from_str(&s).map_err(|e| GoopError::Config(e.to_string()))
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), GoopError> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let s = serde_json::to_string_pretty(settings)?;
    std::fs::write(path, s)?;
    Ok(())
}

pub fn apply_patch(current: &Settings, patch: SettingsPatch) -> Settings {
    let mut next = current.clone();
    if let Some(v) = patch.output_dir {
        next.output_dir = expand(&v).to_string_lossy().into_owned();
    }
    if let Some(v) = patch.theme {
        next.theme = v;
    }
    if let Some(v) = patch.yt_dlp_last_update_ms {
        next.yt_dlp_last_update_ms = Some(v);
    }
    if let Some(v) = patch.extract_concurrency {
        next.extract_concurrency = v.max(1);
    }
    if let Some(v) = patch.convert_concurrency {
        next.convert_concurrency = v.max(1);
    }
    if let Some(v) = patch.auto_check_updates {
        next.auto_check_updates = v;
    }
    if let Some(v) = patch.dismissed_update_version {
        next.dismissed_update_version = Some(v);
    }
    if let Some(v) = patch.history_view_mode {
        next.history_view_mode = v;
    }
    if let Some(v) = patch.queue_sidebar_width {
        // Clamp on the backend so any client (or stale settings file) can't
        // produce an unusably narrow or huge sidebar.
        next.queue_sidebar_width = v.clamp(240, 480);
    }
    if let Some(v) = patch.hw_acceleration_enabled {
        next.hw_acceleration_enabled = v;
    }
    if let Some(v) = patch.cookies_from_browser {
        // Reject unknown browser names so a malformed settings.json can't
        // sneak arbitrary strings into the yt-dlp argv. Treat unknown as
        // None (off) rather than rejecting the whole patch — defensive.
        next.cookies_from_browser = match v {
            Some(name) if is_supported_browser(&name) => Some(name),
            _ => None,
        };
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn load_defaults_when_missing() {
        let d = tempdir().unwrap();
        let s = load(&d.path().join("x.json")).unwrap();
        assert_eq!(s.theme, Theme::System);
    }

    #[test]
    fn save_then_load_roundtrip() {
        let d = tempdir().unwrap();
        let p = d.path().join("x.json");
        let s = Settings {
            theme: Theme::Dark,
            ..Settings::default()
        };
        save(&p, &s).unwrap();
        let loaded = load(&p).unwrap();
        assert_eq!(loaded, s);
    }

    #[test]
    fn apply_patch_updates_only_given_fields() {
        let base = Settings::default();
        let patched = apply_patch(
            &base,
            SettingsPatch {
                theme: Some(Theme::Dark),
                ..Default::default()
            },
        );
        assert_eq!(patched.theme, Theme::Dark);
        assert_eq!(patched.output_dir, base.output_dir);
    }
}
