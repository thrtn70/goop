use goop_core::album::AlbumRoot;
use goop_core::IpcError;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One handoff to Convert or Compress takes at most this many files (D-62).
pub const HANDOFF_MAX_FILES: usize = 200;

/// A finished result to hand off: a file, or an album folder with the
/// relative paths recorded when it was downloaded.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct HandoffSource {
    pub output_path: String,
    #[ts(optional)]
    pub files: Option<Vec<String>>,
}

/// The paths of one source that are still there and safe to add, and how
/// many of its files are not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct HandoffResolved {
    pub paths: Vec<String>,
    pub missing: u32,
}

/// Check each source again where it is now, at the moment of the handoff.
/// Album names come from the remote site, so every entry must still pass
/// the album check (`AlbumRoot::entry`). Nothing is read, moved or queued.
#[tauri::command]
pub async fn handoff_resolve(
    sources: Vec<HandoffSource>,
) -> Result<Vec<HandoffResolved>, IpcError> {
    tauri::async_runtime::spawn_blocking(move || resolve_sources(&sources))
        .await
        .map_err(|error| IpcError::Unknown(format!("handoff check failed: {error}")))?
}

fn resolve_sources(sources: &[HandoffSource]) -> Result<Vec<HandoffResolved>, IpcError> {
    let total: usize = sources
        .iter()
        .map(|source| source.files.as_ref().map_or(1, Vec::len))
        .sum();
    if total > HANDOFF_MAX_FILES {
        return Err(IpcError::Config(format!(
            "a handoff takes up to {HANDOFF_MAX_FILES} files, not {total}"
        )));
    }
    Ok(sources.iter().map(resolve_source).collect())
}

fn resolve_source(source: &HandoffSource) -> HandoffResolved {
    let base = goop_core::path::expand(&source.output_path);
    let paths: Vec<String> = match &source.files {
        None => std::fs::metadata(&base)
            .ok()
            .filter(std::fs::Metadata::is_file)
            .and_then(|_| base.to_str().map(str::to_string))
            .into_iter()
            .collect(),
        Some(files) => match AlbumRoot::open(&base) {
            None => Vec::new(),
            Some(root) => files
                .iter()
                .filter_map(|relative| root.entry(relative))
                .filter_map(|path| path.to_str().map(str::to_string))
                .collect(),
        },
    };
    let expected = source.files.as_ref().map_or(1, Vec::len);
    let missing = u32::try_from(expected - paths.len()).unwrap_or(u32::MAX);
    HandoffResolved { paths, missing }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &std::path::Path) -> HandoffSource {
        HandoffSource {
            output_path: path.to_str().unwrap().to_string(),
            files: None,
        }
    }

    fn album(path: &std::path::Path, files: &[&str]) -> HandoffSource {
        HandoffSource {
            output_path: path.to_str().unwrap().to_string(),
            files: Some(files.iter().map(|f| f.to_string()).collect()),
        }
    }

    fn text(path: std::path::PathBuf) -> String {
        path.to_str().unwrap().to_string()
    }

    #[test]
    fn a_file_result_resolves_when_it_is_still_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let movie = dir.path().join("movie.mp4");
        std::fs::write(&movie, b"x").unwrap();
        let resolved = resolve_sources(&[
            file(&movie),
            file(&dir.path().join("moved.mp4")),
            file(dir.path()),
        ])
        .unwrap();
        assert_eq!(
            resolved,
            vec![
                HandoffResolved {
                    paths: vec![text(movie)],
                    missing: 0
                },
                HandoffResolved {
                    paths: vec![],
                    missing: 1
                },
                HandoffResolved {
                    paths: vec![],
                    missing: 1
                },
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_album_keeps_only_entries_that_pass_the_album_check() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        std::fs::write(outside.path().join("secret.jpg"), b"x").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("linked")).unwrap();
        let name = outside.path().file_name().unwrap().to_str().unwrap();
        let escape = format!("../{name}/secret.jpg");
        let resolved = resolve_sources(&[album(
            dir.path(),
            &["a.jpg", "gone.jpg", "linked/secret.jpg", &escape],
        )])
        .unwrap();
        assert_eq!(
            resolved,
            vec![HandoffResolved {
                paths: vec![text(dir.path().join("a.jpg"))],
                missing: 3
            }]
        );
    }

    #[test]
    fn a_missing_album_folder_counts_every_entry_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let resolved =
            resolve_sources(&[album(&dir.path().join("gone"), &["a.jpg", "b.jpg"])]).unwrap();
        assert_eq!(
            resolved,
            vec![HandoffResolved {
                paths: vec![],
                missing: 2
            }]
        );
    }

    #[test]
    fn more_than_the_limit_in_one_handoff_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let names: Vec<String> = (0..HANDOFF_MAX_FILES).map(|i| format!("{i}.jpg")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        assert!(resolve_sources(&[album(dir.path(), &refs)]).is_ok());
        let over = [album(dir.path(), &refs), file(&dir.path().join("one.mp4"))];
        assert!(matches!(resolve_sources(&over), Err(IpcError::Config(_))));
    }
}
