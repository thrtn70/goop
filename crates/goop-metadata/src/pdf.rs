//! Read-only PDF `/Info` metadata for the universal viewer. Delegates the
//! lopdf parsing to `goop-pdf` so PDF handling stays in one crate.

use crate::MetadataError;
use goop_core::RawTag;
use std::path::Path;

pub fn read_pdf(path: &Path) -> Result<Vec<RawTag>, MetadataError> {
    let info =
        goop_pdf::metadata::read_info(path).map_err(|e| MetadataError::Pdf(e.to_string()))?;
    Ok(info
        .into_iter()
        .map(|(tag, value)| RawTag {
            group: "PDF".to_string(),
            tag,
            value,
        })
        .collect())
}
