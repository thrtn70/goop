//! Bounded, layout-preserving updates to existing TIFF geometry tags.
use goop_core::GoopError;
use std::collections::HashSet;
use std::ops::Range;

fn invalid() -> GoopError {
    GoopError::InvalidRequest(
        "Cannot safely preserve malformed or ambiguous EXIF metadata; choose Strip all metadata."
            .into(),
    )
}
#[derive(Clone, Copy)]
struct Tiff<'a> {
    bytes: &'a [u8],
    little: bool,
}
impl Tiff<'_> {
    fn range(&self, offset: usize, len: usize) -> Result<Range<usize>, GoopError> {
        let end = offset.checked_add(len).ok_or_else(invalid)?;
        self.bytes.get(offset..end).ok_or_else(invalid)?;
        Ok(offset..end)
    }
    fn u16(&self, offset: usize) -> Result<u16, GoopError> {
        let bytes = self.bytes[self.range(offset, 2)?]
            .try_into()
            .map_err(|_| invalid())?;
        Ok(if self.little {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        })
    }
    fn u32(&self, offset: usize) -> Result<u32, GoopError> {
        let bytes = self.bytes[self.range(offset, 4)?]
            .try_into()
            .map_err(|_| invalid())?;
        Ok(if self.little {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        })
    }
}
fn header(exif: &[u8]) -> Result<Tiff<'_>, GoopError> {
    let bytes = exif.strip_prefix(b"Exif\0\0").unwrap_or(exif);
    let little = match bytes.get(..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return Err(invalid()),
    };
    let tiff = Tiff { bytes, little };
    if tiff.u16(2)? != 42 {
        return Err(invalid());
    }
    Ok(tiff)
}

fn scalar_orientation(
    tiff: Tiff<'_>,
    entry: usize,
) -> Result<image::metadata::Orientation, GoopError> {
    if tiff.u32(entry + 4)? != 1 {
        return Err(invalid());
    }
    let value = match tiff.u16(entry + 2)? {
        3 => u32::from(tiff.u16(entry + 8)?),
        4 => tiff.u32(entry + 8)?,
        _ => return Err(invalid()),
    };
    u8::try_from(value)
        .ok()
        .and_then(image::metadata::Orientation::from_exif)
        .ok_or_else(invalid)
}

/// Read only the bounded IFD0 scalar Orientation, with the same accepted
/// representation and value checks used when normalizing preserved metadata.
pub(crate) fn orientation(exif: &[u8]) -> Result<image::metadata::Orientation, GoopError> {
    let tiff = header(exif)?;
    let offset = tiff.u32(4)? as usize;
    if offset < 8 {
        return Err(invalid());
    }
    let count = usize::from(tiff.u16(offset)?);
    if count > 4096 {
        return Err(invalid());
    }
    tiff.range(offset, count * 12 + 6)?;
    let mut orientation = None;
    for i in 0..count {
        let entry = offset + 2 + i * 12;
        if tiff.u16(entry)? == 0x0112 {
            if orientation.is_some() {
                return Err(invalid());
            }
            orientation = Some(scalar_orientation(tiff, entry)?);
        }
    }
    Ok(orientation.unwrap_or(image::metadata::Orientation::NoTransforms))
}

struct Patch {
    range: Range<usize>,
    value: u32,
}
fn overlaps(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.start < b.end && b.start < a.end
}

