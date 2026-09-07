use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::Path,
};

const MAX_HEADER_BYTES: u64 = 64 * 1024;
const MAX_ITEMS: usize = 256;
const MAX_GRAPH_EDGES: usize = 256;
const MAX_DERIVATION_DEPTH: usize = 8;
const MAX_RESOLUTION_WORK: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PrimaryCodec {
    Hevc,
    Av1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ResolvedCodec {
    codec: PrimaryCodec,
    subtree_depth: usize,
}

pub(crate) fn primary_item_format(
    path: &Path,
    decoded_primary_id: u32,
) -> std::io::Result<&'static str> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_HEADER_BYTES)
        .read_to_end(&mut bytes)?;
    Ok(match primary_codec(&bytes, decoded_primary_id) {
        Some(PrimaryCodec::Hevc) => "HEIC",
        Some(PrimaryCodec::Av1) => "Avif",
        _ => "HEIF",
    })
}

fn primary_codec(bytes: &[u8], decoded_primary_id: u32) -> Option<PrimaryCodec> {
    primary_codec_with_work(bytes, decoded_primary_id).map(|resolved| resolved.0)
}

fn primary_codec_with_work(bytes: &[u8], decoded_primary_id: u32) -> Option<(PrimaryCodec, usize)> {
    let meta = top_level_meta(bytes)?;
    if meta.first() != Some(&0) {
        return None;
    }
    let children = meta.get(4..)?;
    let primary_id = parse_primary_id(unique_box(children, *b"pitm")?)?;
    if primary_id != decoded_primary_id {
        return None;
    }
    let items = parse_item_info(unique_box(children, *b"iinf")?)?;
    let references = if items.get(&primary_id) == Some(b"grid") {
        parse_derived_references(unique_box(children, *b"iref")?)?
    } else {
        HashMap::new()
    };
    let mut resolver = CodecResolver::new(&items, &references);
    let codec = resolver.resolve(primary_id, 0)?.codec;
    Some((codec, resolver.work))
}

fn top_level_meta(bytes: &[u8]) -> Option<&[u8]> {
    let mut offset = 0usize;
    let mut found = None;
    while offset < bytes.len() {
        let remaining = bytes.get(offset..)?;
        let size = u32::from_be_bytes(remaining.get(..4)?.try_into().ok()?) as u64;
        let kind: [u8; 4] = remaining.get(4..8)?.try_into().ok()?;
        let (header_len, box_len) = match size {
            0 => (8usize, u64::try_from(remaining.len()).ok()?),
            1 => (
                16usize,
                u64::from_be_bytes(remaining.get(8..16)?.try_into().ok()?),
            ),
            _ => (8usize, size),
        };
        if box_len < header_len as u64 {
            return None;
        }
        let end = usize::try_from(box_len).ok()?;
        if end > remaining.len() {
            return (kind != *b"meta").then_some(found).flatten();
        }
        if kind == *b"meta" && found.replace(&remaining[header_len..end]).is_some() {
            return None;
        }
        offset = offset.checked_add(end)?;
    }
    found
}

fn parse_primary_id(payload: &[u8]) -> Option<u32> {
    match *payload.first()? {
        0 if payload.len() == 6 => Some(u16::from_be_bytes(payload[4..6].try_into().ok()?).into()),
        1 if payload.len() == 8 => Some(u32::from_be_bytes(payload[4..8].try_into().ok()?)),
        _ => None,
    }
}

fn parse_item_info(payload: &[u8]) -> Option<HashMap<u32, [u8; 4]>> {
    let version = *payload.first()?;
    let (entry_count, entries) = match version {
        0 => (
            usize::from(u16::from_be_bytes(payload.get(4..6)?.try_into().ok()?)),
            payload.get(6..)?,
        ),
        1 => (
            usize::try_from(u32::from_be_bytes(payload.get(4..8)?.try_into().ok()?)).ok()?,
            payload.get(8..)?,
        ),
        _ => return None,
    };
    if entry_count > MAX_ITEMS {
        return None;
    }

    let mut remaining = entries;
    let mut items = HashMap::with_capacity(entry_count);
    while !remaining.is_empty() {
        let (kind, entry, rest) = next_box(remaining)?;
        if kind != *b"infe" {
            return None;
        }
        let item = parse_item_entry(entry)?;
        if items.insert(item.0, item.1).is_some() {
            return None;
        }
        remaining = rest;
    }
    (items.len() == entry_count).then_some(items)
}

