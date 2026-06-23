//! End-to-end audio metadata round-trip tests over real fixture files.
//! Fixtures are tiny silent clips (mp3/flac/m4a) + a small JPEG.

use goop_core::{AudioTags, CoverArtOp, MetadataWriteItem};
use goop_metadata::{audio, write_item};
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Copy a fixture into a fresh temp dir and return (dir, path). The dir is
/// returned so the caller keeps it alive (drop = cleanup).
fn staged(name: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let dst = dir.path().join(name);
    std::fs::copy(fixtures().join(name), &dst).unwrap();
    (dir, dst)
}

fn tags_with(title: &str, artist: &str, album: &str) -> AudioTags {
    AudioTags {
        title: Some(title.into()),
        artist: Some(artist.into()),
        album: Some(album.into()),
        album_artist: Some("AA".into()),
        track: Some("3".into()),
        disc: Some("1".into()),
        year: Some("2026".into()),
        genre: Some("Ambient".into()),
        comment: Some("hi".into()),
        composer: Some("Composer C".into()),
    }
}

fn write(path: &Path, audio: AudioTags, cover_art: CoverArtOp, backup: bool) {
    write_item(
        &MetadataWriteItem {
            path: path.to_string_lossy().into_owned(),
            audio,
            cover_art,
        },
        backup,
    )
    .unwrap();
}

#[test]
fn mp3_tag_round_trip() {
    let (_dir, p) = staged("silent.mp3");
    write(&p, tags_with("T", "A", "Al"), CoverArtOp::Keep, false);
    let (tags, _cover, _raw) = audio::read_audio(&p).unwrap();
    assert_eq!(tags.title.as_deref(), Some("T"));
    assert_eq!(tags.artist.as_deref(), Some("A"));
    assert_eq!(tags.album.as_deref(), Some("Al"));
    assert_eq!(tags.album_artist.as_deref(), Some("AA"));
    assert_eq!(tags.track.as_deref(), Some("3"));
    assert_eq!(tags.disc.as_deref(), Some("1"));
    assert_eq!(tags.year.as_deref(), Some("2026"));
    assert_eq!(tags.genre.as_deref(), Some("Ambient"));
    assert_eq!(tags.composer.as_deref(), Some("Composer C"));
}

#[test]
fn flac_tag_round_trip() {
    let (_dir, p) = staged("silent.flac");
    write(&p, tags_with("FT", "FA", "FAl"), CoverArtOp::Keep, false);
    let (tags, _cover, _raw) = audio::read_audio(&p).unwrap();
    assert_eq!(tags.title.as_deref(), Some("FT"));
    assert_eq!(tags.artist.as_deref(), Some("FA"));
    assert_eq!(tags.album.as_deref(), Some("FAl"));
}

#[test]
fn m4a_tag_round_trip() {
    let (_dir, p) = staged("silent.m4a");
    write(&p, tags_with("MT", "MA", "MAl"), CoverArtOp::Keep, false);
    let (tags, _cover, _raw) = audio::read_audio(&p).unwrap();
    assert_eq!(tags.title.as_deref(), Some("MT"));
    assert_eq!(tags.artist.as_deref(), Some("MA"));
    assert_eq!(tags.album.as_deref(), Some("MAl"));
}

#[test]
fn empty_string_clears_field() {
    let (_dir, p) = staged("silent.mp3");
    write(&p, tags_with("T", "A", "Al"), CoverArtOp::Keep, false);
    // Now clear the title only; leave the rest untouched.
    let clear_title = AudioTags {
        title: Some(String::new()),
        ..Default::default()
    };
    write(&p, clear_title, CoverArtOp::Keep, false);
    let (tags, _cover, _raw) = audio::read_audio(&p).unwrap();
    assert_eq!(tags.title, None, "empty string should clear the title");
    assert_eq!(
        tags.artist.as_deref(),
        Some("A"),
        "None must leave artist alone"
    );
}

#[test]
fn cover_art_replace_then_remove() {
    let (_dir, p) = staged("silent.mp3");
    let cover = fixtures().join("red.jpg");

    write(
        &p,
        AudioTags::default(),
        CoverArtOp::Replace {
            source_path: cover.to_string_lossy().into_owned(),
        },
        false,
    );
    let (_t, embedded, _raw) = audio::read_audio(&p).unwrap();
    let embedded = embedded.expect("cover art should be present after replace");
    assert!(!embedded.base64.is_empty());
    assert!(
        embedded.mime_type.contains("jp"),
        "expected a jpeg mime, got {}",
        embedded.mime_type
    );

    write(&p, AudioTags::default(), CoverArtOp::Remove, false);
    let (_t, after_remove, _raw) = audio::read_audio(&p).unwrap();
    assert!(
        after_remove.is_none(),
        "cover art should be gone after remove"
    );
}

#[test]
fn in_place_write_leaves_no_litter_without_backup() {
    let (dir, p) = staged("silent.mp3");
    write(&p, tags_with("T", "A", "Al"), CoverArtOp::Keep, false);
    let entries: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        entries,
        vec!["silent.mp3".to_string()],
        "only the original file should remain: {entries:?}"
    );
}

#[test]
fn backup_flag_writes_bak_copy() {
    let (dir, p) = staged("silent.mp3");
    write(&p, tags_with("T", "A", "Al"), CoverArtOp::Keep, true);
    let bak = dir.path().join("silent.mp3.bak");
    assert!(bak.is_file(), "a .bak copy should exist when backup=true");
}

#[test]
fn image_without_exif_reads_empty_not_error() {
    let red = fixtures().join("red.jpg");
    let raw = goop_metadata::image::read_image(&red).unwrap();
    // The synthetic JPEG has no EXIF; a viewer should get an empty list, not
    // an error.
    assert!(raw.is_empty() || raw.iter().all(|t| t.group != "Error"));
}
