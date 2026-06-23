//! Metadata-editor types shared across the Rust crates and the TS frontend.
//!
//! Engine split (decided after the Phase-0 spike proved exiftool cannot write
//! MP3/FLAC tags): audio tag read/write + cover art is pure-Rust via `lofty`;
//! the read-only "universal viewer" for image/video/PDF is `kamadak-exif`,
//! the already-bundled `ffprobe`, and `lopdf`. exiftool is deferred to a later
//! release for *writing* image/video EXIF/GPS/date.
//!
//! These types live in `goop-core` (not the `goop-metadata` engine crate)
//! because `scripts/generate-bindings.sh` only runs ts-rs export over
//! `goop-core`/`goop-tauri` — mirroring how `PdfMetadata`/`ImageOperation`
//! are defined here and consumed by `goop-pdf`/`goop-converter`.

use serde::{Deserialize, Serialize};
use std::path::Path;
use ts_rs::TS;

/// Which metadata "family" a file belongs to. Drives both engine routing
/// (which reader/writer to call) and which UI form the frontend shows.
/// Detected by file extension; `Other` is the catch-all for anything we
/// don't have a dedicated reader for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum MetadataDomain {
    Audio,
    Image,
    Video,
    Pdf,
    Other,
}

impl MetadataDomain {
    /// Classify a path by its extension (case-insensitive). Pure string work —
    /// no filesystem access, so it's safe to call before a file exists.
    pub fn detect(path: &Path) -> Self {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "mp3" | "m4a" | "m4b" | "aac" | "flac" | "ogg" | "oga" | "opus" | "wav" | "aiff"
            | "aif" | "aifc" | "wv" | "ape" | "mpc" | "spx" => Self::Audio,
            "jpg" | "jpeg" | "jpe" | "tif" | "tiff" | "heic" | "heif" | "png" | "webp" | "dng"
            | "cr2" | "cr3" | "nef" | "arw" | "raf" | "orf" | "rw2" => Self::Image,
            "mp4" | "mov" | "m4v" | "mkv" | "webm" | "avi" | "wmv" | "flv" | "mpg" | "mpeg"
            | "mts" | "m2ts" => Self::Video,
            "pdf" => Self::Pdf,
            _ => Self::Other,
        }
    }
}

/// A single raw tag as surfaced in the universal read-only viewer. `group`
/// buckets related tags (e.g. `EXIF`, `GPS`, `Format`, `Stream:0`, `Audio`,
/// `PDF`); `tag` is the human-readable field name; `value` is the rendered
/// string. The frontend groups by `group` for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct RawTag {
    pub group: String,
    pub tag: String,
    pub value: String,
}

/// Editable audio tag fields. Mirrors `PdfMetadata`'s convention: `None` =
/// "leave existing value untouched", `Some("")` = "clear this field",
/// `Some(s)` = "set to s". `track`/`disc`/`year` are carried as strings for a
/// uniform clear/untouch semantics; the writer parses them to numbers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct AudioTags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track: Option<String>,
    pub disc: Option<String>,
    pub year: Option<String>,
    pub genre: Option<String>,
    pub comment: Option<String>,
    pub composer: Option<String>,
}

impl AudioTags {
    /// True when every field is `None` — i.e. a write would be a no-op for
    /// tags (cover-art ops are tracked separately).
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.artist.is_none()
            && self.album.is_none()
            && self.album_artist.is_none()
            && self.track.is_none()
            && self.disc.is_none()
            && self.year.is_none()
            && self.genre.is_none()
            && self.comment.is_none()
            && self.composer.is_none()
    }
}

/// Embedded cover art as surfaced to the UI. `base64` is the raw image bytes
/// base64-encoded (no data-URL prefix); the frontend builds
/// `data:{mime_type};base64,{base64}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct CoverArt {
    pub mime_type: String,
    pub base64: String,
}

/// What to do with a file's embedded cover art on write. `Keep` leaves it
/// untouched; `Replace` embeds the image at `source_path` as the front cover;
/// `Remove` strips all embedded pictures.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CoverArtOp {
    #[default]
    Keep,
    Replace {
        source_path: String,
    },
    Remove,
}