fn parse_item_entry(payload: &[u8]) -> Option<(u32, [u8; 4])> {
    match *payload.first()? {
        2 => Some((
            u16::from_be_bytes(payload.get(4..6)?.try_into().ok()?).into(),
            payload.get(8..12)?.try_into().ok()?,
        )),
        3 => Some((
            u32::from_be_bytes(payload.get(4..8)?.try_into().ok()?),
            payload.get(10..14)?.try_into().ok()?,
        )),
        _ => None,
    }
}

struct CodecResolver<'a> {
    items: &'a HashMap<u32, [u8; 4]>,
    references: &'a HashMap<u32, Vec<u32>>,
    memo: HashMap<u32, Option<ResolvedCodec>>,
    visiting: HashSet<u32>,
    work: usize,
}

impl<'a> CodecResolver<'a> {
    fn new(items: &'a HashMap<u32, [u8; 4]>, references: &'a HashMap<u32, Vec<u32>>) -> Self {
        Self {
            items,
            references,
            memo: HashMap::new(),
            visiting: HashSet::new(),
            work: 0,
        }
    }

    fn resolve(&mut self, item_id: u32, depth: usize) -> Option<ResolvedCodec> {
        if let Some(cached) = self.memo.get(&item_id) {
            return cached.and_then(|resolved| {
                depth
                    .checked_add(resolved.subtree_depth)
                    .filter(|deepest| *deepest < MAX_DERIVATION_DEPTH)
                    .map(|_| resolved)
            });
        }
        if depth >= MAX_DERIVATION_DEPTH || !self.visiting.insert(item_id) {
            return None;
        }
        self.work = self.work.checked_add(1)?;
        if self.work > MAX_RESOLUTION_WORK {
            self.visiting.remove(&item_id);
            return None;
        }

        let result = self.resolve_uncached(item_id, depth);
        self.visiting.remove(&item_id);
        self.memo.insert(item_id, result);
        result
    }

    fn resolve_uncached(&mut self, item_id: u32, depth: usize) -> Option<ResolvedCodec> {
        match *self.items.get(&item_id)? {
            [b'h', b'v', b'c', b'1'] => Some(ResolvedCodec {
                codec: PrimaryCodec::Hevc,
                subtree_depth: 0,
            }),
            [b'a', b'v', b'0', b'1'] => Some(ResolvedCodec {
                codec: PrimaryCodec::Av1,
                subtree_depth: 0,
            }),
            [b'g', b'r', b'i', b'd'] => {
                let targets = self.references.get(&item_id)?.clone();
                let mut codec = None;
                let mut subtree_depth = 0usize;
                for target in targets {
                    let candidate = self.resolve(target, depth.checked_add(1)?)?;
                    if codec.is_some_and(|expected| expected != candidate.codec) {
                        return None;
                    }
                    codec = Some(candidate.codec);
                    subtree_depth = subtree_depth.max(candidate.subtree_depth.checked_add(1)?);
                }
                Some(ResolvedCodec {
                    codec: codec?,
                    subtree_depth,
                })
            }
            _ => None,
        }
    }
}

fn parse_derived_references(payload: &[u8]) -> Option<HashMap<u32, Vec<u32>>> {
    let version = *payload.first()?;
    if !matches!(version, 0 | 1) {
        return None;
    }
    let mut remaining = payload.get(4..)?;
    let mut references = HashMap::new();
    let mut edge_count = 0usize;
    while !remaining.is_empty() {
        let (kind, reference, rest) = next_box(remaining)?;
        if kind == *b"dimg" {
            let (source, targets) = parse_reference(reference, version)?;
            edge_count = edge_count.checked_add(targets.len())?;
            if edge_count > MAX_GRAPH_EDGES || references.insert(source, targets).is_some() {
                return None;
            }
        }
        remaining = rest;
    }
    Some(references)
}

