//! Tesseract language pack management. The `eng` pack ships bundled with
//! the installer; everything else downloads on demand from the
//! `tesseract-ocr/tessdata_fast` GitHub mirror.
//!
//! Search-path resolution: callers pass an ordered list of directories
//! (typically `[user_data_dir, bundled_resource_dir]`). The first dir
//! containing `<lang>.traineddata` wins so a user-downloaded pack always
//! overrides the bundled English file if both are present.

use futures_util::StreamExt;
use goop_core::GoopError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use ts_rs::TS;

/// Pinned tessdata_fast release tag. The 4.1.0 tag matches the trained-data
/// format that mutool/tesseract 5.x both consume. Bumping requires a
/// regression sweep against the OCR fixture corpus.
const TESSDATA_FAST_VER: &str = "4.1.0";

/// Base URL for tessdata_fast raw downloads. Each language file lives at
/// `<base>/<ver>/<code>.traineddata`.
const TESSDATA_FAST_BASE: &str = "https://github.com/tesseract-ocr/tessdata_fast/raw";

/// Download timeout for a single language pack fetch. tessdata_fast files
/// run 1–13 MB; 60 s covers slow connections without hanging the IPC
/// thread forever if the CDN edge stalls.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// Curated catalog of language packs surfaced in the UI. Sizes are
/// `tessdata_fast` byte counts (smaller than `tessdata` / `tessdata_best`),
/// measured against the 4.1.0 tag. Approximate to within a few percent
/// across releases. Extended on demand in follow-up patches.
const LANGUAGE_CATALOG: &[(&str, &str, u64)] = &[
    ("eng", "English", 4_113_088),
    ("ara", "Arabic", 1_396_374),
    ("ces", "Czech", 4_392_036),
    ("chi_sim", "Chinese (Simplified)", 2_350_426),
    ("chi_tra", "Chinese (Traditional)", 2_532_055),
    ("dan", "Danish", 3_281_268),
    ("deu", "German", 8_628_461),
    ("ell", "Greek", 2_369_002),
    ("fin", "Finnish", 5_473_606),
    ("fra", "French", 4_447_751),
    ("heb", "Hebrew", 2_158_339),
    ("hin", "Hindi", 2_186_855),
    ("hun", "Hungarian", 4_944_137),
    ("ind", "Indonesian", 1_809_220),
    ("ita", "Italian", 7_576_335),
    ("jpn", "Japanese", 2_298_188),
    ("kor", "Korean", 2_213_127),
    ("nld", "Dutch", 6_286_588),
    ("nor", "Norwegian", 3_336_842),
    ("pol", "Polish", 7_073_949),
    ("por", "Portuguese", 6_519_710),
    ("ron", "Romanian", 4_192_064),
    ("rus", "Russian", 3_996_580),
    ("spa", "Spanish", 7_390_117),
    ("swe", "Swedish", 4_192_842),
    ("tha", "Thai", 2_011_882),
    ("tur", "Turkish", 4_792_473),
    ("ukr", "Ukrainian", 3_055_889),
    ("vie", "Vietnamese", 1_829_511),
];

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../shared/types/")]
pub struct LanguagePack {
    /// Tesseract language code, e.g. `"eng"`, `"fra"`, `"chi_sim"`.
    pub code: String,
    /// Human-readable label for Settings → OCR Languages.
    pub display_name: String,
    /// Size in bytes. For installed packs this is the on-disk file size;
    /// for available-only packs this is the approximate catalog estimate.
    pub size_bytes: u64,
    /// True when `<code>.traineddata` exists in at least one search dir.
    pub installed: bool,
    /// True when the pack is bundled with the installer and cannot be
    /// removed (currently just `eng`). Bundled packs may also appear in
    /// the user data dir if they've been updated; the bundled flag tracks
    /// the catalog status, not the on-disk source.
    pub bundled: bool,
}

/// Full catalog of language packs available for download. Returns the
/// catalog with `installed: false` and `bundled` set from a fixed list;
/// callers merge this with `installed_languages` to compute UI state.
pub fn available_languages() -> Vec<LanguagePack> {
    LANGUAGE_CATALOG
        .iter()
        .map(|(code, name, size)| LanguagePack {
            code: (*code).into(),
            display_name: (*name).into(),
            size_bytes: *size,
            installed: false,
            bundled: *code == "eng",
        })
        .collect()
}