pub(crate) fn normalize(exif: &[u8], width: u32, height: u32) -> Result<Vec<u8>, GoopError> {
    let prefix = if exif.starts_with(b"Exif\0\0") { 6 } else { 0 };
    let tiff = header(exif)?;
    let little = tiff.little;
    if width == 0 || height == 0 {
        return Err(invalid());
    }
    let first = tiff.u32(4)? as usize;
    let mut next = Some((first, true));
    let mut visited = HashSet::new();
    let mut tables = Vec::with_capacity(3);
    tables.push(0..8);
    let mut external = Vec::new();
    let mut patches = Vec::new();
    let mut total = 0usize;
    let mut thumbnail = None;
    while let Some((offset, primary)) = next.take() {
        if offset < 8 || !visited.insert(offset) {
            return Err(invalid());
        }
        let count = usize::from(tiff.u16(offset)?);
        total = total.checked_add(count).ok_or_else(invalid)?;
        if total > 4096 {
            return Err(invalid());
        }
        let table = tiff.range(
            offset,
            count
                .checked_mul(12)
                .and_then(|n| n.checked_add(6))
                .ok_or_else(invalid)?,
        )?;
        if tables.iter().any(|r| overlaps(r, &table)) {
            return Err(invalid());
        }
        tables.push(table.clone());
        let mut tags = HashSet::new();
        for i in 0..count {
            let entry = offset + 2 + i * 12;
            let tag = tiff.u16(entry)?;
            if !tags.insert(tag) {
                return Err(invalid());
            }
            let kind = tiff.u16(entry + 2)?;
            let count = tiff.u32(entry + 4)?;
            let size = match kind {
                1 | 2 | 6 | 7 => 1,
                3 | 8 => 2,
                4 | 9 | 11 | 13 => 4,
                5 | 10 | 12 => 8,
                _ => return Err(invalid()),
            };
            let length = (count as usize).checked_mul(size).ok_or_else(invalid)?;
            if length > 4 {
                let value_offset = tiff.u32(entry + 8)? as usize;
                external.push(tiff.range(value_offset, length)?);
            }
            let value = match tag {
                0x0112 => {
                    scalar_orientation(tiff, entry)?;
                    Some(1)
                }
                0x0100 | 0xa002 => Some(width),
                0x0101 | 0xa003 => Some(height),
                _ => None,
            };
            if let Some(value) = value {
                if count != 1
                    || !matches!(kind, 3 | 4)
                    || (kind == 3 && value > u32::from(u16::MAX))
                {
                    return Err(invalid());
                }
                patches.push(Patch {
                    range: tiff.range(entry + 8, size)?,
                    value,
                });
            }
            if tag == 0x8769 {
                if !primary || kind != 4 || count != 1 {
                    return Err(invalid());
                }
                next = Some((tiff.u32(entry + 8)? as usize, false));
            }
            if tag == 0x8825 {
                if kind != 4 || count != 1 {
                    return Err(invalid());
                }
                let gps = tiff.u32(entry + 8)? as usize;
                if gps < 8 {
                    return Err(invalid());
                }
                // GPS contents are opaque to this geometry-only patcher.
                external.push(tiff.range(gps, 2)?);
            }
        }
        let link = table.end - 4;
        let linked = tiff.u32(link)? as usize;
        if primary {
            if linked != 0 {
                thumbnail = Some(linked);
            }
            patches.push(Patch {
                range: link..link + 4,
                value: 0,
            });
        } else if linked != 0 {
            return Err(invalid());
        }
    }
    if let Some(offset) = thumbnail {
        if offset < 8 || visited.contains(&offset) {
            return Err(invalid());
        }
        let reference = tiff.range(offset, 2)?;
        if tables.iter().any(|r| overlaps(r, &reference)) {
            return Err(invalid());
        }
    }
    if external
        .iter()
        .any(|r| tables.iter().any(|table| overlaps(r, table)))
    {
        return Err(invalid());
    }
    let mut result = exif.to_vec();
    for patch in patches {
        let value = if patch.range.len() == 2 {
            let value = patch.value as u16;
            if little {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            }
            .to_vec()
        } else if little {
            patch.value.to_le_bytes().to_vec()
        } else {
            patch.value.to_be_bytes().to_vec()
        };
        result
            .get_mut(prefix + patch.range.start..prefix + patch.range.end)
            .ok_or_else(invalid)?
            .copy_from_slice(&value);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(little: bool) -> Vec<u8> {
        let mut bytes = if little {
            b"II".to_vec()
        } else {
            b"MM".to_vec()
        };
        let u16b = |n: u16| {
            if little {
                n.to_le_bytes()
            } else {
                n.to_be_bytes()
            }
        };
        let u32b = |n: u32| {
            if little {
                n.to_le_bytes()
            } else {
                n.to_be_bytes()
            }
        };
        bytes.extend(u16b(42));
        bytes.extend(u32b(8));
        bytes.extend(u16b(4));
        for (tag, kind, value) in [
            (0x0112, 3, 6),
            (0x0100, 4, 160),
            (0x0101, 3, 120),
            (0x8769, 4, 62),
        ] {
            bytes.extend(u16b(tag));
            bytes.extend(u16b(kind));
            bytes.extend(u32b(1));
            if kind == 3 {
                bytes.extend(u16b(value as u16));
                bytes.extend([0, 0]);
            } else {
                bytes.extend(u32b(value));
            }
        }
        bytes.extend(u32b(116));
        bytes.extend(u16b(4));
        for (tag, kind, count, value) in [
            (0xa002, 4, 1, 160),
            (0xa003, 4, 1, 120),
            (0x927c, 7, 8, 122),
            (0x8825, 4, 1, 130),
        ] {
            bytes.extend(u16b(tag));
            bytes.extend(u16b(kind));
            bytes.extend(u32b(count));
            bytes.extend(u32b(value));
        }
        bytes.extend(u32b(0));
        bytes.extend([0; 6]);
        bytes.extend(b"MAKER123");
        bytes.extend([0; 6]);
        bytes
    }
    #[test]
    fn geometry_endianness_prefix_and_opaque_bytes() {
        for little in [true, false] {
            for prefix in [false, true] {
                let bytes = fixture(little);
                let mut input = if prefix { b"Exif\0\0".to_vec() } else { vec![] };
                input.extend(&bytes);
                let output = normalize(&input, 90, 120).unwrap();
                let t = Tiff {
                    bytes: &output[if prefix { 6 } else { 0 }..],
                    little,
                };
                assert_eq!(t.u16(18).unwrap(), 1);
                assert_eq!(t.u32(30).unwrap(), 90);
                assert_eq!(t.u16(42).unwrap(), 120);
                assert_eq!(t.u32(72).unwrap(), 90);
                assert_eq!(t.u32(84).unwrap(), 120);
                assert_eq!(t.u32(58).unwrap(), 0);
                assert_eq!(&t.bytes[122..], &bytes[122..]);
            }
        }
    }
    #[test]
    fn rejects_truncation_corruption_duplicates_cycles_and_aliases() {
        let original = fixture(true);
        for end in 0..116 {
            assert!(
                normalize(&original[..end], 90, 120).is_err(),
                "length {end}"
            );
        }
        for (offset, value) in [
            (0, 0),
            (2, 43),
            (8, 255),
            (12, 5),
            (14, 2),
            (22, 0x12),
            (54, 8),
            (66, 8),
            (70, 255),
            (104, 255),
            (114, 1),
            (110, 8),
        ] {
            let mut bytes = original.clone();
            bytes[offset] = value;
            assert!(normalize(&bytes, 90, 120).is_err(), "offset {offset}");
        }
        let mut bytes = original.clone();
        bytes[110..114].copy_from_slice(&8u32.to_le_bytes());
        assert!(normalize(&bytes, 90, 120).is_err());
    }
    #[test]
    fn empty_ifd_and_missing_optional_tags_stay_empty() {
        let bytes = [b'I', b'I', 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(normalize(&bytes, 1, 1).unwrap(), bytes);
        let mut too_many = vec![0; 8 + 6 + 4097 * 12];
        too_many[..8].copy_from_slice(&bytes[..8]);
        too_many[8..10].copy_from_slice(&4097u16.to_le_bytes());
        assert!(normalize(&too_many, 1, 1).is_err());
    }
}
