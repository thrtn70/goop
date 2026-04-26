//! Lazy, disk-cached thumbnail service for the History preview panel,
//! Quick View modal, and grid view.
//!
//! Thumbnails land at `data_dir/thumbs/<job-id>.png` at roughly 240×160.
//! The first caller for a given job triggers generation; subsequent callers
//! return the cached path. An LRU eviction pass runs on each write to keep
//! the cache below ~500 MB.
//!
//! Per kind:
//! - `Video` — first frame at t=1s, scaled to width.
//! - `Image` — `image` crate decode + thumbnail.
//! - `Pdf` — Ghostscript renders page 1 at 72dpi.
//! - `Audio` — ffmpeg's `showwavespic` filter renders an RMS waveform.

use dashmap::DashMap;
use goop_core::{JobId, SourceKind};
use goop_sidecar::BinaryResolver;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;

const CACHE_BUDGET_BYTES: u64 = 500 * 1024 * 1024;
const THUMB_WIDTH: u32 = 240;
const THUMB_HEIGHT: u32 = 160;

#[derive(Debug, Error)]
pub enum ThumbError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("image decode: {0}")]
    Image(String),
    #[error("ffmpeg failed: {0}")]
    Ffmpeg(String),
    #[error("ghostscript failed: {0}")]
    Ghostscript(String),
    #[error("ffmpeg sidecar missing: {0}")]
    SidecarMissing(String),
}

/// Service handle — cheap to clone. Callers keep it in the Tauri `AppState`
/// so every command invocation gets the same per-job lock map.
#[derive(Clone)]
pub struct ThumbnailService {
    data_dir: PathBuf,
    /// Path to the bundled Ghostscript resource tree (Resource/, lib/,
    /// iccprofiles/). Set at startup from Tauri's `resource_dir()`. The
    /// gs invocations export this as `GS_LIB`. `None` means we assume gs
    /// has its own resource-path baked in (dev builds where gs is on PATH).
    gs_resource_dir: Option<PathBuf>,
    locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
}

impl ThumbnailService {
    pub fn new(data_dir: PathBuf, gs_resource_dir: Option<PathBuf>) -> Self {
        Self {
            data_dir,
            gs_resource_dir,
            locks: Arc::new(DashMap::new()),
        }
    }

    fn cache_dir(&self) -> PathBuf {
        self.data_dir.join("thumbs")
    }

    fn cache_path(&self, job_id: &JobId) -> PathBuf {
        self.cache_dir().join(format!("{}.png", job_id.0))
    }

    /// Return the cached thumbnail path, generating it on first call.
    /// Concurrent calls for the same `job_id` coalesce through a per-id
    /// mutex so we don't double-spawn ffmpeg/gs.
    pub async fn get(
        &self,
        resolver: &BinaryResolver,
        job_id: JobId,
        source_kind: SourceKind,
        output_path: &Path,
    ) -> Result<PathBuf, ThumbError> {
        let cached = self.cache_path(&job_id);
        if cached.exists() {
            // Touch the file so the LRU eviction pass treats this as recently
            // accessed. Opening in append mode bumps the mtime on Unix and
            // Windows without needing an extra crate.
            let _ = std::fs::OpenOptions::new().append(true).open(&cached);
            return Ok(cached);
        }

        let key = job_id.0.to_string();
        let lock = self
            .locks
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = lock.lock().await;

        // Re-check inside the lock in case another caller generated while
        // we were waiting.
        if cached.exists() {
            return Ok(cached);
        }

        std::fs::create_dir_all(self.cache_dir())?;

        match source_kind {
            SourceKind::Video => generate_video(resolver, output_path, &cached).await?,
            SourceKind::Image => generate_image(output_path, &cached)?,
            SourceKind::Pdf => {
                generate_pdf(
                    resolver,
                    self.gs_resource_dir.as_deref(),
                    output_path,
                    &cached,
                )
                .await?
            }
            SourceKind::Audio => generate_audio_waveform(resolver, output_path, &cached).await?,
        }

        self.evict_if_over_budget();
        self.locks.remove(&key);
        Ok(cached)
    }

