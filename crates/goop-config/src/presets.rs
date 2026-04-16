use goop_core::{CompressMode, GoopError, Preset, QualityPreset, ResolutionCap, TargetFormat};
use std::path::Path;

/// Load presets from the given JSON file. Returns an empty vec if the file
/// is missing — callers typically follow up with `seed_if_missing` to write
/// the built-in defaults.
pub fn load(path: &Path) -> Result<Vec<Preset>, GoopError> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let s = std::fs::read_to_string(path)?;
    serde_json::from_str(&s).map_err(|e| GoopError::Config(e.to_string()))
}

/// Atomic save via tempfile + rename so a crash mid-write can't leave a
/// half-written presets file behind.
pub fn save(path: &Path, presets: &[Preset]) -> Result<(), GoopError> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(presets)?;
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Upsert a preset by id. Replaces an existing entry in place (preserving
/// position) or appends a new one.
pub fn upsert(presets: Vec<Preset>, preset: Preset) -> Vec<Preset> {
    let mut out = presets;
    if let Some(idx) = out.iter().position(|p| p.id == preset.id) {
        out[idx] = preset;
    } else {
        out.push(preset);
    }
    out
}

/// Remove a preset by id. No-op if the id is absent.
pub fn remove(presets: Vec<Preset>, id: &str) -> Vec<Preset> {
    presets.into_iter().filter(|p| p.id != id).collect()
}

/// The 4 built-in presets seeded on first launch when `presets.json` is absent.
/// Covers the most common creator workflows (YouTube, Twitter/X, podcast, web
/// image). Users can rename them but not delete them.
pub fn builtin_defaults() -> Vec<Preset> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    vec![
        Preset {
            id: "builtin-youtube-upload".into(),
            name: "YouTube Upload".into(),
            target: TargetFormat::Mp4,
            quality_preset: Some(QualityPreset::Balanced),
            resolution_cap: Some(ResolutionCap::R1080p),
            compress_mode: None,
            is_builtin: true,
            created_at: now,
        },
        Preset {
            id: "builtin-twitter-video".into(),
            name: "Twitter/X Video".into(),
            target: TargetFormat::Mp4,
            quality_preset: Some(QualityPreset::Balanced),
            resolution_cap: Some(ResolutionCap::R720p),
            compress_mode: Some(CompressMode::TargetSizeBytes(200_000_000)),
            is_builtin: true,
            created_at: now,
        },
        Preset {
            id: "builtin-podcast-mp3".into(),
            name: "Podcast MP3".into(),
            target: TargetFormat::Mp3,
            quality_preset: None,
            resolution_cap: None,
            compress_mode: Some(CompressMode::Quality(75)),
            is_builtin: true,
            created_at: now,
        },
        Preset {
            id: "builtin-web-image".into(),
            name: "Web Image".into(),
            target: TargetFormat::Webp,
            quality_preset: None,
            resolution_cap: None,
            compress_mode: Some(CompressMode::Quality(85)),
            is_builtin: true,
            created_at: now,
        },
    ]
}

/// Read presets from `path`. If the file is missing, write the built-in
/// defaults to it and return them. This is the command layer's entry point
/// so `preset_list` seeds on first use.
pub fn load_or_seed(path: &Path) -> Result<Vec<Preset>, GoopError> {
    if path.exists() {
        return load(path);
    }
    let seed = builtin_defaults();
    save(path, &seed)?;
    Ok(seed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample(id: &str, name: &str) -> Preset {
        Preset {
            id: id.into(),
            name: name.into(),
            target: TargetFormat::Mp4,
            quality_preset: Some(QualityPreset::Balanced),
            resolution_cap: None,
            compress_mode: None,
            is_builtin: false,
            created_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn load_returns_empty_when_missing() {
        let d = tempdir().unwrap();
        let presets = load(&d.path().join("missing.json")).unwrap();
        assert!(presets.is_empty());
    }

    #[test]
    fn save_then_load_roundtrip() {
        let d = tempdir().unwrap();
        let p = d.path().join("presets.json");
        let presets = vec![sample("a", "A"), sample("b", "B")];
        save(&p, &presets).unwrap();
        let loaded = load(&p).unwrap();
        assert_eq!(loaded, presets);
    }

    #[test]
    fn upsert_replaces_by_id() {
        let mut presets = vec![sample("a", "First"), sample("b", "B")];
        let updated = sample("a", "First Renamed");
        presets = upsert(presets, updated);
        assert_eq!(presets.len(), 2);
        assert_eq!(presets[0].name, "First Renamed");
    }

    #[test]
    fn upsert_appends_when_new() {
        let presets = vec![sample("a", "A")];
        let after = upsert(presets, sample("b", "B"));
        assert_eq!(after.len(), 2);
        assert_eq!(after[1].id, "b");
    }

    #[test]
    fn remove_drops_matching_id() {
        let presets = vec![sample("a", "A"), sample("b", "B")];
        let after = remove(presets, "a");
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, "b");
    }

    #[test]
    fn remove_missing_id_is_noop() {
        let presets = vec![sample("a", "A")];
        let after = remove(presets.clone(), "zzz");
        assert_eq!(after, presets);
    }

    #[test]
    fn load_or_seed_writes_builtins_on_first_call() {
        let d = tempdir().unwrap();
        let p = d.path().join("presets.json");
        let seeded = load_or_seed(&p).unwrap();
        assert!(p.exists());
        assert_eq!(seeded.len(), 4);
        assert!(seeded.iter().all(|pr| pr.is_builtin));
        // Second call returns the same entries without re-seeding.
        let again = load_or_seed(&p).unwrap();
        assert_eq!(again, seeded);
    }

    #[test]
    fn builtin_defaults_have_unique_ids() {
        let defaults = builtin_defaults();
        let mut ids: Vec<&str> = defaults.iter().map(|p| p.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), defaults.len());
    }
}
