#![allow(dead_code)] // Wired into PreviewService only after the separate enablement gates pass.

use std::{
    cmp::Reverse,
    collections::HashMap,
    sync::{Arc, OnceLock},
};

use libheif_rs::{
    color_profile_types, ColorProfile, ColorProfileNCLX, ColorSpace, CompressionFormat,
    DecodingOptions, HeifContext, LibHeif, RgbChroma, SecurityLimits,
};
use thiserror::Error;

pub(crate) const MAX_AXIS: u32 = 32_768;
pub(crate) const MAX_PRIMARY_PIXELS: u64 = 100_000_000;
pub(crate) const MAX_THUMBNAILS: usize = 64;
pub(crate) const MAX_THUMBNAIL_PIXELS: u64 = 4_000_000;
pub(crate) const MAX_THUMBNAIL_RGB_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const LIBHEIF_MAX_MEMORY_BLOCK_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const LIBHEIF_MAX_TOTAL_MEMORY_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const LIBHEIF_MAX_DECODING_THREADS: u32 = 1;
pub(crate) const MAX_HEIC_ICC_PROFILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CONTAINER_ITEMS: usize = 256;
const MAX_CONTAINER_BOXES: usize = 512;

type Checkpoint<'a> = dyn Fn() -> Result<(), SamplerError> + 'a;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Dimensions {
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SampleProvenance {
    EmbeddedHeicThumbnail { item_id: u32 },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SampleFrame {
    pub(crate) rgb: Arc<[u8]>,
    pub(crate) raw_icc_profile: Option<Arc<[u8]>>,
    pub(crate) primary_dimensions: Dimensions,
    pub(crate) admitted_dimensions: Dimensions,
    pub(crate) provenance: SampleProvenance,
}

#[derive(Clone, Copy, Debug)]
struct ThumbnailMetadata {
    id: u32,
    width: u32,
    height: u32,
    decoder_available: bool,
}

#[derive(Clone, Debug)]
struct DecodedRgb {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    raw_icc_profile: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug)]
struct AdmittedThumbnail {
    id: u32,
    dimensions: Dimensions,
    area: u64,
    max_edge: u32,
}

impl AdmittedThumbnail {
    fn new(id: u32, width: u32, height: u32) -> Self {
        Self {
            id,
            dimensions: Dimensions { width, height },
            area: u64::from(width) * u64::from(height),
            max_edge: width.max(height),
        }
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub(crate) enum SamplerError {
    #[error("invalid HEIC primary dimensions {width} x {height}")]
    InvalidPrimaryDimensions { width: u32, height: u32 },
    #[error("HEIC declares {count} associated thumbnails; the limit is {limit}")]
    TooManyThumbnails { count: usize, limit: usize },
    #[error("HEIC thumbnail metadata changed while it was being inspected")]
    ThumbnailListChanged,
    #[error("this source has no bounded embedded thumbnail")]
    NoAdmittedThumbnail,
    #[error("invalid decoded HEIC thumbnail: {reason}")]
    InvalidDecodedThumbnail { reason: String },
    #[error("not enough memory for the bounded HEIC thumbnail")]
    AllocationFailed,
    #[error("HEIC thumbnail sampling stopped: {reason}")]
    Interrupted { reason: String },
    #[error("invalid bounded HEIC container metadata: {reason}")]
    InvalidContainer { reason: String },
    #[error("HEIC container metadata exceeds the bounded parser work limit")]
    ContainerWorkLimitExceeded,
    #[error("libheif preview adapter failed: {0}")]
    Adapter(String),
}

/// The preview boundary exposes no operation capable of decoding the primary image.
trait HeifPreviewAdapter {
    fn primary_dimensions(&self) -> Result<Dimensions, SamplerError>;
    fn thumbnail_count(&self) -> Result<usize, SamplerError>;
    fn thumbnail_ids(&self, ids: &mut [u32]) -> Result<usize, SamplerError>;
    fn thumbnail_metadata(&self, id: u32) -> Result<ThumbnailMetadata, SamplerError>;
    fn decode_thumbnail(&self, id: u32) -> Result<DecodedRgb, SamplerError>;
}

pub(crate) fn sample_heic_thumbnail(
    bytes: &[u8],
    checkpoint: &Checkpoint<'_>,
) -> Result<SampleFrame, SamplerError> {
    let adapter = LibheifPreviewAdapter::new(bytes, checkpoint)?;
    let result = sample_from_adapter_with_checkpoint(&adapter, checkpoint);
    // Keep the borrowed input alive through context teardown before this function
    // returns. This also makes repeated calls independent of temporary lifetimes at
    // the call site.
    drop(adapter);
    result
}

pub(crate) fn inspect_heic_thumbnail(
    bytes: &[u8],
    checkpoint: &Checkpoint<'_>,
) -> Result<(), SamplerError> {
    let adapter = LibheifPreviewAdapter::new(bytes, checkpoint)?;
    let result = admitted_thumbnail(&adapter, checkpoint).map(|_| ());
    drop(adapter);
    result
}

fn sample_from_adapter(adapter: &impl HeifPreviewAdapter) -> Result<SampleFrame, SamplerError> {
    sample_from_adapter_with_checkpoint(adapter, &|| Ok(()))
}

fn sample_from_adapter_with_checkpoint(
    adapter: &impl HeifPreviewAdapter,
    checkpoint: &Checkpoint<'_>,
) -> Result<SampleFrame, SamplerError> {
    let (primary, selected) = admitted_thumbnail(adapter, checkpoint)?;
    checkpoint()?;
    let decoded = adapter.decode_thumbnail(selected.id)?;
    checkpoint()?;
    validate_decoded(selected, &decoded)?;

    Ok(SampleFrame {
        rgb: decoded.pixels.into(),
        raw_icc_profile: decoded.raw_icc_profile.map(Into::into),
        primary_dimensions: primary,
        admitted_dimensions: selected.dimensions,
        provenance: SampleProvenance::EmbeddedHeicThumbnail {
            item_id: selected.id,
        },
    })
}

fn admitted_thumbnail(
    adapter: &impl HeifPreviewAdapter,
    checkpoint: &Checkpoint<'_>,
) -> Result<(Dimensions, AdmittedThumbnail), SamplerError> {
    checkpoint()?;
    let primary = adapter.primary_dimensions()?;
    checkpoint()?;
    validate_primary(primary)?;

    checkpoint()?;
    let count = adapter.thumbnail_count()?;
    checkpoint()?;
    if count > MAX_THUMBNAILS {
        return Err(SamplerError::TooManyThumbnails {
            count,
            limit: MAX_THUMBNAILS,
        });
    }
    if count == 0 {
        return Err(SamplerError::NoAdmittedThumbnail);
    }

    let mut ids = Vec::new();
    ids.try_reserve_exact(count)
        .map_err(|_| SamplerError::AllocationFailed)?;
    ids.resize(count, 0);
    checkpoint()?;
    if adapter.thumbnail_ids(&mut ids)? != count {
        return Err(SamplerError::ThumbnailListChanged);
    }
    checkpoint()?;

    let mut admitted = Vec::new();
    admitted
        .try_reserve_exact(count)
        .map_err(|_| SamplerError::AllocationFailed)?;
    for id in ids {
        checkpoint()?;
        let metadata = adapter.thumbnail_metadata(id)?;
        checkpoint()?;
        if metadata.id != id {
            return Err(SamplerError::ThumbnailListChanged);
        }
        if let Some(candidate) = admit_thumbnail(primary, metadata) {
            admitted.push(candidate);
        }
    }

    let selected = select_candidate(&admitted).ok_or(SamplerError::NoAdmittedThumbnail)?;
    Ok((primary, selected))
}

fn validate_primary(dimensions: Dimensions) -> Result<(), SamplerError> {
    let valid_axes =
        (1..=MAX_AXIS).contains(&dimensions.width) && (1..=MAX_AXIS).contains(&dimensions.height);
    let area = u64::from(dimensions.width) * u64::from(dimensions.height);
    if valid_axes && area <= MAX_PRIMARY_PIXELS {
        Ok(())
    } else {
        Err(SamplerError::InvalidPrimaryDimensions {
            width: dimensions.width,
            height: dimensions.height,
        })
    }
}

fn admit_thumbnail(primary: Dimensions, metadata: ThumbnailMetadata) -> Option<AdmittedThumbnail> {
    if !metadata.decoder_available
        || !(1..=MAX_AXIS).contains(&metadata.width)
        || !(1..=MAX_AXIS).contains(&metadata.height)
    {
        return None;
    }

    let area = u64::from(metadata.width).checked_mul(u64::from(metadata.height))?;
    let rgb_bytes = usize::try_from(area).ok()?.checked_mul(3)?;
    let dimensions = Dimensions {
        width: metadata.width,
        height: metadata.height,
    };
    if area > MAX_THUMBNAIL_PIXELS
        || rgb_bytes > MAX_THUMBNAIL_RGB_BYTES
        || !aspect_ratio_matches(primary, dimensions)
    {
        return None;
    }

    Some(AdmittedThumbnail {
        id: metadata.id,
        dimensions,
        area,
        max_edge: metadata.width.max(metadata.height),
    })
}

fn aspect_ratio_matches(primary: Dimensions, sample: Dimensions) -> bool {
    let sample_width_primary_height = u128::from(sample.width) * u128::from(primary.height);
    let sample_height_primary_width = u128::from(sample.height) * u128::from(primary.width);
    let difference = sample_width_primary_height.abs_diff(sample_height_primary_width);
    difference * 100 <= sample_width_primary_height.max(sample_height_primary_width)
}

fn select_candidate(candidates: &[AdmittedThumbnail]) -> Option<AdmittedThumbnail> {
    candidates
        .iter()
        .copied()
        .max_by_key(|candidate| (candidate.area, candidate.max_edge, Reverse(candidate.id)))
}

fn validate_decoded(selected: AdmittedThumbnail, decoded: &DecodedRgb) -> Result<(), SamplerError> {
    if decoded.width != selected.dimensions.width || decoded.height != selected.dimensions.height {
        return Err(SamplerError::InvalidDecodedThumbnail {
            reason: format!(
                "decoded dimensions {} x {} do not match admitted dimensions {} x {}",
                decoded.width,
                decoded.height,
                selected.dimensions.width,
                selected.dimensions.height
            ),
        });
    }
    let expected = packed_rgb_len(decoded.width, decoded.height)?;
    if decoded.pixels.len() != expected {
        return Err(SamplerError::InvalidDecodedThumbnail {
            reason: format!(
                "decoded buffer has {} bytes; expected {expected}",
                decoded.pixels.len()
            ),
        });
    }
    Ok(())
}

fn packed_rgb_len(width: u32, height: u32) -> Result<usize, SamplerError> {
    let pixels = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or_else(|| SamplerError::InvalidDecodedThumbnail {
            reason: "decoded dimensions overflow addressable memory".into(),
        })?;
    let bytes = pixels
        .checked_mul(3)
        .ok_or_else(|| SamplerError::InvalidDecodedThumbnail {
            reason: "decoded RGB length overflowed".into(),
        })?;
    if bytes > MAX_THUMBNAIL_RGB_BYTES {
        return Err(SamplerError::InvalidDecodedThumbnail {
            reason: "decoded RGB length exceeds the preview limit".into(),
        });
    }
    Ok(bytes)
}

fn pack_rgb_rows(
    plane: &[u8],
    width: u32,
    height: u32,
    stride: usize,
) -> Result<Vec<u8>, SamplerError> {
    pack_rgb_rows_with_checkpoint(plane, width, height, stride, &|| Ok(()))
}

fn pack_rgb_rows_with_checkpoint(
    plane: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    checkpoint: &Checkpoint<'_>,
) -> Result<Vec<u8>, SamplerError> {
    let expected = packed_rgb_len(width, height)?;
    let row_bytes = usize::try_from(width)
        .ok()
        .and_then(|width| width.checked_mul(3))
        .ok_or_else(|| SamplerError::InvalidDecodedThumbnail {
            reason: "decoded row length overflowed".into(),
        })?;
    if stride < row_bytes {
        return Err(SamplerError::InvalidDecodedThumbnail {
            reason: format!("decoded stride {stride} is shorter than row length {row_bytes}"),
        });
    }
    let required_plane_len = usize::try_from(height)
        .ok()
        .and_then(|height| height.checked_mul(stride))
        .ok_or_else(|| SamplerError::InvalidDecodedThumbnail {
            reason: "decoded plane length overflowed".into(),
        })?;
    if plane.len() < required_plane_len {
        return Err(SamplerError::InvalidDecodedThumbnail {
            reason: format!(
                "decoded plane has {} bytes; stride and height require {required_plane_len}",
                plane.len()
            ),
        });
    }

    let mut packed = Vec::new();
    packed
        .try_reserve_exact(expected)
        .map_err(|_| SamplerError::AllocationFailed)?;
    for row in 0..usize::try_from(height).map_err(|_| SamplerError::InvalidDecodedThumbnail {
        reason: "decoded height cannot be represented".into(),
    })? {
        checkpoint()?;
        let start =
            row.checked_mul(stride)
                .ok_or_else(|| SamplerError::InvalidDecodedThumbnail {
                    reason: "decoded row offset overflowed".into(),
                })?;
        let end =
            start
                .checked_add(row_bytes)
                .ok_or_else(|| SamplerError::InvalidDecodedThumbnail {
                    reason: "decoded row end overflowed".into(),
                })?;
        let bytes = plane
            .get(start..end)
            .ok_or_else(|| SamplerError::InvalidDecodedThumbnail {
                reason: "decoded row is outside its plane".into(),
            })?;
        packed.extend_from_slice(bytes);
    }
    Ok(packed)
}

struct LibheifPreviewAdapter<'bytes, 'checkpoint> {
    context: HeifContext<'bytes>,
    lib: &'static LibHeif,
    item_types: HashMap<u32, [u8; 4]>,
    checkpoint: &'checkpoint Checkpoint<'checkpoint>,
}

impl<'bytes, 'checkpoint> LibheifPreviewAdapter<'bytes, 'checkpoint> {
    fn new(
        bytes: &'bytes [u8],
        checkpoint: &'checkpoint Checkpoint<'checkpoint>,
    ) -> Result<Self, SamplerError> {
        static LIBHEIF: OnceLock<LibHeif> = OnceLock::new();
        // Keep one process-wide initialization alive. Other converter paths create
        // temporary guards; this prevents their drops from deinitializing libheif
        // while a preview context still exists.
        let lib = LIBHEIF.get_or_init(LibHeif::new);
        if !supports_security_limits_abi(lib.version()) {
            return Err(SamplerError::Adapter(format!(
                "this bounded preview build requires libheif 1.23.x; linked version is {}.{}.{}",
                lib.version()[0],
                lib.version()[1],
                lib.version()[2]
            )));
        }

        checkpoint()?;
        let mut context = HeifContext::new().map_err(adapter_error("create context"))?;
        checkpoint()?;
        let mut limits = SecurityLimits::new();
        limits.set_max_image_size_pixels(MAX_PRIMARY_PIXELS);
        limits.set_max_color_profile_size(MAX_HEIC_ICC_PROFILE_BYTES as u32);
        limits.set_max_memory_block_size(LIBHEIF_MAX_MEMORY_BLOCK_BYTES);
        limits.set_max_total_memory(LIBHEIF_MAX_TOTAL_MEMORY_BYTES);
        context
            .set_security_limits(&limits)
            .map_err(adapter_error("configure security limits"))?;
        context.set_max_decoding_threads(LIBHEIF_MAX_DECODING_THREADS);
        checkpoint()?;
        context
            .read_bytes(bytes)
            .map_err(adapter_error("read HEIC bytes"))?;
        checkpoint()?;
        let item_types = parse_item_types(bytes, checkpoint)?;

        Ok(Self {
            context,
            lib,
            item_types,
            checkpoint,
        })
    }

    fn primary_handle(&self) -> Result<libheif_rs::ImageHandle, SamplerError> {
        self.context
            .primary_image_handle()
            .map_err(adapter_error("get primary image metadata"))
    }

    fn thumbnail_handle(&self, id: u32) -> Result<libheif_rs::ImageHandle, SamplerError> {
        self.primary_handle()?
            .thumbnail(id)
            .map_err(adapter_error("get associated thumbnail metadata"))
    }

    fn decoder_available(&self, id: u32) -> bool {
        self.item_types
            .get(&id)
            .copied()
            .and_then(compression_format_for_item_type)
            .is_some_and(|format| !self.lib.decoder_descriptors(1, Some(format)).is_empty())
    }
}

impl HeifPreviewAdapter for LibheifPreviewAdapter<'_, '_> {
    fn primary_dimensions(&self) -> Result<Dimensions, SamplerError> {
        let primary = self.primary_handle()?;
        Ok(Dimensions {
            width: primary.width(),
            height: primary.height(),
        })
    }

    fn thumbnail_count(&self) -> Result<usize, SamplerError> {
        Ok(self.primary_handle()?.number_of_thumbnails())
    }

    fn thumbnail_ids(&self, ids: &mut [u32]) -> Result<usize, SamplerError> {
        Ok(self.primary_handle()?.thumbnail_ids(ids))
    }

    fn thumbnail_metadata(&self, id: u32) -> Result<ThumbnailMetadata, SamplerError> {
        let thumbnail = self.thumbnail_handle(id)?;
        Ok(ThumbnailMetadata {
            id,
            width: thumbnail.width(),
            height: thumbnail.height(),
            decoder_available: self.decoder_available(id),
        })
    }

    fn decode_thumbnail(&self, id: u32) -> Result<DecodedRgb, SamplerError> {
        let thumbnail = self.thumbnail_handle(id)?;
        let expected = Dimensions {
            width: thumbnail.width(),
            height: thumbnail.height(),
        };
        let mut options = DecodingOptions::new()
            .ok_or_else(|| SamplerError::Adapter("allocate libheif decoding options".into()))?;
        options.set_ignore_transformations(false);
        let raw_icc_profile = thumbnail.color_profile_raw().map(|profile| {
            if !matches!(
                profile.profile_type(),
                color_profile_types::R_ICC | color_profile_types::PROF
            ) {
                return Err(SamplerError::InvalidDecodedThumbnail {
                    reason: "unsupported raw color-profile type".into(),
                });
            }
            if profile.data.len() > MAX_HEIC_ICC_PROFILE_BYTES {
                return Err(SamplerError::InvalidDecodedThumbnail {
                    reason: "embedded ICC profile exceeds 4 MiB".into(),
                });
            }
            Ok(profile.data)
        });
        let raw_icc_profile = raw_icc_profile.transpose()?;
        if raw_icc_profile.is_none() && thumbnail.color_profile_nclx().is_some() {
            let output_profile = ColorProfileNCLX::new().ok_or_else(|| {
                SamplerError::Adapter("allocate sRGB output color profile".into())
            })?;
            options.set_output_image_nclx_profile(Some(output_profile));
        }
        let image = self
            .lib
            .decode(&thumbnail, ColorSpace::Rgb(RgbChroma::Rgb), Some(options))
            .map_err(adapter_error("decode associated thumbnail"))?;
        if image.width() != expected.width || image.height() != expected.height {
            return Err(SamplerError::InvalidDecodedThumbnail {
                reason: format!(
                    "decoded image dimensions {} x {} do not match transformed handle dimensions {} x {}",
                    image.width(),
                    image.height(),
                    expected.width,
                    expected.height
                ),
            });
        }
        let plane =
            image
                .planes()
                .interleaved
                .ok_or_else(|| SamplerError::InvalidDecodedThumbnail {
                    reason: "libheif returned no interleaved RGB plane".into(),
                })?;
        if plane.width != expected.width || plane.height != expected.height {
            return Err(SamplerError::InvalidDecodedThumbnail {
                reason: format!(
                    "decoded plane dimensions {} x {} do not match transformed handle dimensions {} x {}",
                    plane.width, plane.height, expected.width, expected.height
                ),
            });
        }
        let pixels = pack_rgb_rows_with_checkpoint(
            plane.data,
            expected.width,
            expected.height,
            plane.stride,
            self.checkpoint,
        )?;
        Ok(DecodedRgb {
            width: expected.width,
            height: expected.height,
            pixels,
            raw_icc_profile,
        })
    }
}

fn supports_security_limits_abi(version: [u8; 3]) -> bool {
    version[0] == 1 && version[1] == 23
}

fn adapter_error(operation: &'static str) -> impl FnOnce(libheif_rs::HeifError) -> SamplerError {
    move |error| SamplerError::Adapter(format!("{operation}: {error}"))
}

fn compression_format_for_item_type(item_type: [u8; 4]) -> Option<CompressionFormat> {
    match &item_type {
        b"hvc1" | b"hev1" => Some(CompressionFormat::Hevc),
        b"av01" => Some(CompressionFormat::Av1),
        b"avc1" | b"avc3" => Some(CompressionFormat::Avc),
        b"jpeg" => Some(CompressionFormat::Jpeg),
        b"j2k1" => Some(CompressionFormat::Jpeg2000),
        _ => None,
    }
}

struct ParseBudget {
    boxes: usize,
}

impl ParseBudget {
    fn visit_box(&mut self, checkpoint: &Checkpoint<'_>) -> Result<(), SamplerError> {
        checkpoint()?;
        self.boxes = self
            .boxes
            .checked_add(1)
            .ok_or(SamplerError::ContainerWorkLimitExceeded)?;
        if self.boxes > MAX_CONTAINER_BOXES {
            return Err(SamplerError::ContainerWorkLimitExceeded);
        }
        Ok(())
    }
}

fn parse_item_types(
    bytes: &[u8],
    checkpoint: &Checkpoint<'_>,
) -> Result<HashMap<u32, [u8; 4]>, SamplerError> {
    let mut budget = ParseBudget { boxes: 0 };
    let mut top_level = bytes;
    let mut meta = None;
    while !top_level.is_empty() {
        budget.visit_box(checkpoint)?;
        let (kind, payload, rest) = next_box(top_level)?;
        if kind == *b"meta" && meta.replace(payload).is_some() {
            return Err(invalid_container("duplicate top-level meta box"));
        }
        top_level = rest;
    }
    let meta = meta.ok_or_else(|| invalid_container("missing top-level meta box"))?;
    if meta.first() != Some(&0) {
        return Err(invalid_container("unsupported meta box version"));
    }
    let mut children = meta
        .get(4..)
        .ok_or_else(|| invalid_container("truncated meta box"))?;
    let mut iinf = None;
    while !children.is_empty() {
        budget.visit_box(checkpoint)?;
        let (kind, payload, rest) = next_box(children)?;
        if kind == *b"iinf" && iinf.replace(payload).is_some() {
            return Err(invalid_container("duplicate item-info box"));
        }
        children = rest;
    }
    parse_item_info(
        iinf.ok_or_else(|| invalid_container("missing item-info box"))?,
        checkpoint,
        &mut budget,
    )
}

fn parse_item_info(
    iinf: &[u8],
    checkpoint: &Checkpoint<'_>,
    budget: &mut ParseBudget,
) -> Result<HashMap<u32, [u8; 4]>, SamplerError> {
    let version = *iinf
        .first()
        .ok_or_else(|| invalid_container("truncated item-info box"))?;
    let (declared_count, mut entries) = match version {
        0 => (
            usize::from(u16::from_be_bytes(
                iinf.get(4..6)
                    .ok_or_else(|| invalid_container("truncated item count"))?
                    .try_into()
                    .map_err(|_| invalid_container("invalid item count"))?,
            )),
            iinf.get(6..)
                .ok_or_else(|| invalid_container("truncated item entries"))?,
        ),
        1 => (
            usize::try_from(u32::from_be_bytes(
                iinf.get(4..8)
                    .ok_or_else(|| invalid_container("truncated item count"))?
                    .try_into()
                    .map_err(|_| invalid_container("invalid item count"))?,
            ))
            .map_err(|_| invalid_container("item count is not addressable"))?,
            iinf.get(8..)
                .ok_or_else(|| invalid_container("truncated item entries"))?,
        ),
        _ => return Err(invalid_container("unsupported item-info version")),
    };
    if declared_count > MAX_CONTAINER_ITEMS {
        return Err(SamplerError::ContainerWorkLimitExceeded);
    }

    let mut item_types = HashMap::new();
    item_types
        .try_reserve(declared_count)
        .map_err(|_| SamplerError::AllocationFailed)?;
    let mut seen = 0usize;
    while !entries.is_empty() {
        budget.visit_box(checkpoint)?;
        let (kind, payload, rest) = next_box(entries)?;
        if kind != *b"infe" {
            return Err(invalid_container("item-info contains a non-item entry"));
        }
        let (id, item_type) = parse_item_entry(payload)?;
        if item_types.insert(id, item_type).is_some() {
            return Err(invalid_container("duplicate item ID"));
        }
        seen = seen
            .checked_add(1)
            .ok_or(SamplerError::ContainerWorkLimitExceeded)?;
        checkpoint()?;
        entries = rest;
    }
    if seen != declared_count {
        return Err(invalid_container(
            "declared item count does not match item entries",
        ));
    }
    Ok(item_types)
}

fn parse_item_entry(payload: &[u8]) -> Result<(u32, [u8; 4]), SamplerError> {
    match *payload
        .first()
        .ok_or_else(|| invalid_container("truncated item entry"))?
    {
        2 => Ok((
            u16::from_be_bytes(
                payload
                    .get(4..6)
                    .ok_or_else(|| invalid_container("truncated version-2 item entry"))?
                    .try_into()
                    .map_err(|_| invalid_container("invalid version-2 item ID"))?,
            )
            .into(),
            payload
                .get(8..12)
                .ok_or_else(|| invalid_container("truncated version-2 item type"))?
                .try_into()
                .map_err(|_| invalid_container("invalid version-2 item type"))?,
        )),
        3 => Ok((
            u32::from_be_bytes(
                payload
                    .get(4..8)
                    .ok_or_else(|| invalid_container("truncated version-3 item entry"))?
                    .try_into()
                    .map_err(|_| invalid_container("invalid version-3 item ID"))?,
            ),
            payload
                .get(10..14)
                .ok_or_else(|| invalid_container("truncated version-3 item type"))?
                .try_into()
                .map_err(|_| invalid_container("invalid version-3 item type"))?,
        )),
        _ => Err(invalid_container("unsupported item-entry version")),
    }
}

type ParsedBox<'a> = ([u8; 4], &'a [u8], &'a [u8]);

fn next_box(bytes: &[u8]) -> Result<ParsedBox<'_>, SamplerError> {
    let size = u32::from_be_bytes(
        bytes
            .get(..4)
            .ok_or_else(|| invalid_container("truncated box size"))?
            .try_into()
            .map_err(|_| invalid_container("invalid box size"))?,
    ) as u64;
    let kind = bytes
        .get(4..8)
        .ok_or_else(|| invalid_container("truncated box type"))?
        .try_into()
        .map_err(|_| invalid_container("invalid box type"))?;
    let (header_len, box_len) = match size {
        0 => (
            8usize,
            u64::try_from(bytes.len()).map_err(|_| invalid_container("box is too large"))?,
        ),
        1 => (
            16usize,
            u64::from_be_bytes(
                bytes
                    .get(8..16)
                    .ok_or_else(|| invalid_container("truncated extended box size"))?
                    .try_into()
                    .map_err(|_| invalid_container("invalid extended box size"))?,
            ),
        ),
        _ => (8usize, size),
    };
    if box_len < header_len as u64 {
        return Err(invalid_container("box is shorter than its header"));
    }
    let end = usize::try_from(box_len).map_err(|_| invalid_container("box is too large"))?;
    if end > bytes.len() {
        return Err(invalid_container("box extends beyond input"));
    }
    Ok((kind, &bytes[header_len..end], &bytes[end..]))
}

fn invalid_container(reason: impl Into<String>) -> SamplerError {
    SamplerError::InvalidContainer {
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct FailAfter {
        allowed: usize,
        calls: Cell<usize>,
        reason: &'static str,
    }

    impl FailAfter {
        fn new(allowed: usize, reason: &'static str) -> Self {
            Self {
                allowed,
                calls: Cell::new(0),
                reason,
            }
        }

        fn check(&self) -> Result<(), SamplerError> {
            let calls = self.calls.get() + 1;
            self.calls.set(calls);
            if calls > self.allowed {
                Err(SamplerError::Interrupted {
                    reason: self.reason.into(),
                })
            } else {
                Ok(())
            }
        }
    }

    #[derive(Clone)]
    struct FakeAdapter {
        primary: Dimensions,
        declared_count: usize,
        thumbnails: Vec<ThumbnailMetadata>,
        decoded: Vec<(u32, DecodedRgb)>,
        ids_calls: Cell<usize>,
        metadata_calls: RefCell<Vec<u32>>,
        decode_calls: RefCell<Vec<u32>>,
    }

    impl FakeAdapter {
        fn new(primary: Dimensions, thumbnails: Vec<ThumbnailMetadata>) -> Self {
            let decoded = thumbnails
                .iter()
                .map(|thumbnail| {
                    let row_bytes = usize::try_from(thumbnail.width).unwrap() * 3;
                    (
                        thumbnail.id,
                        DecodedRgb {
                            width: thumbnail.width,
                            height: thumbnail.height,
                            pixels: vec![
                                u8::try_from(thumbnail.id).unwrap_or(0);
                                row_bytes * usize::try_from(thumbnail.height).unwrap()
                            ],
                            raw_icc_profile: None,
                        },
                    )
                })
                .collect();
            Self {
                primary,
                declared_count: thumbnails.len(),
                thumbnails,
                decoded,
                ids_calls: Cell::new(0),
                metadata_calls: RefCell::new(Vec::new()),
                decode_calls: RefCell::new(Vec::new()),
            }
        }

        fn with_declared_count(mut self, count: usize) -> Self {
            self.declared_count = count;
            self
        }

        fn with_decoded(mut self, id: u32, decoded: DecodedRgb) -> Self {
            if let Some(existing) = self
                .decoded
                .iter_mut()
                .find(|(candidate, _)| *candidate == id)
            {
                existing.1 = decoded;
            } else {
                self.decoded.push((id, decoded));
            }
            self
        }
    }

    impl HeifPreviewAdapter for FakeAdapter {
        fn primary_dimensions(&self) -> Result<Dimensions, SamplerError> {
            Ok(self.primary)
        }

        fn thumbnail_count(&self) -> Result<usize, SamplerError> {
            Ok(self.declared_count)
        }

        fn thumbnail_ids(&self, ids: &mut [u32]) -> Result<usize, SamplerError> {
            self.ids_calls.set(self.ids_calls.get() + 1);
            for (slot, thumbnail) in ids.iter_mut().zip(&self.thumbnails) {
                *slot = thumbnail.id;
            }
            Ok(ids.len().min(self.thumbnails.len()))
        }

        fn thumbnail_metadata(&self, id: u32) -> Result<ThumbnailMetadata, SamplerError> {
            self.metadata_calls.borrow_mut().push(id);
            self.thumbnails
                .iter()
                .find(|thumbnail| thumbnail.id == id)
                .copied()
                .ok_or_else(|| SamplerError::Adapter("unknown fake thumbnail".into()))
        }

        fn decode_thumbnail(&self, id: u32) -> Result<DecodedRgb, SamplerError> {
            self.decode_calls.borrow_mut().push(id);
            self.decoded
                .iter()
                .find(|(candidate, _)| *candidate == id)
                .map(|(_, decoded)| decoded.clone())
                .ok_or_else(|| SamplerError::Adapter("missing fake decode".into()))
        }
    }

    fn dimensions(width: u32, height: u32) -> Dimensions {
        Dimensions { width, height }
    }

    fn thumbnail(id: u32, width: u32, height: u32) -> ThumbnailMetadata {
        ThumbnailMetadata {
            id,
            width,
            height,
            decoder_available: true,
        }
    }

    #[test]
    fn constants_match_the_reviewed_admission_contract() {
        assert_eq!(MAX_AXIS, 32_768);
        assert_eq!(MAX_PRIMARY_PIXELS, 100_000_000);
        assert_eq!(MAX_THUMBNAILS, 64);
        assert_eq!(MAX_THUMBNAIL_PIXELS, 4_000_000);
        assert_eq!(MAX_THUMBNAIL_RGB_BYTES, 16 * 1024 * 1024);
        assert_eq!(LIBHEIF_MAX_MEMORY_BLOCK_BYTES, 32 * 1024 * 1024);
        assert_eq!(LIBHEIF_MAX_TOTAL_MEMORY_BYTES, 64 * 1024 * 1024);
        assert_eq!(LIBHEIF_MAX_DECODING_THREADS, 1);
        assert_eq!(MAX_HEIC_ICC_PROFILE_BYTES, 4 * 1024 * 1024);
    }

    #[test]
    fn security_limit_copy_is_allowed_only_for_the_matching_native_layout() {
        assert!(supports_security_limits_abi([1, 23, 0]));
        assert!(supports_security_limits_abi([1, 23, 255]));
        assert!(!supports_security_limits_abi([1, 20, 2]));
        assert!(!supports_security_limits_abi([1, 21, 2]));
        assert!(!supports_security_limits_abi([1, 24, 0]));
        assert!(!supports_security_limits_abi([2, 0, 0]));
    }

    #[test]
    fn selects_largest_area_then_largest_edge_then_lowest_id() {
        let candidates = [
            AdmittedThumbnail::new(9, 400, 300),
            AdmittedThumbnail::new(8, 600, 200),
            AdmittedThumbnail::new(7, 600, 200),
            AdmittedThumbnail::new(6, 800, 600),
        ];

        assert_eq!(select_candidate(&candidates).unwrap().id, 6);
        assert_eq!(select_candidate(&candidates[..3]).unwrap().id, 7);
    }

    #[test]
    fn samples_only_the_selected_associated_thumbnail() {
        let adapter = FakeAdapter::new(
            dimensions(4_000, 3_000),
            vec![thumbnail(9, 400, 300), thumbnail(4, 800, 600)],
        );

        let frame = sample_from_adapter(&adapter).unwrap();

        assert_eq!(adapter.decode_calls.borrow().as_slice(), &[4]);
        assert_eq!(frame.primary_dimensions, dimensions(4_000, 3_000));
        assert_eq!(frame.admitted_dimensions, dimensions(800, 600));
        assert_eq!(
            frame.provenance,
            SampleProvenance::EmbeddedHeicThumbnail { item_id: 4 }
        );
        assert_eq!(frame.rgb.len(), 800 * 600 * 3);
    }

    #[test]
    fn rejects_too_many_thumbnails_before_requesting_ids() {
        let adapter = FakeAdapter::new(dimensions(4_000, 3_000), Vec::new())
            .with_declared_count(MAX_THUMBNAILS + 1);

        assert_eq!(
            sample_from_adapter(&adapter),
            Err(SamplerError::TooManyThumbnails {
                count: MAX_THUMBNAILS + 1,
                limit: MAX_THUMBNAILS,
            })
        );
        assert_eq!(adapter.ids_calls.get(), 0);
        assert!(adapter.decode_calls.borrow().is_empty());
    }

    #[test]
    fn rejects_invalid_primary_metadata_without_decoding() {
        for primary in [
            dimensions(0, 3_000),
            dimensions(MAX_AXIS + 1, 1),
            dimensions(10_001, 10_000),
        ] {
            let adapter = FakeAdapter::new(primary, vec![thumbnail(1, 400, 300)]);
            assert!(matches!(
                sample_from_adapter(&adapter),
                Err(SamplerError::InvalidPrimaryDimensions { .. })
            ));
            assert!(adapter.decode_calls.borrow().is_empty());
        }
    }

    #[test]
    fn rejected_thumbnail_headers_never_reach_decode() {
        let cases = [
            thumbnail(1, 0, 100),
            thumbnail(1, MAX_AXIS + 1, 1),
            thumbnail(1, 2_001, 2_000),
            ThumbnailMetadata {
                decoder_available: false,
                ..thumbnail(1, 400, 300)
            },
            thumbnail(1, 102, 100),
        ];

        for candidate in cases {
            let primary = if candidate.id == 1 && candidate.width == 102 {
                dimensions(10_000, 10_000)
            } else {
                dimensions(4_000, 3_000)
            };
            let adapter = FakeAdapter::new(primary, vec![candidate]);
            assert_eq!(
                sample_from_adapter(&adapter),
                Err(SamplerError::NoAdmittedThumbnail)
            );
            assert!(adapter.decode_calls.borrow().is_empty());
        }
    }

    #[test]
    fn aspect_ratio_formula_accepts_one_percent_and_rejects_more() {
        let square = dimensions(10_000, 10_000);
        assert!(aspect_ratio_matches(square, dimensions(101, 100)));
        assert!(!aspect_ratio_matches(square, dimensions(102, 100)));
    }

    #[test]
    fn admission_handles_maximum_legal_dimensions_and_checked_overflow() {
        assert!(validate_primary(dimensions(10_000, 10_000)).is_ok());
        assert!(validate_primary(dimensions(MAX_AXIS, 3_051)).is_ok());
        assert!(validate_primary(dimensions(MAX_AXIS, 3_052)).is_err());

        let max_axis_primary = dimensions(MAX_AXIS, 122);
        assert!(admit_thumbnail(max_axis_primary, thumbnail(1, MAX_AXIS, 122)).is_some());
        assert!(admit_thumbnail(dimensions(10_000, 10_000), thumbnail(2, 2_000, 2_000)).is_some());
        assert!(admit_thumbnail(dimensions(MAX_AXIS, 123), thumbnail(1, MAX_AXIS, 123)).is_none());
        assert!(matches!(
            packed_rgb_len(u32::MAX, u32::MAX),
            Err(SamplerError::InvalidDecodedThumbnail { .. })
        ));
        assert!(aspect_ratio_matches(
            dimensions(u32::MAX, u32::MAX),
            dimensions(u32::MAX, u32::MAX)
        ));
    }

    #[test]
    fn cancellation_checkpoint_stops_remaining_metadata_and_decode_work() {
        let adapter = FakeAdapter::new(
            dimensions(4_000, 3_000),
            vec![
                thumbnail(1, 400, 300),
                thumbnail(2, 800, 600),
                thumbnail(3, 1_200, 900),
            ],
        );
        // Six checks cover primary, count, and IDs. Two more cover the first
        // metadata item; the ninth stops before the second item is queried.
        let checkpoint = FailAfter::new(8, "cancelled");

        assert_eq!(
            sample_from_adapter_with_checkpoint(&adapter, &|| checkpoint.check()),
            Err(SamplerError::Interrupted {
                reason: "cancelled".into(),
            })
        );
        assert_eq!(adapter.metadata_calls.borrow().as_slice(), &[1]);
        assert!(adapter.decode_calls.borrow().is_empty());
    }

    #[test]
    fn deadline_checkpoint_stops_before_selected_decode() {
        let adapter = FakeAdapter::new(
            dimensions(4_000, 3_000),
            vec![thumbnail(1, 400, 300), thumbnail(2, 800, 600)],
        );
        // Six setup checks plus two checks per metadata item; the eleventh
        // checkpoint is immediately before decode.
        let checkpoint = FailAfter::new(10, "deadline exceeded");

        assert_eq!(
            sample_from_adapter_with_checkpoint(&adapter, &|| checkpoint.check()),
            Err(SamplerError::Interrupted {
                reason: "deadline exceeded".into(),
            })
        );
        assert_eq!(adapter.metadata_calls.borrow().as_slice(), &[1, 2]);
        assert!(adapter.decode_calls.borrow().is_empty());
    }

    #[test]
    fn transformed_decoded_dimensions_and_length_must_match_the_admitted_header() {
        let metadata = thumbnail(3, 40, 30);
        let wrong_dimensions = FakeAdapter::new(dimensions(400, 300), vec![metadata]).with_decoded(
            3,
            DecodedRgb {
                width: 30,
                height: 40,
                pixels: vec![0; 30 * 40 * 3],
                raw_icc_profile: None,
            },
        );
        let short_pixels = FakeAdapter::new(dimensions(400, 300), vec![metadata]).with_decoded(
            3,
            DecodedRgb {
                width: 40,
                height: 30,
                pixels: vec![0; 40 * 30 * 3 - 1],
                raw_icc_profile: None,
            },
        );

        assert!(matches!(
            sample_from_adapter(&wrong_dimensions),
            Err(SamplerError::InvalidDecodedThumbnail { .. })
        ));
        assert!(matches!(
            sample_from_adapter(&short_pixels),
            Err(SamplerError::InvalidDecodedThumbnail { .. })
        ));
    }

    #[test]
    fn row_copy_accepts_padding_and_rejects_short_stride_or_plane() {
        let padded = [1, 2, 3, 4, 5, 6, 90, 91, 7, 8, 9, 10, 11, 12, 92, 93];
        assert_eq!(
            pack_rgb_rows(&padded, 2, 2, 8).unwrap(),
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
        );
        assert!(matches!(
            pack_rgb_rows(&padded, 2, 2, 5),
            Err(SamplerError::InvalidDecodedThumbnail { .. })
        ));
        assert!(matches!(
            pack_rgb_rows(&padded[..10], 2, 2, 8),
            Err(SamplerError::InvalidDecodedThumbnail { .. })
        ));
    }

    #[test]
    fn row_copy_honors_cooperative_checkpoint_between_rows() {
        let plane = [1, 2, 3, 4, 5, 6];
        let checkpoint = FailAfter::new(1, "cancelled during row copy");

        assert_eq!(
            pack_rgb_rows_with_checkpoint(&plane, 1, 2, 3, &|| checkpoint.check()),
            Err(SamplerError::Interrupted {
                reason: "cancelled during row copy".into(),
            })
        );
    }

    fn boxed(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(payload.len() + 8);
        bytes.extend_from_slice(&u32::try_from(payload.len() + 8).unwrap().to_be_bytes());
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(payload);
        bytes
    }

    fn container_with_items(items: &[(u16, &[u8; 4])]) -> Vec<u8> {
        let mut iinf = vec![0, 0, 0, 0];
        iinf.extend_from_slice(&u16::try_from(items.len()).unwrap().to_be_bytes());
        for (id, item_type) in items {
            let mut infe = vec![2, 0, 0, 0];
            infe.extend_from_slice(&id.to_be_bytes());
            infe.extend_from_slice(&0u16.to_be_bytes());
            infe.extend_from_slice(*item_type);
            infe.push(0);
            iinf.extend_from_slice(&boxed(b"infe", &infe));
        }
        let mut meta = vec![0, 0, 0, 0];
        meta.extend_from_slice(&boxed(b"iinf", &iinf));
        boxed(b"meta", &meta)
    }

    #[test]
    fn item_type_table_rejects_duplicate_ids_and_excess_box_work() {
        let duplicate = container_with_items(&[(7, b"hvc1"), (7, b"av01")]);
        assert!(matches!(
            parse_item_types(&duplicate, &|| Ok(())),
            Err(SamplerError::InvalidContainer { .. })
        ));

        let too_many_items = (0..=MAX_CONTAINER_ITEMS)
            .map(|index| (u16::try_from(index + 1).unwrap(), b"hvc1"))
            .collect::<Vec<_>>();
        assert_eq!(
            parse_item_types(&container_with_items(&too_many_items), &|| Ok(())),
            Err(SamplerError::ContainerWorkLimitExceeded)
        );

        let mut excessive = Vec::new();
        for _ in 0..=MAX_CONTAINER_BOXES {
            excessive.extend_from_slice(&boxed(b"free", &[]));
        }
        assert_eq!(
            parse_item_types(&excessive, &|| Ok(())),
            Err(SamplerError::ContainerWorkLimitExceeded)
        );
    }

    #[test]
    fn item_type_table_is_parsed_once_and_checkpointed() {
        let bytes = container_with_items(&[(1, b"hvc1"), (2, b"jpeg")]);
        let calls = Cell::new(0usize);
        let table = parse_item_types(&bytes, &|| {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .unwrap();

        assert_eq!(table.get(&1), Some(b"hvc1"));
        assert_eq!(table.get(&2), Some(b"jpeg"));
        assert!(calls.get() >= 4);

        let cancelled = FailAfter::new(1, "cancelled while parsing");
        assert_eq!(
            parse_item_types(&bytes, &|| cancelled.check()),
            Err(SamplerError::Interrupted {
                reason: "cancelled while parsing".into(),
            })
        );
    }

    #[test]
    fn production_sampling_accepts_a_cooperative_checkpoint() {
        let stopped = FailAfter::new(1, "cancelled during context creation");

        assert_eq!(
            sample_heic_thumbnail(
                include_bytes!("../tests/fixtures/heic-with-thumbnail.heic"),
                &|| stopped.check(),
            ),
            Err(SamplerError::Interrupted {
                reason: "cancelled during context creation".into(),
            })
        );
    }

    #[test]
    fn existing_heic_fixtures_without_thumbnails_fail_closed() {
        for (name, bytes) in [
            (
                "alpha.heic",
                include_bytes!("../tests/fixtures/alpha.heic").as_slice(),
            ),
            (
                "sample.heic",
                include_bytes!("../tests/fixtures/sample.heic").as_slice(),
            ),
        ] {
            assert_eq!(
                sample_heic_thumbnail(bytes, &|| Ok(())),
                Err(SamplerError::NoAdmittedThumbnail),
                "{name} must fail closed without an associated thumbnail"
            );
        }
    }

    #[test]
    fn real_associated_thumbnail_fixture_decodes_the_embedded_sample() {
        let frame = sample_heic_thumbnail(
            include_bytes!("../tests/fixtures/heic-with-thumbnail.heic"),
            &|| Ok(()),
        )
        .unwrap();

        assert_eq!(frame.primary_dimensions, dimensions(96, 72));
        assert_eq!(frame.admitted_dimensions, dimensions(32, 24));
        assert!(matches!(
            frame.provenance,
            SampleProvenance::EmbeddedHeicThumbnail { .. }
        ));
        assert_eq!(frame.rgb.len(), 32 * 24 * 3);
    }

    #[test]
    fn equal_size_large_primary_fixtures_decode_the_same_embedded_thumbnail() {
        let primary_12mp = include_bytes!("../tests/fixtures/heic-memory-primary-12mp-padded.heic");
        let primary_48mp = include_bytes!("../tests/fixtures/heic-memory-primary-48mp.heic");
        assert_eq!(primary_12mp.len(), primary_48mp.len());
        assert_eq!(
            primary_12mp.get(3_568..3_659),
            primary_48mp.get(11_626..11_717),
            "the encoded associated-thumbnail item payloads must remain byte-identical"
        );

        let frame_12mp = sample_heic_thumbnail(primary_12mp, &|| Ok(())).unwrap();
        let frame_48mp = sample_heic_thumbnail(primary_48mp, &|| Ok(())).unwrap();

        assert_eq!(frame_12mp.primary_dimensions, dimensions(4_000, 3_000));
        assert_eq!(frame_48mp.primary_dimensions, dimensions(8_000, 6_000));
        assert_eq!(frame_12mp.admitted_dimensions, dimensions(512, 384));
        assert_eq!(frame_48mp.admitted_dimensions, dimensions(512, 384));
        assert_eq!(frame_12mp.rgb, frame_48mp.rgb);
    }

    #[test]
    fn exact_pixel_limit_thumbnail_fixture_decodes_within_the_rgb_budget() {
        let frame = sample_heic_thumbnail(
            include_bytes!("../tests/fixtures/heic-memory-thumbnail-4mp.heic"),
            &|| Ok(()),
        )
        .unwrap();

        assert_eq!(frame.primary_dimensions, dimensions(3_600, 3_600));
        assert_eq!(frame.admitted_dimensions, dimensions(2_000, 2_000));
        assert_eq!(frame.rgb.len(), 2_000 * 2_000 * 3);
    }

    #[test]
    fn real_display_p3_icc_thumbnail_reaches_the_normalization_boundary() {
        use sha2::{Digest, Sha256};

        let frame = sample_heic_thumbnail(
            include_bytes!("../tests/fixtures/heic-display-p3-thumbnail.heic"),
            &|| Ok(()),
        )
        .unwrap();

        assert_eq!(frame.primary_dimensions, dimensions(192, 144));
        assert_eq!(frame.admitted_dimensions, dimensions(64, 48));
        let profile = frame
            .raw_icc_profile
            .expect("Display P3 fixture must carry a raw ICC profile");
        assert_eq!(profile.len(), 536);
        assert_eq!(profile.get(36..40), Some(b"acsp".as_slice()));
        assert_eq!(
            format!("{:x}", Sha256::digest(profile.as_ref())),
            "0ff6958f98684c61f6bbdce1368ddeaf3873baf84545baba482e920d92a914c0"
        );
    }

    #[test]
    #[ignore = "fresh-process memory evidence probe"]
    fn memory_probe_baseline_without_decode() {}

    #[test]
    #[ignore = "fresh-process memory evidence probe"]
    fn memory_probe_12mp_primary_with_512x384_thumbnail() {
        let frame = sample_heic_thumbnail(
            include_bytes!("../tests/fixtures/heic-memory-primary-12mp-padded.heic"),
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(frame.primary_dimensions, dimensions(4_000, 3_000));
        assert_eq!(frame.admitted_dimensions, dimensions(512, 384));
    }

    #[test]
    #[ignore = "fresh-process memory evidence probe"]
    fn memory_probe_48mp_primary_with_512x384_thumbnail() {
        let frame = sample_heic_thumbnail(
            include_bytes!("../tests/fixtures/heic-memory-primary-48mp.heic"),
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(frame.primary_dimensions, dimensions(8_000, 6_000));
        assert_eq!(frame.admitted_dimensions, dimensions(512, 384));
    }

    #[test]
    #[ignore = "fresh-process memory evidence probe"]
    fn memory_probe_exact_4mp_thumbnail() {
        let frame = sample_heic_thumbnail(
            include_bytes!("../tests/fixtures/heic-memory-thumbnail-4mp.heic"),
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(frame.admitted_dimensions, dimensions(2_000, 2_000));
        assert_eq!(frame.rgb.len(), 12_000_000);
    }
}
