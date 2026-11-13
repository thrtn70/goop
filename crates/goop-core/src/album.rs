use std::path::{Component, Path, PathBuf};

/// Longest relative path an album list keeps for one file.
pub const ALBUM_PATH_BYTES: usize = 1_024;

/// An album's output folder, for checking the relative paths recorded in
/// `JobResult.files`. Those names come from the remote site, so each one is
/// checked where the folder is, both when it is recorded and again when it
/// is handed to another tool.
pub struct AlbumRoot {
    base: PathBuf,
    resolved: PathBuf,
}

impl AlbumRoot {
    /// `None` when `base` is not an existing folder.
    pub fn open(base: &Path) -> Option<Self> {
        let resolved = std::fs::canonicalize(base).ok()?;
        resolved.is_dir().then(|| Self {
            base: base.to_path_buf(),
            resolved,
        })
    }

    /// `base` joined with `relative`, in the reported spelling, when every
    /// step below `base` is a real folder and the last a regular file, with
    /// no link at any step, and the file resolves inside `base`. On a
    /// case-insensitive volume the spelling can differ in case from the name
    /// on disk and still open the same file.
    pub fn entry(&self, relative: &str) -> Option<PathBuf> {
        if relative.is_empty() || relative.len() > ALBUM_PATH_BYTES {
            return None;
        }
        let relative = Path::new(relative);
        if !reached_without_links(&self.base, relative) {
            return None;
        }
        let path = self.base.join(relative);
        let resolved = std::fs::canonicalize(&path).ok()?;
        resolved.starts_with(&self.resolved).then_some(path)
    }
}

fn reached_without_links(base: &Path, relative: &Path) -> bool {
    let mut current = base.to_path_buf();
    let mut components = relative.components().peekable();
    if components.peek().is_none() {
        return false;
    }
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return false;
        };
        current.push(name);
        let Ok(meta) = std::fs::symlink_metadata(&current) else {
            return false;
        };
        let kind = meta.file_type();
        let expected = if components.peek().is_some() {
            kind.is_dir()
        } else {
            kind.is_file()
        };
        if !expected {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn album() -> (tempfile::TempDir, AlbumRoot) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("sub/b.png"), b"x").unwrap();
        let root = AlbumRoot::open(dir.path()).unwrap();
        (dir, root)
    }

    #[test]
    fn keeps_regular_files_inside_the_album_in_the_reported_spelling() {
        let (dir, root) = album();
        assert_eq!(root.entry("a.jpg"), Some(dir.path().join("a.jpg")));
        assert_eq!(root.entry("sub/b.png"), Some(dir.path().join("sub/b.png")));
    }

    #[test]
    fn leaves_out_missing_empty_folder_and_mid_path_file_entries() {
        let (_dir, root) = album();
        assert_eq!(root.entry("gone.jpg"), None);
        assert_eq!(root.entry(""), None);
        assert_eq!(root.entry("sub"), None);
        assert_eq!(root.entry("a.jpg/b.png"), None);
    }

    #[test]
    fn leaves_out_traversal_and_absolute_entries() {
        let (dir, root) = album();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.jpg"), b"x").unwrap();
        let name = outside.path().file_name().unwrap().to_str().unwrap();
        assert_eq!(root.entry(&format!("../{name}/secret.jpg")), None);
        assert_eq!(root.entry("sub/../a.jpg"), None);
        assert_eq!(root.entry("./a.jpg"), None);
        assert_eq!(
            root.entry(outside.path().join("secret.jpg").to_str().unwrap()),
            None
        );
        assert!(dir.path().join("a.jpg").exists());
    }

    #[test]
    fn leaves_out_an_entry_over_the_byte_limit() {
        let dir = tempfile::tempdir().unwrap();
        let root = AlbumRoot::open(dir.path()).unwrap();
        let long = "x".repeat(ALBUM_PATH_BYTES + 1);
        assert_eq!(root.entry(&long), None);
    }

    #[cfg(unix)]
    #[test]
    fn leaves_out_a_linked_file_and_a_file_in_a_linked_folder() {
        let (dir, root) = album();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.jpg"), b"x").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.jpg"),
            dir.path().join("link.jpg"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("linked")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("a.jpg"), dir.path().join("inner.jpg")).unwrap();
        assert_eq!(root.entry("link.jpg"), None);
        assert_eq!(root.entry("linked/secret.jpg"), None);
        assert_eq!(root.entry("inner.jpg"), None);
    }

    #[cfg(unix)]
    #[test]
    fn an_album_folder_reached_through_a_link_still_lists_its_files() {
        let (dir, _root) = album();
        let holder = tempfile::tempdir().unwrap();
        let alias = holder.path().join("alias");
        std::os::unix::fs::symlink(dir.path(), &alias).unwrap();
        let root = AlbumRoot::open(&alias).unwrap();
        assert_eq!(root.entry("a.jpg"), Some(alias.join("a.jpg")));
    }

    #[test]
    fn keeps_an_entry_reported_in_another_letter_case() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("MiXeD.JPG"), b"x").unwrap();
        if !dir.path().join("mixed.jpg").exists() {
            return; // a case-sensitive volume: the reported spelling names no file
        }
        let root = AlbumRoot::open(dir.path()).unwrap();
        assert_eq!(root.entry("mixed.jpg"), Some(dir.path().join("mixed.jpg")));
    }

    #[test]
    fn a_missing_or_file_root_opens_nothing() {
        let (dir, _root) = album();
        assert!(AlbumRoot::open(&dir.path().join("gone")).is_none());
        assert!(AlbumRoot::open(&dir.path().join("a.jpg")).is_none());
    }
}
