use std::path::{Path, PathBuf};

pub fn allocate_output_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.{ext}"));
    if !candidate.exists() {
        return candidate;
    }
    for n in 1..10_000 {
        candidate = dir.join(format!("{stem} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}.{ext}"))
}

pub fn stem_of(input_path: &str) -> String {
    Path::new(input_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        let base = std::env::temp_dir().join(format!("goop-converter-naming-{}", uuid_rand()));
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn uuid_rand() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let c = COUNTER.fetch_add(1, Ordering::Relaxed);
        format!("{n}-{c}")
    }

    #[test]
    fn fresh_dir_returns_base_name() {
        let dir = tmp();
        let p = allocate_output_path(&dir, "clip", "mp4");
        assert_eq!(p.file_name().unwrap(), "clip.mp4");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn single_collision_gets_1_suffix() {
        let dir = tmp();
        fs::write(dir.join("clip.mp4"), b"x").unwrap();
        let p = allocate_output_path(&dir, "clip", "mp4");
        assert_eq!(p.file_name().unwrap(), "clip (1).mp4");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn multi_collision_increments() {
        let dir = tmp();
        fs::write(dir.join("clip.mp4"), b"x").unwrap();
        fs::write(dir.join("clip (1).mp4"), b"x").unwrap();
        fs::write(dir.join("clip (2).mp4"), b"x").unwrap();
        let p = allocate_output_path(&dir, "clip", "mp4");
        assert_eq!(p.file_name().unwrap(), "clip (3).mp4");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stem_of_strips_extension() {
        assert_eq!(stem_of("/tmp/video.mp4"), "video");
        assert_eq!(stem_of("/tmp/my.clip.webm"), "my.clip");
        assert_eq!(stem_of("video"), "video");
    }
}
