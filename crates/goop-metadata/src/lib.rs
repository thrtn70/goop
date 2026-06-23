//! Metadata reading + writing for Goop's Metadata editor (pillar #1).
//!
//! - **Audio** (`audio`): full read/write of tags + cover art via `lofty`
//!   (MP3·FLAC·OGG·Opus·M4A·WAV·AIFF). This is the only *writable* domain in v1.
//! - **Image** (`image`): read-only EXIF via `kamadak-exif`.
//! - **Video** (`video`): read-only container/stream tags via the bundled `ffprobe`.
//! - **Pdf** (`pdf`): read-only `/Info` dict via `goop-pdf`/`lopdf`.
//!
//! Reads never fail the whole batch — a per-file error becomes a `MetadataView`
//! carrying an `Error` raw tag so the UI always has something to show. Writes
//! are crash-safe and in-place (see `write`).

pub mod audio;
pub mod image;
pub mod pdf;
pub mod video;
pub mod write;

use goop_core::{GoopError, MetadataDomain, MetadataView, MetadataWriteItem, RawTag};
use goop_sidecar::BinaryResolver;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MetadataError {
    #[error("unsupported file type for this operation: {0}")]
    Unsupported(String),
    #[error("audio tag error: {0}")]
    Audio(String),
    #[error("exif read error: {0}")]
    Exif(String),
    #[error("ffprobe failed: {0}")]
    Ffprobe(String),
    #[error("pdf read error: {0}")]
    Pdf(String),
    #[error("invalid value: {0}")]
    InvalidValue(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl From<MetadataError> for GoopError {
    fn from(e: MetadataError) -> Self {
        // Match goop-pdf's convention: domain errors surface through the
        // queue's error channel and reach the user via `user_message`.
        GoopError::Queue(e.to_string())
    }
}

/// Build a `MetadataView` that carries a single `Error` raw tag. Used so a
/// failed read still yields a viewable row instead of dropping the file.
fn error_view(path: &str, domain: MetadataDomain, message: String) -> MetadataView {
    MetadataView {
        path: path.to_string(),
        domain,
        audio: None,
        cover_art: None,
        raw: vec![RawTag {
            group: "Error".to_string(),
            tag: "read".to_string(),
            value: message,
        }],
    }
}

/// Synchronous read for the non-subprocess domains (audio/image/pdf/other).
/// Runs on a blocking thread; `video` is handled separately because it shells
/// out to ffprobe asynchronously.
fn read_blocking(path_str: &str) -> MetadataView {
    let path = Path::new(path_str);
    let domain = MetadataDomain::detect(path);
    match domain {
        MetadataDomain::Audio => match audio::read_audio(path) {
            Ok((tags, cover_art, raw)) => MetadataView {
                path: path_str.to_string(),
                domain,
                audio: Some(tags),
                cover_art,
                raw,
            },
            Err(e) => error_view(path_str, domain, e.to_string()),
        },
        MetadataDomain::Image => match image::read_image(path) {
            Ok(raw) => MetadataView {
                path: path_str.to_string(),
                domain,
                audio: None,
                cover_art: None,
                raw,
            },
            Err(e) => error_view(path_str, domain, e.to_string()),
        },
        MetadataDomain::Pdf => match pdf::read_pdf(path) {
            Ok(raw) => MetadataView {
                path: path_str.to_string(),
                domain,
                audio: None,
                cover_art: None,
                raw,
            },
            Err(e) => error_view(path_str, domain, e.to_string()),
        },
        // Video is never routed here; Other has no dedicated reader.
        MetadataDomain::Video | MetadataDomain::Other => MetadataView {
            path: path_str.to_string(),
            domain,
            audio: None,
            cover_art: None,
            raw: Vec::new(),
        },
    }
}

/// Read metadata for a set of paths, returning one `MetadataView` each (input
/// order preserved). Never errors — see module docs. Files are read
/// sequentially (not concurrently): typical selections are small and the
/// reads are cheap, so serial keeps error ordering and code simple.
pub async fn read(resolver: &BinaryResolver, paths: &[String]) -> Vec<MetadataView> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        let domain = MetadataDomain::detect(Path::new(p));
        let view = if domain == MetadataDomain::Video {
            video::read_video(resolver, p).await
        } else {
            let path_str = p.clone();
            let fallback = p.clone();
            tokio::task::spawn_blocking(move || read_blocking(&path_str))
                .await
                .unwrap_or_else(|e| error_view(&fallback, domain, format!("read task failed: {e}")))
        };
        out.push(view);
    }
    out
}

/// Apply one file's metadata write in place (crash-safe). Audio is the only
/// writable domain in v1; other domains return `Unsupported`.
pub fn write_item(item: &MetadataWriteItem, backup: bool) -> Result<(), MetadataError> {
    let path = Path::new(&item.path);
    match MetadataDomain::detect(path) {
        MetadataDomain::Audio => {
            write::write_audio_in_place(path, &item.audio, &item.cover_art, backup)
        }
        other => Err(MetadataError::Unsupported(format!(
            "{other:?} metadata writing is not supported yet"
        ))),
    }
}
