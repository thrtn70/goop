//! Audio tag + cover-art read/write via `lofty` (0.24).
//!
//! Read returns the structured `AudioTags`, optional cover art (base64), and a
//! full `raw` dump for the "all tags" expander. Write mutates the file at the
//! given path *in place* — the crash-safe temp+rename dance lives in `write.rs`,
//! which copies the original to a temp and calls [`write_tags`] on that temp.

use crate::MetadataError;
use base64::Engine as _;
use goop_core::{AudioTags, CoverArt, CoverArtOp, RawTag};
use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::{Accessor, ItemKey, TagExt};
use lofty::tag::{Tag, TagType};
use std::path::Path;

/// Read tags, cover art, and a raw key/value dump from an audio file.
pub fn read_audio(
    path: &Path,
) -> Result<(AudioTags, Option<CoverArt>, Vec<RawTag>), MetadataError> {
    let tagged = lofty::read_from_path(path).map_err(|e| MetadataError::Audio(e.to_string()))?;

    let mut raw = Vec::new();
    // File-level audio properties — handy in the viewer regardless of tags.
    let props = tagged.properties();
    raw.push(RawTag {
        group: "Audio".into(),
        tag: "Duration".into(),
        value: format!("{:.0}s", props.duration().as_secs_f64()),
    });
    if let Some(br) = props.audio_bitrate() {
        raw.push(RawTag {
            group: "Audio".into(),
            tag: "Bitrate".into(),
            value: format!("{br} kbps"),
        });
    }
    if let Some(sr) = props.sample_rate() {
        raw.push(RawTag {
            group: "Audio".into(),
            tag: "Sample rate".into(),
            value: format!("{sr} Hz"),
        });
    }
    if let Some(ch) = props.channels() {
        raw.push(RawTag {
            group: "Audio".into(),
            tag: "Channels".into(),
            value: ch.to_string(),
        });
    }

    let tags = match tagged.primary_tag() {
        Some(tag) => {
            let at = AudioTags {
                title: tag.title().map(|c| c.to_string()),
                artist: tag.artist().map(|c| c.to_string()),
                album: tag.album().map(|c| c.to_string()),
                album_artist: tag.get_string(ItemKey::AlbumArtist).map(|s| s.to_string()),
                track: tag.track().map(|n| n.to_string()),
                disc: tag.disk().map(|n| n.to_string()),
                year: read_year(tag),
                genre: tag.genre().map(|c| c.to_string()),
                comment: tag.comment().map(|c| c.to_string()),
                composer: tag.get_string(ItemKey::Composer).map(|s| s.to_string()),
            };
            // Full item dump for the "all tags" expander.
            for item in tag.items() {
                if let Some(text) = item.value().text() {
                    raw.push(RawTag {
                        group: "Tags".into(),
                        tag: format!("{:?}", item.key()),
                        value: text.to_string(),
                    });
                }
            }
            at
        }
        None => AudioTags::default(),
    };

    let cover_art = tagged.primary_tag().and_then(read_cover);

    Ok((tags, cover_art, raw))
}

/// Extract the front cover (or first picture) as base64.
fn read_cover(tag: &Tag) -> Option<CoverArt> {
    let pic = tag
        .pictures()
        .iter()
        .find(|p| p.pic_type() == PictureType::CoverFront)
        .or_else(|| tag.pictures().first())?;
    Some(CoverArt {
        mime_type: pic
            .mime_type()
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| "image/jpeg".to_string()),
        base64: base64::engine::general_purpose::STANDARD.encode(pic.data()),
    })
}

