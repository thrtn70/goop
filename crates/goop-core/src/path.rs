use std::path::PathBuf;

/// Expand `~` and env vars, return absolute path. Single source of truth for user-facing paths.
pub fn expand(raw: &str) -> PathBuf {
    let s = shellexpand_home(raw);
    PathBuf::from(s)
}

fn shellexpand_home(raw: &str) -> String {
    if let Some(stripped) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped).to_string_lossy().into_owned();
        }
    } else if raw == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().into_owned();
        }
    }
    raw.to_string()
}

pub fn default_output_dir() -> PathBuf {
    dirs::download_dir().unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Downloads")
    })
}

pub fn config_file() -> PathBuf {
    dirs::config_dir()
        .map(|d| d.join("goop").join("settings.json"))
        .unwrap_or_else(|| PathBuf::from("settings.json"))
}

pub fn presets_file() -> PathBuf {
    dirs::config_dir()
        .map(|d| d.join("goop").join("presets.json"))
        .unwrap_or_else(|| PathBuf::from("presets.json"))
}

pub fn data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    resolve_data_dir(
        base,
        cfg!(debug_assertions),
        std::env::var("GOOP_DATA_DIR").ok(),
    )
}

// Resolve the app-data directory. An explicit `GOOP_DATA_DIR` override wins;
// otherwise debug builds use `goop-dev` and release builds use `goop`, so a
// `tauri dev` build and the packaged app never share a queue.db.
fn resolve_data_dir(base: PathBuf, is_debug: bool, env_override: Option<String>) -> PathBuf {
    if let Some(dir) = env_override.filter(|s| !s.trim().is_empty()) {
        return PathBuf::from(dir);
    }
    base.join(if is_debug { "goop-dev" } else { "goop" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_tilde_resolves_to_home() {
        let out = expand("~/Downloads");
        let expected = dirs::home_dir().unwrap().join("Downloads");
        assert_eq!(out, expected);
    }

    #[test]
    fn expand_bare_tilde() {
        assert_eq!(expand("~"), dirs::home_dir().unwrap());
    }

    #[test]
    fn expand_absolute_passthrough() {
        assert_eq!(expand("/tmp/x"), PathBuf::from("/tmp/x"));
    }

    #[test]
    fn default_output_is_absolute() {
        assert!(default_output_dir().is_absolute());
    }

    #[test]
    fn resolve_data_dir_release_uses_goop() {
        let p = resolve_data_dir(PathBuf::from("/data"), false, None);
        assert_eq!(p, PathBuf::from("/data/goop"));
    }

    #[test]
    fn resolve_data_dir_debug_uses_goop_dev() {
        let p = resolve_data_dir(PathBuf::from("/data"), true, None);
        assert_eq!(p, PathBuf::from("/data/goop-dev"));
    }

    #[test]
    fn resolve_data_dir_env_override_wins_over_debug() {
        let p = resolve_data_dir(PathBuf::from("/data"), true, Some("/custom/dir".into()));
        assert_eq!(p, PathBuf::from("/custom/dir"));
    }

    #[test]
    fn resolve_data_dir_ignores_empty_env_override() {
        let p = resolve_data_dir(PathBuf::from("/data"), false, Some(String::new()));
        assert_eq!(p, PathBuf::from("/data/goop"));
    }
}