fn parse_reference(payload: &[u8], version: u8) -> Option<(u32, Vec<u32>)> {
    let (from_id, count, ids, id_width) = if version == 0 {
        (
            u16::from_be_bytes(payload.get(..2)?.try_into().ok()?).into(),
            usize::from(u16::from_be_bytes(payload.get(2..4)?.try_into().ok()?)),
            payload.get(4..)?,
            2usize,
        )
    } else {
        (
            u32::from_be_bytes(payload.get(..4)?.try_into().ok()?),
            usize::from(u16::from_be_bytes(payload.get(4..6)?.try_into().ok()?)),
            payload.get(6..)?,
            4usize,
        )
    };
    if count == 0 || count > MAX_ITEMS || ids.len() != count.checked_mul(id_width)? {
        return None;
    }
    let targets = ids
        .chunks_exact(id_width)
        .map(|id| {
            if version == 0 {
                Some(u16::from_be_bytes(id.try_into().ok()?).into())
            } else {
                Some(u32::from_be_bytes(id.try_into().ok()?))
            }
        })
        .collect::<Option<Vec<_>>>()?;
    let unique_targets: HashSet<_> = targets.iter().copied().collect();
    if unique_targets.len() != targets.len() {
        return None;
    }
    Some((from_id, targets))
}

fn unique_box(bytes: &[u8], expected: [u8; 4]) -> Option<&[u8]> {
    let mut remaining = bytes;
    let mut found = None;
    while !remaining.is_empty() {
        let (kind, payload, rest) = next_box(remaining)?;
        if kind == expected && found.replace(payload).is_some() {
            return None;
        }
        remaining = rest;
    }
    found
}

