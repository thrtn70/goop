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
    resolve_config_path(
        dirs::config_dir(),
        std::env::var("GOOP_CONFIG_DIR").ok(),
        "settings.json",
    )
}

pub fn presets_file() -> PathBuf {
    resolve_config_path(
        dirs::config_dir(),
        std::env::var("GOOP_CONFIG_DIR").ok(),
        "presets.json",
    )
}

// An explicit directory contains the config files directly. Without it,
// preserve the OS config directory and bare-filename fallback exactly.
fn resolve_config_path(
    base: Option<PathBuf>,
    env_override: Option<String>,
    filename: &str,
) -> PathBuf {
    if let Some(dir) = env_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return PathBuf::from(dir).join(filename);
    }
    base.map(|d| d.join("goop").join(filename))
        .unwrap_or_else(|| PathBuf::from(filename))
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
    if let Some(dir) = env_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
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

    #[test]
    fn resolve_data_dir_trims_whitespace_from_env_override() {
        let p = resolve_data_dir(
            PathBuf::from("/data"),
            false,
            Some("  /custom/dir  ".into()),
        );
        assert_eq!(p, PathBuf::from("/custom/dir"));
    }

    #[test]
    fn resolve_data_dir_ignores_whitespace_only_env_override() {
        let p = resolve_data_dir(PathBuf::from("/data"), true, Some("   ".into()));
        assert_eq!(p, PathBuf::from("/data/goop-dev"));
    }

    #[test]
    fn resolve_config_path_absent_override_preserves_base_and_filenames() {
        let base = PathBuf::from("config-base");
        for filename in ["settings.json", "presets.json"] {
            assert_eq!(
                resolve_config_path(Some(base.clone()), None, filename),
                base.join("goop").join(filename)
            );
        }
    }

    #[test]
    fn resolve_config_path_missing_base_preserves_bare_filenames() {
        for filename in ["settings.json", "presets.json"] {
            let path = resolve_config_path(None, None, filename);
            assert_eq!(path.as_os_str(), std::ffi::OsStr::new(filename));
        }
    }

    #[test]
    fn resolve_config_path_ignores_blank_override() {
        for base in [Some(PathBuf::from("config-base")), None] {
            for filename in ["settings.json", "presets.json"] {
                let expected = base
                    .as_ref()
                    .map(|p| p.join("goop").join(filename))
                    .unwrap_or_else(|| PathBuf::from(filename));
                for blank in ["", " \t\n "] {
                    let path = resolve_config_path(base.clone(), Some(blank.into()), filename);
                    assert_eq!(path.as_os_str(), expected.as_os_str());
                }
            }
        }
    }

    #[test]
    fn resolve_config_path_override_is_exact_parent() {
        for base in [Some(PathBuf::from("config-base")), None] {
            for filename in ["settings.json", "presets.json"] {
                assert_eq!(
                    resolve_config_path(base.clone(), Some("/isolated/config".into()), filename),
                    PathBuf::from("/isolated/config").join(filename)
                );
            }
        }
    }

    #[test]
    fn resolve_config_path_trims_override() {
        for filename in ["settings.json", "presets.json"] {
            assert_eq!(
                resolve_config_path(None, Some("  /isolated/config files \t".into()), filename),
                PathBuf::from("/isolated/config files").join(filename)
            );
        }
    }

    #[test]
    fn resolve_config_path_relative_override_stays_literal() {
        for directory in ["relative/config", "~/config"] {
            for filename in ["settings.json", "presets.json"] {
                assert_eq!(
                    resolve_config_path(None, Some(directory.into()), filename),
                    PathBuf::from(directory).join(filename)
                );
            }
        }
    }
}
