//! Crash-safe, in-place metadata writing.
//!
//! The natural tagging workflow edits files in your library directly, but a
//! mid-write crash must never corrupt the original. Strategy: copy the source
//! into a temp file *in the same directory* (so the final rename stays on one
//! filesystem and is atomic), let `lofty` edit the temp, optionally stash a
//! `.bak`, then atomically rename the temp over the original. No `_original`
//! litter, no half-written files.

use crate::{audio, MetadataError};
use goop_core::{AudioTags, CoverArtOp};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Write audio tags + cover-art changes to `path` in place, crash-safely.
pub fn write_audio_in_place(
    path: &Path,
    tags: &AudioTags,
    cover_art: &CoverArtOp,
    backup: bool,
) -> Result<(), MetadataError> {
    if !path.is_file() {
        return Err(MetadataError::Unsupported(format!(
            "not a file: {}",
            path.display()
        )));
    }

    // Temp must share the target's directory so `persist` is a same-filesystem
    // (atomic) rename rather than a cross-device copy.
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    // Keep the original's extension on the temp: lofty determines the audio
    // format partly from the path extension, so an extensionless temp would
    // fail with "No format could be determined".
    let suffix = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let tmp = tempfile::Builder::new()
        .prefix(".goop-meta-")
        .suffix(&suffix)
        .tempfile_in(parent)
        .map_err(MetadataError::Io)?;

    // Seed the temp with the original's bytes, then edit the temp's tags.
    std::fs::copy(path, tmp.path()).map_err(MetadataError::Io)?;
    audio::write_tags(tmp.path(), tags, cover_art)?;

    // Carry the original's permissions onto the temp so the rename doesn't
    // silently tighten them (tempfiles are created 0600). Best-effort: a
    // filesystem that rejects the chmod shouldn't fail the whole write.
    if let Ok(meta) = std::fs::metadata(path) {
        if let Err(e) = std::fs::set_permissions(tmp.path(), meta.permissions()) {
            tracing::warn!(error = %e, path = %path.display(), "could not preserve permissions on metadata temp file");
        }
    }

    if backup {
        // Preserve the *earliest* backup: if a `.bak` already exists from a
        // prior edit, keep it (it reflects the true pre-goop original) rather
        // than clobbering it with an already-tagged copy.
        let bak = backup_path(path);
        if !bak.exists() {
            std::fs::copy(path, &bak).map_err(MetadataError::Io)?;
        }
    }

    tmp.persist(path).map_err(|e| MetadataError::Io(e.error))?;
    Ok(())
}

/// `song.mp3` -> `song.mp3.bak`. Suffix-append (not extension-replace) so the
/// original extension stays visible in the backup name.
fn backup_path(path: &Path) -> PathBuf {
    let mut name: OsString = path.as_os_str().to_os_string();
    name.push(".bak");
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_path_appends_suffix() {
        assert_eq!(
            backup_path(Path::new("/music/song.mp3")),
            PathBuf::from("/music/song.mp3.bak")
        );
    }
}