/// Scan all `tessdata_dirs` for `<code>.traineddata` files. Returns one
/// `LanguagePack` per unique code; earlier directories take precedence
/// (so a user-downloaded pack overrides a bundled one with the same code).
///
/// Codes not in the curated catalog still appear in the result with
/// `display_name` falling back to the bare code; this is how we surface
/// custom packs the user might drop in manually.
pub fn installed_languages(tessdata_dirs: &[&Path]) -> Result<Vec<LanguagePack>, GoopError> {
    let catalog: BTreeMap<&str, (&str, u64)> = LANGUAGE_CATALOG
        .iter()
        .map(|(code, name, size)| (*code, (*name, *size)))
        .collect();
    let mut seen: BTreeMap<String, LanguagePack> = BTreeMap::new();

    for dir in tessdata_dirs {
        if !dir.exists() {
            continue;
        }
        let read = std::fs::read_dir(dir).map_err(GoopError::Io)?;
        for entry in read {
            let entry = entry.map_err(GoopError::Io)?;
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(code) = name.strip_suffix(".traineddata") else {
                continue;
            };
            if seen.contains_key(code) {
                continue;
            }
            let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let (display_name, bundled) = match catalog.get(code) {
                Some((display, _)) => ((*display).to_string(), code == "eng"),
                None => (code.to_string(), false),
            };
            seen.insert(
                code.to_string(),
                LanguagePack {
                    code: code.to_string(),
                    display_name,
                    size_bytes,
                    installed: true,
                    bundled,
                },
            );
        }
    }
    Ok(seen.into_values().collect())
}

/// Find `<code>.traineddata` in the search dirs, returning the first match.
/// Caller passes the dirs in precedence order; typical use is
/// `[user_data_dir, bundled_resource_dir]` so user-downloaded packs win.
pub fn resolve_language_file(code: &str, search_dirs: &[&Path]) -> Option<PathBuf> {
    for dir in search_dirs {
        let candidate = dir.join(format!("{code}.traineddata"));
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Download `<code>.traineddata` from tessdata_fast into `dest_dir`,
/// streaming chunks to disk so we never hold the entire pack in RAM
/// (some packs run 10+ MB). Wraps the whole operation in a 60 s timeout
/// so a stalled CDN edge can't hang the IPC handler indefinitely.
/// Creates the dest dir if missing. Returns the path to the written file.
/// Errors map to `GoopError::Queue` with a human-readable message that
/// the frontend toast displays directly.
pub async fn download_language(code: &str, dest_dir: &Path) -> Result<PathBuf, GoopError> {
    tokio::fs::create_dir_all(dest_dir)
        .await
        .map_err(GoopError::Io)?;
    let url = format!("{TESSDATA_FAST_BASE}/{TESSDATA_FAST_VER}/{code}.traineddata");
    let dest_path = dest_dir.join(format!("{code}.traineddata"));

    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| GoopError::Queue(format!("download {code} client: {e}")))?;

    tokio::time::timeout(DOWNLOAD_TIMEOUT, async {
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| GoopError::Queue(format!("download {code}: {e}")))?;
        if !response.status().is_success() {
            return Err(GoopError::Queue(format!(
                "download {code}: HTTP {} from {url}",
                response.status()
            )));
        }
        let mut file = tokio::fs::File::create(&dest_path)
            .await
            .map_err(GoopError::Io)?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|e| GoopError::Queue(format!("download {code} stream: {e}")))?;
            file.write_all(&chunk).await.map_err(GoopError::Io)?;
        }
        file.flush().await.map_err(GoopError::Io)?;
        Ok::<_, GoopError>(())
    })
    .await
    .map_err(|_| GoopError::Queue(format!("download {code} timed out after 60s")))??;

    Ok(dest_path)
}