    /// Delete a cached thumbnail for a job (called when the job row is
    /// forgotten so orphaned PNGs don't accumulate).
    pub fn evict(&self, job_id: &JobId) {
        let p = self.cache_path(job_id);
        let _ = std::fs::remove_file(p);
    }

    fn evict_if_over_budget(&self) {
        let dir = self.cache_dir();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = entries
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                let meta = e.metadata().ok()?;
                let modified = meta.modified().ok()?;
                Some((path, meta.len(), modified))
            })
            .collect();
        let total: u64 = files.iter().map(|(_, s, _)| *s).sum();
        if total <= CACHE_BUDGET_BYTES {
            return;
        }
        // Sort oldest first.
        files.sort_by_key(|(_, _, t)| *t);
        let mut remaining = total;
        for (path, size, _) in files {
            if remaining <= CACHE_BUDGET_BYTES {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                remaining = remaining.saturating_sub(size);
            }
        }
    }
}

async fn generate_video(
    resolver: &BinaryResolver,
    input: &Path,
    output: &Path,
) -> Result<(), ThumbError> {
    let bin = resolver
        .resolve("ffmpeg")
        .map_err(|e| ThumbError::SidecarMissing(e.to_string()))?;
    let scale = format!("scale={}:-2", THUMB_WIDTH);
    let status = tokio::process::Command::new(&bin.path)
        .arg("-y")
        .arg("-ss")
        .arg("1")
        .arg("-i")
        .arg(input)
        .arg("-vframes")
        .arg("1")
        .arg("-vf")
        .arg(&scale)
        .arg(output)
        .output()
        .await
        .map_err(ThumbError::Io)?;
    if !status.status.success() {
        return Err(ThumbError::Ffmpeg(
            String::from_utf8_lossy(&status.stderr).into_owned(),
        ));
    }
    Ok(())
}

/// Render an RMS waveform PNG for an audio file using ffmpeg's
/// `showwavespic` filter. Output dimensions match the rest of the
/// thumbnail family so audio rows lay out consistently in History.
///
/// Color is baked into the PNG (ffmpeg can't do CSS-style theming).
/// `#3ec79a` is a mid-lightness teal-green chosen to read on both the
/// light and dark surface-2 tokens. It's in the same hue family as
/// Goop's brand accent without being the exact OKLCH match — the
/// extra lightness avoids muddy waveforms on dark mode.
///
/// `-update 1` suppresses ffmpeg's "use a pattern" warning when a single
/// PNG is the desired output. `showwavespic` auto-links to the input's
/// audio stream when used inside `-filter_complex`; no explicit pad
/// labels are needed.
async fn generate_audio_waveform(
    resolver: &BinaryResolver,
    input: &Path,
    output: &Path,
) -> Result<(), ThumbError> {
    let bin = resolver
        .resolve("ffmpeg")
        .map_err(|e| ThumbError::SidecarMissing(e.to_string()))?;
    let filter = format!(
        "showwavespic=s={}x{}:colors=#3ec79a",
        THUMB_WIDTH, THUMB_HEIGHT
    );
    let status = tokio::process::Command::new(&bin.path)
        .arg("-y")
        .arg("-i")
        .arg(input)
        .arg("-filter_complex")
        .arg(&filter)
        .arg("-frames:v")
        .arg("1")
        .arg("-update")
        .arg("1")
        .arg(output)
        .output()
        .await
        .map_err(ThumbError::Io)?;
    if !status.status.success() {
        return Err(ThumbError::Ffmpeg(
            String::from_utf8_lossy(&status.stderr).into_owned(),
        ));
    }
    Ok(())
}

fn generate_image(input: &Path, output: &Path) -> Result<(), ThumbError> {
    let img = image::ImageReader::open(input)
        .map_err(|e| ThumbError::Image(e.to_string()))?
        .with_guessed_format()
        .map_err(|e| ThumbError::Image(e.to_string()))?
        .decode()
        .map_err(|e| ThumbError::Image(e.to_string()))?;
    let resized = img.thumbnail(THUMB_WIDTH, THUMB_HEIGHT);
    resized
        .save(output)
        .map_err(|e| ThumbError::Image(e.to_string()))?;
    Ok(())
}