/// Apply tag + cover-art changes to the file at `path`, saving in place.
/// Caller is responsible for the temp-file/atomic-rename safety dance.
pub fn write_tags(
    path: &Path,
    tags: &AudioTags,
    cover_art: &CoverArtOp,
) -> Result<(), MetadataError> {
    let mut tagged =
        lofty::read_from_path(path).map_err(|e| MetadataError::Audio(e.to_string()))?;

    // Ensure a primary tag exists to write into.
    if tagged.primary_tag_mut().is_none() {
        let tag_type: TagType = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tag_type));
    }
    let tag = tagged
        .primary_tag_mut()
        .ok_or_else(|| MetadataError::Audio("could not create a primary tag".into()))?;

    // Accessor-backed string fields. None=untouched, ""=clear, else=set.
    match tags.title.as_deref() {
        None => {}
        Some("") => tag.remove_title(),
        Some(s) => tag.set_title(s.to_string()),
    }
    match tags.artist.as_deref() {
        None => {}
        Some("") => tag.remove_artist(),
        Some(s) => tag.set_artist(s.to_string()),
    }
    match tags.album.as_deref() {
        None => {}
        Some("") => tag.remove_album(),
        Some(s) => tag.set_album(s.to_string()),
    }
    match tags.genre.as_deref() {
        None => {}
        Some("") => tag.remove_genre(),
        Some(s) => tag.set_genre(s.to_string()),
    }
    match tags.comment.as_deref() {
        None => {}
        Some("") => tag.remove_comment(),
        Some(s) => tag.set_comment(s.to_string()),
    }

    // ItemKey-backed string fields (no Accessor getter/setter in lofty 0.24).
    set_item(tag, ItemKey::AlbumArtist, tags.album_artist.as_deref());
    set_item(tag, ItemKey::Composer, tags.composer.as_deref());
    set_year(tag, tags.year.as_deref());

    // Numeric Accessor fields. Inlined (not helper closures) because two
    // closures both capturing `&mut tag` in one call would fail the borrow
    // checker.
    match tags.track.as_deref() {
        None => {}
        Some(s) if s.trim().is_empty() => tag.remove_track(),
        Some(s) => tag.set_track(parse_u32(s, "track")?),
    }
    match tags.disc.as_deref() {
        None => {}
        Some(s) if s.trim().is_empty() => tag.remove_disk(),
        Some(s) => tag.set_disk(parse_u32(s, "disc")?),
    }

    match cover_art {
        CoverArtOp::Keep => {}
        CoverArtOp::Remove => remove_all_pictures(tag),
        CoverArtOp::Replace { source_path } => {
            let bytes = std::fs::read(source_path).map_err(MetadataError::Io)?;
            let mime = guess_mime(Path::new(source_path));
            let picture = Picture::unchecked(bytes)
                .pic_type(PictureType::CoverFront)
                .mime_type(mime)
                .description("Front Cover")
                .build();
            remove_all_pictures(tag);
            tag.set_picture(0, picture);
        }
    }

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| MetadataError::Audio(e.to_string()))?;
    Ok(())
}

/// Year is stored under `RecordingDate` (lofty maps it to TDRC / ©day / DATE
/// across ID3v2 / MP4 / Vorbis), with a fallback read from the bare `Year`
/// key for files written by other tools.
fn read_year(tag: &Tag) -> Option<String> {
    let raw = tag
        .get_string(ItemKey::RecordingDate)
        .or_else(|| tag.get_string(ItemKey::Year))?;
    let year: String = raw
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .take(4)
        .collect();
    // Non-numeric junk (e.g. "unknown") → None rather than echoing a value
    // that would later fail the numeric re-save parse.
    if year.is_empty() {
        None
    } else {
        Some(year)
    }
}

fn set_year(tag: &mut Tag, value: Option<&str>) {
    match value {
        None => {}
        Some(s) if s.trim().is_empty() => {
            tag.remove_key(ItemKey::RecordingDate);
            tag.remove_key(ItemKey::Year);
        }
        Some(s) => {
            // Normalize onto RecordingDate; drop any stray bare Year key.
            tag.remove_key(ItemKey::Year);
            tag.insert_text(ItemKey::RecordingDate, s.trim().to_string());
        }
    }
}

/// `None` = leave untouched; `Some("")` = clear; `Some(s)` = set.
fn set_item(tag: &mut Tag, key: ItemKey, value: Option<&str>) {
    match value {
        None => {}
        Some("") => tag.remove_key(key),
        Some(s) => {
            tag.insert_text(key, s.to_string());
        }
    }
}

fn parse_u32(s: &str, field: &str) -> Result<u32, MetadataError> {
    s.trim().parse().map_err(|_| {
        MetadataError::InvalidValue(format!("{field} must be a whole number, got {s:?}"))
    })
}

fn remove_all_pictures(tag: &mut Tag) {
    while !tag.pictures().is_empty() {
        tag.remove_picture(0);
    }
}

fn guess_mime(path: &Path) -> MimeType {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => MimeType::Png,
        Some("gif") => MimeType::Gif,
        Some("bmp") => MimeType::Bmp,
        Some("tif") | Some("tiff") => MimeType::Tiff,
        // jpg/jpeg and anything else default to JPEG (the most broadly
        // supported embedded-cover format).
        _ => MimeType::Jpeg,
    }
}