/// Remove `<code>.traineddata` from `dir`. Returns Ok(()) if the file was
/// removed or already absent. Only errors on actual I/O failure (permission
/// denied, etc.).
pub fn remove_language(code: &str, dir: &Path) -> Result<(), GoopError> {
    let path = dir.join(format!("{code}.traineddata"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(GoopError::Io)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn catalog_includes_eng_and_marks_it_bundled() {
        let langs = available_languages();
        let eng = langs.iter().find(|l| l.code == "eng").expect("eng present");
        assert!(eng.bundled, "eng must be flagged bundled");
        assert!(
            !eng.installed,
            "available_languages always reports installed=false"
        );
        assert_eq!(eng.display_name, "English");
        // Catalog covers a useful breadth of languages; lock the size.
        assert!(langs.len() >= 25, "catalog should include 25+ entries");
    }

    #[test]
    fn available_languages_other_than_eng_are_not_bundled() {
        let langs = available_languages();
        for lang in langs.iter().filter(|l| l.code != "eng") {
            assert!(
                !lang.bundled,
                "{} should not be marked bundled (only eng ships)",
                lang.code
            );
        }
    }

    #[test]
    fn installed_languages_returns_empty_when_no_dirs_exist() {
        let nonexistent = PathBuf::from("/this/path/does/not/exist");
        let result = installed_languages(&[nonexistent.as_path()]).expect("ok");
        assert!(result.is_empty());
    }

    #[test]
    fn installed_languages_lists_files_in_dir() {
        let tmp = TempDir::new().expect("tempdir");
        std::fs::write(tmp.path().join("eng.traineddata"), b"x").unwrap();
        std::fs::write(tmp.path().join("fra.traineddata"), b"yy").unwrap();
        std::fs::write(tmp.path().join("README"), b"ignored").unwrap(); // non-traineddata file
        let result = installed_languages(&[tmp.path()]).expect("ok");
        assert_eq!(result.len(), 2);
        let codes: Vec<&str> = result.iter().map(|p| p.code.as_str()).collect();
        assert!(codes.contains(&"eng"));
        assert!(codes.contains(&"fra"));
        let eng = result.iter().find(|p| p.code == "eng").unwrap();
        assert_eq!(eng.size_bytes, 1, "size reflects actual file size");
        assert!(eng.installed);
        assert!(eng.bundled);
    }

    #[test]
    fn installed_languages_first_dir_wins_on_duplicate_code() {
        let user_dir = TempDir::new().expect("tempdir");
        let bundled_dir = TempDir::new().expect("tempdir");
        std::fs::write(user_dir.path().join("eng.traineddata"), b"newer").unwrap();
        std::fs::write(bundled_dir.path().join("eng.traineddata"), b"older_xxx").unwrap();
        let result = installed_languages(&[user_dir.path(), bundled_dir.path()]).expect("ok");
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].size_bytes, 5,
            "user dir's file (size 5) should win over bundled (size 9)"
        );
    }

    #[test]
    fn installed_languages_handles_unknown_codes_with_fallback_display_name() {
        let tmp = TempDir::new().expect("tempdir");
        std::fs::write(tmp.path().join("xyz.traineddata"), b"x").unwrap();
        let result = installed_languages(&[tmp.path()]).expect("ok");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].code, "xyz");
        assert_eq!(
            result[0].display_name, "xyz",
            "unknown codes fall back to the bare code"
        );
        assert!(!result[0].bundled, "unknown codes are not bundled");
    }

    #[test]
    fn resolve_language_file_returns_first_match() {
        let user_dir = TempDir::new().expect("tempdir");
        let bundled_dir = TempDir::new().expect("tempdir");
        let bundled_file = bundled_dir.path().join("eng.traineddata");
        std::fs::write(&bundled_file, b"x").unwrap();
        // First search dir doesn't have the file → fall back to second
        let resolved = resolve_language_file("eng", &[user_dir.path(), bundled_dir.path()]);
        assert_eq!(resolved, Some(bundled_file));
    }

    #[test]
    fn resolve_language_file_returns_none_when_missing_everywhere() {
        let tmp = TempDir::new().expect("tempdir");
        let resolved = resolve_language_file("eng", &[tmp.path()]);
        assert_eq!(resolved, None);
    }

    #[test]
    fn remove_language_succeeds_on_existing_and_absent_files() {
        let tmp = TempDir::new().expect("tempdir");
        let path = tmp.path().join("fra.traineddata");
        std::fs::write(&path, b"x").unwrap();
        assert!(path.exists());
        remove_language("fra", tmp.path()).expect("remove existing ok");
        assert!(!path.exists());
        // Idempotent — removing absent file is fine.
        remove_language("fra", tmp.path()).expect("remove absent ok");
    }
}