/// The result of reading one file's metadata. `audio`/`cover_art` are
/// populated only for the `Audio` domain; `raw` is the universal grouped
/// key/value list and is populated for every readable domain (it also backs
/// the "all tags" expander for audio).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct MetadataView {
    pub path: String,
    pub domain: MetadataDomain,
    pub audio: Option<AudioTags>,
    pub cover_art: Option<CoverArt>,
    pub raw: Vec<RawTag>,
}

/// One file's write request inside a batch. `audio` carries the field-level
/// changes (None=untouched); `cover_art` the picture op.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct MetadataWriteItem {
    pub path: String,
    pub audio: AudioTags,
    pub cover_art: CoverArtOp,
}

/// Queue payload for a metadata write. A batch "Apply" enqueues a single
/// `Write` job carrying every selected file; the worker writes each in turn
/// and emits N/total progress. Tagged like `PdfOperation`/`ImageOperation`
/// so adding future ops (e.g. image EXIF write) stays additive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MetadataOperation {
    Write {
        items: Vec<MetadataWriteItem>,
        backup: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn detects_domains_by_extension_case_insensitively() {
        assert_eq!(
            MetadataDomain::detect(&PathBuf::from("a.MP3")),
            MetadataDomain::Audio
        );
        assert_eq!(
            MetadataDomain::detect(&PathBuf::from("a.flac")),
            MetadataDomain::Audio
        );
        assert_eq!(
            MetadataDomain::detect(&PathBuf::from("a.m4a")),
            MetadataDomain::Audio
        );
        assert_eq!(
            MetadataDomain::detect(&PathBuf::from("a.JPG")),
            MetadataDomain::Image
        );
        assert_eq!(
            MetadataDomain::detect(&PathBuf::from("a.heic")),
            MetadataDomain::Image
        );
        assert_eq!(
            MetadataDomain::detect(&PathBuf::from("a.mp4")),
            MetadataDomain::Video
        );
        assert_eq!(
            MetadataDomain::detect(&PathBuf::from("a.pdf")),
            MetadataDomain::Pdf
        );
        assert_eq!(
            MetadataDomain::detect(&PathBuf::from("a.txt")),
            MetadataDomain::Other
        );
        assert_eq!(
            MetadataDomain::detect(&PathBuf::from("noext")),
            MetadataDomain::Other
        );
    }

    #[test]
    fn audio_tags_is_empty_only_when_all_none() {
        assert!(AudioTags::default().is_empty());
        let with_title = AudioTags {
            title: Some("x".into()),
            ..Default::default()
        };
        assert!(!with_title.is_empty());
        let cleared = AudioTags {
            artist: Some(String::new()),
            ..Default::default()
        };
        assert!(!cleared.is_empty());
    }

    #[test]
    fn write_op_serializes_with_snake_case_kind() {
        let op = MetadataOperation::Write {
            items: vec![MetadataWriteItem {
                path: "/a.mp3".into(),
                audio: AudioTags {
                    title: Some("T".into()),
                    artist: None,
                    album: Some(String::new()),
                    ..Default::default()
                },
                cover_art: CoverArtOp::Replace {
                    source_path: "/cover.jpg".into(),
                },
            }],
            backup: true,
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["kind"], json!("write"));
        assert_eq!(v["items"][0]["audio"]["title"], json!("T"));
        assert_eq!(v["items"][0]["audio"]["artist"], json!(null));
        assert_eq!(v["items"][0]["audio"]["album"], json!(""));
        assert_eq!(v["items"][0]["cover_art"]["kind"], json!("replace"));
        assert_eq!(
            v["items"][0]["cover_art"]["source_path"],
            json!("/cover.jpg")
        );
        assert_eq!(v["backup"], json!(true));
        let back: MetadataOperation = serde_json::from_value(v).unwrap();
        assert_eq!(back, op);
    }

    #[test]
    fn cover_art_op_keep_is_default_and_round_trips() {
        assert_eq!(CoverArtOp::default(), CoverArtOp::Keep);
        let v = serde_json::to_value(CoverArtOp::Remove).unwrap();
        assert_eq!(v["kind"], json!("remove"));
        let back: CoverArtOp = serde_json::from_value(v).unwrap();
        assert_eq!(back, CoverArtOp::Remove);
    }
}