fn next_box(bytes: &[u8]) -> Option<([u8; 4], &[u8], &[u8])> {
    let size = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as u64;
    let kind = bytes.get(4..8)?.try_into().ok()?;
    let (header_len, box_len) = match size {
        0 => (8usize, u64::try_from(bytes.len()).ok()?),
        1 => (
            16usize,
            u64::from_be_bytes(bytes.get(8..16)?.try_into().ok()?),
        ),
        _ => (8usize, size),
    };
    if box_len < header_len as u64 {
        return None;
    }
    let end = usize::try_from(box_len).ok()?;
    if end > bytes.len() {
        return None;
    }
    Some((kind, &bytes[header_len..end], &bytes[end..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boxed(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(payload.len() + 8);
        bytes.extend_from_slice(&u32::try_from(payload.len() + 8).unwrap().to_be_bytes());
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(payload);
        bytes
    }

    fn header(primary_id: u16, items: &[(u16, &[u8; 4])], references: &[(u16, &[u16])]) -> Vec<u8> {
        let mut pitm = vec![0, 0, 0, 0];
        pitm.extend_from_slice(&primary_id.to_be_bytes());
        let mut iinf = vec![0, 0, 0, 0];
        iinf.extend_from_slice(&u16::try_from(items.len()).unwrap().to_be_bytes());
        for (item_id, item_type) in items {
            let mut infe = vec![2, 0, 0, 0];
            infe.extend_from_slice(&item_id.to_be_bytes());
            infe.extend_from_slice(&0u16.to_be_bytes());
            infe.extend_from_slice(*item_type);
            infe.push(0);
            iinf.extend_from_slice(&boxed(b"infe", &infe));
        }
        let mut meta = vec![0, 0, 0, 0];
        meta.extend_from_slice(&boxed(b"pitm", &pitm));
        meta.extend_from_slice(&boxed(b"iinf", &iinf));
        if !references.is_empty() {
            let mut iref = vec![0, 0, 0, 0];
            for (from_id, targets) in references {
                let mut dimg = Vec::new();
                dimg.extend_from_slice(&from_id.to_be_bytes());
                dimg.extend_from_slice(&u16::try_from(targets.len()).unwrap().to_be_bytes());
                for target in *targets {
                    dimg.extend_from_slice(&target.to_be_bytes());
                }
                iref.extend_from_slice(&boxed(b"dimg", &dimg));
            }
            meta.extend_from_slice(&boxed(b"iref", &iref));
        }
        boxed(b"meta", &meta)
    }

    #[test]
    fn requires_the_decoded_primary_item_to_match() {
        let hevc = header(7, &[(7, b"hvc1")], &[]);
        assert_eq!(primary_codec(&hevc, 7), Some(PrimaryCodec::Hevc));
        assert_eq!(primary_codec(&hevc, 8), None);

        let av1 = header(7, &[(7, b"av01")], &[]);
        assert_eq!(primary_codec(&av1, 7), Some(PrimaryCodec::Av1));
    }

    #[test]
    fn resolves_grid_primary_only_when_all_tiles_use_one_codec() {
        let hevc_grid = header(
            1,
            &[(1, b"grid"), (2, b"hvc1"), (3, b"hvc1")],
            &[(1, &[2, 3])],
        );
        assert_eq!(primary_codec(&hevc_grid, 1), Some(PrimaryCodec::Hevc));

        let mixed_grid = header(
            1,
            &[(1, b"grid"), (2, b"hvc1"), (3, b"av01")],
            &[(1, &[2, 3])],
        );
        assert_eq!(primary_codec(&mixed_grid, 1), None);

        let cycle = header(1, &[(1, b"grid"), (2, b"grid")], &[(1, &[2]), (2, &[1])]);
        assert_eq!(primary_codec(&cycle, 1), None);
    }

    #[test]
    fn memoizes_legal_layered_shared_subgraphs() {
        let shared = header(
            1,
            &[
                (1, b"grid"),
                (2, b"grid"),
                (3, b"grid"),
                (4, b"grid"),
                (5, b"grid"),
                (6, b"hvc1"),
                (7, b"hvc1"),
            ],
            &[
                (1, &[2, 3]),
                (2, &[4, 5]),
                (3, &[4, 5]),
                (4, &[6, 7]),
                (5, &[6, 7]),
            ],
        );
        assert_eq!(
            primary_codec_with_work(&shared, 1),
            Some((PrimaryCodec::Hevc, 7))
        );
    }

    #[test]
    fn cached_subgraph_cannot_bypass_depth_limit() {
        let deep_shared = header(
            1,
            &[
                (1, b"grid"),
                (2, b"grid"),
                (3, b"grid"),
                (4, b"grid"),
                (5, b"hvc1"),
                (6, b"grid"),
                (7, b"grid"),
                (8, b"grid"),
                (9, b"grid"),
                (10, b"grid"),
            ],
            &[
                (1, &[2, 3]),
                (2, &[4]),
                (3, &[6]),
                (4, &[5]),
                (6, &[7]),
                (7, &[8]),
                (8, &[9]),
                (9, &[10]),
                (10, &[4]),
            ],
        );
        assert_eq!(primary_codec(&deep_shared, 1), None);
    }

    #[test]
    fn repeated_grid_fanout_fails_closed() {
        let repeated = [2; 64];
        let fanout = header(1, &[(1, b"grid"), (2, b"hvc1")], &[(1, &repeated)]);
        assert_eq!(primary_codec(&fanout, 1), None);

        let root_targets = [2];
        let too_many_targets: Vec<u16> = (1..=256).collect();
        let too_many_edges = header(
            1,
            &[(1, b"grid"), (2, b"hvc1")],
            &[
                (1, root_targets.as_slice()),
                (3, too_many_targets.as_slice()),
            ],
        );
        assert_eq!(primary_codec(&too_many_edges, 1), None);
    }

    #[test]
    fn malformed_or_ambiguous_metadata_fails_closed() {
        let mut duplicate = header(7, &[(7, b"hvc1")], &[]);
        duplicate.extend_from_slice(&header(7, &[(7, b"hvc1")], &[]));
        assert_eq!(primary_codec(&duplicate, 7), None);

        let mut truncated = header(7, &[(7, b"hvc1")], &[]);
        truncated.pop();
        assert_eq!(primary_codec(&truncated, 7), None);

        let mut oversized_meta = header(7, &[(7, b"hvc1")], &[]);
        oversized_meta[..4].copy_from_slice(&100_000u32.to_be_bytes());
        assert_eq!(primary_codec(&oversized_meta, 7), None);
    }

    #[test]
    fn ignores_bounded_prefix_of_trailing_media_data() {
        let mut bytes = header(7, &[(7, b"hvc1")], &[]);
        bytes.extend_from_slice(&100_000u32.to_be_bytes());
        bytes.extend_from_slice(b"mdat");
        bytes.extend_from_slice(&[0; 16]);
        assert_eq!(primary_codec(&bytes, 7), Some(PrimaryCodec::Hevc));
    }
}