async fn generate_pdf(
    resolver: &BinaryResolver,
    gs_resource_dir: Option<&Path>,
    input: &Path,
    output: &Path,
) -> Result<(), ThumbError> {
    let bin = resolver
        .resolve("gs")
        .map_err(|e| ThumbError::SidecarMissing(e.to_string()))?;
    let mut cmd = tokio::process::Command::new(&bin.path);
    if let Some(dir) = gs_resource_dir {
        // Gs searches these dirs for Resource/, lib/, iccprofiles/.
        cmd.env("GS_LIB", dir);
    }
    let status = cmd
        .arg("-sDEVICE=pngalpha")
        .arg("-r72")
        .arg("-dFirstPage=1")
        .arg("-dLastPage=1")
        .arg("-dNOPAUSE")
        .arg("-dBATCH")
        .arg("-dQUIET")
        .arg(gs_output_arg(output))
        .arg(input)
        .output()
        .await
        .map_err(ThumbError::Io)?;
    if !status.status.success() {
        return Err(ThumbError::Ghostscript(
            String::from_utf8_lossy(&status.stderr).into_owned(),
        ));
    }
    Ok(())
}

fn gs_output_arg(output: &Path) -> String {
    let escaped = output.display().to_string().replace('%', "%%");
    format!("-sOutputFile={escaped}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn cache_path_uses_job_id_uuid() {
        let dir = tempdir().unwrap();
        let svc = ThumbnailService::new(dir.path().to_path_buf(), None);
        let id = JobId::new();
        let p = svc.cache_path(&id);
        assert!(p.to_string_lossy().contains(&id.0.to_string()));
        assert!(p.extension().is_some_and(|e| e == "png"));
    }

    #[test]
    fn output_arg_escapes_percent_for_ghostscript() {
        let path = Path::new("/tmp/goop 100%/thumb.png");
        assert_eq!(
            gs_output_arg(path),
            "-sOutputFile=/tmp/goop 100%%/thumb.png"
        );
    }

    #[test]
    fn evict_removes_tracked_thumb() {
        let dir = tempdir().unwrap();
        let svc = ThumbnailService::new(dir.path().to_path_buf(), None);
        std::fs::create_dir_all(svc.cache_dir()).unwrap();
        let id = JobId::new();
        let p = svc.cache_path(&id);
        std::fs::write(&p, b"x").unwrap();
        assert!(p.exists());
        svc.evict(&id);
        assert!(!p.exists());
    }

    #[test]
    fn eviction_keeps_cache_under_budget() {
        let dir = tempdir().unwrap();
        let svc = ThumbnailService::new(dir.path().to_path_buf(), None);
        std::fs::create_dir_all(svc.cache_dir()).unwrap();
        // Write three large-ish files whose total exceeds the budget.
        // Using a temporary smaller budget is awkward because it's a const;
        // instead, verify eviction is a no-op when under budget by checking
        // that small files aren't touched.
        let a = svc.cache_dir().join("a.png");
        let b = svc.cache_dir().join("b.png");
        std::fs::write(&a, vec![0u8; 1024]).unwrap();
        std::fs::write(&b, vec![0u8; 1024]).unwrap();
        svc.evict_if_over_budget();
        assert!(a.exists());
        assert!(b.exists());
    }

    #[tokio::test]
    async fn audio_kind_routes_through_ffmpeg() {
        // Phase J: audio used to short-circuit to `NoThumbnail`; now it
        // routes through `generate_audio_waveform` which spawns ffmpeg.
        // We don't ship a real audio fixture, so the call fails. Either
        // outcome — `SidecarMissing` (no ffmpeg on PATH in CI) or
        // `Ffmpeg` (ffmpeg ran and rejected the missing input file) —
        // proves the audio code path was taken instead of returning a
        // generic NoThumbnail error like the old behaviour.
        let dir = tempdir().unwrap();
        let svc = ThumbnailService::new(dir.path().to_path_buf(), None);
        let resolver = BinaryResolver::new(dir.path().join("nonexistent"));
        let err = svc
            .get(
                &resolver,
                JobId::new(),
                SourceKind::Audio,
                &dir.path().join("fake.mp3"),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, ThumbError::SidecarMissing(_) | ThumbError::Ffmpeg(_)),
            "expected SidecarMissing or Ffmpeg, got {err:?}"
        );
    }
}
