//! Read-only EXIF for the universal image viewer via `kamadak-exif`.
//!
//! v1 is read-only: there is no mature pure-Rust EXIF *writer*, so editing a
//! photo's date/GPS is deferred to the exiftool follow-up. A file with no EXIF
//! (e.g. a plain PNG) is not an error here — it just yields an empty list.

use crate::MetadataError;
use exif::{In, Reader};
use goop_core::RawTag;
use std::io::BufReader;
use std::path::Path;

pub fn read_image(path: &Path) -> Result<Vec<RawTag>, MetadataError> {
    let file = std::fs::File::open(path)?;
    let mut buf = BufReader::new(file);
    let exif = match Reader::new().read_from_container(&mut buf) {
        Ok(e) => e,
        // No EXIF segment present — fine for a viewer, return nothing.
        Err(exif::Error::NotFound(_)) => return Ok(Vec::new()),
        Err(e) => return Err(MetadataError::Exif(e.to_string())),
    };

    let mut raw = Vec::new();
    for field in exif.fields() {
        let name = field.tag.to_string();
        let group = if name.starts_with("GPS") {
            "GPS"
        } else if field.ifd_num == In::THUMBNAIL {
            "Thumbnail"
        } else {
            "EXIF"
        };
        raw.push(RawTag {
            group: group.to_string(),
            tag: name,
            value: field.display_value().with_unit(&exif).to_string(),
        });
    }
    Ok(raw)
}
