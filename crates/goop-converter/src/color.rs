use goop_core::{GoopError, ImageColorHandling, ImageColorPolicy};
use image::{ColorType, DynamicImage, ImageDecoder, ImageFormat, RgbImage};
use img_parts::jpeg::Jpeg;
use img_parts::png::Png;
use img_parts::{Bytes, ImageEXIF, ImageICC};
use lcms2::{Intent, PixelFormat, Profile, ThreadContext, Transform};
use std::fs::File;
use std::io::{self, Cursor, Read, Write};
use std::path::Path;
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub(crate) const MAX_ICC_BYTES: usize = 15 * 1024 * 1024;
const MAX_COLOR_DIMENSION: u32 = 32_768;
const MAX_COLOR_PIXELS: u64 = 16_000_000;
const MAX_COLOR_OUTPUT_BYTES: usize = 96 * 1024 * 1024;
pub(crate) const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;
const TRANSFORM_CHUNK_PIXELS: usize = 4_096;
static COLOR_WORKING_SET: Mutex<()> = Mutex::new(());

pub(crate) struct TransformResult {
    pub pixels: RgbImage,
    pub destination_profile: Vec<u8>,
    pub handling: ImageColorHandling,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SourceLayout {
    Rgb8,
    Gray8,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceInspection {
    pub layout: SourceLayout,
    pub profile: Option<Vec<u8>>,
    pub orientation: image::metadata::Orientation,
    pub has_exif: bool,
    pub dimensions: (u32, u32),
}

pub(crate) struct PreparedSource {
    bytes: Bytes,
    pub inspection: SourceInspection,
}

fn invalid(message: impl Into<String>) -> GoopError {
    GoopError::InvalidRequest(message.into())
}

fn encoding_error(cancel: &CancellationToken, message: impl FnOnce() -> String) -> GoopError {
    if cancel.is_cancelled() {
        GoopError::Cancelled
    } else {
        invalid(message())
    }
}

pub(crate) fn validate_profile(profile: &[u8]) -> Result<&[u8; 4], GoopError> {
    if profile.len() < 132 {
        return Err(invalid(
            "ICC profile is shorter than its header and tag-count field",
        ));
    }
    if profile.len() > MAX_ICC_BYTES {
        return Err(invalid(format!(
            "ICC profile exceeds the {MAX_ICC_BYTES} byte safety limit"
        )));
    }
    let declared = usize::try_from(u32::from_be_bytes(
        profile[0..4]
            .try_into()
            .map_err(|_| invalid("ICC profile declared length is missing"))?,
    ))
    .map_err(|_| invalid("ICC profile declared length is unsupported"))?;
    if declared != profile.len() {
        return Err(invalid(
            "ICC profile declared length does not match its payload",
        ));
    }
    if profile.get(36..40) != Some(b"acsp") {
        return Err(invalid("ICC profile signature is invalid"));
    }
    if !matches!(profile[8], 2 | 4) {
        return Err(invalid("ICC profile must use version 2 or version 4"));
    }
    if !matches!(profile.get(12..16), Some(b"scnr" | b"mntr" | b"spac")) {
        return Err(invalid(
            "ICC profile class is not supported for source conversion",
        ));
    }
    if !matches!(profile.get(20..24), Some(b"XYZ " | b"Lab ")) {
        return Err(invalid("ICC profile connection space must be XYZ or Lab"));
    }
    let intent = u32::from_be_bytes(
        profile[64..68]
            .try_into()
            .map_err(|_| invalid("ICC rendering intent is missing"))?,
    );
    if intent > 3 {
        return Err(invalid("ICC rendering intent is invalid"));
    }
    let tag_count = usize::try_from(u32::from_be_bytes(
        profile[128..132]
            .try_into()
            .map_err(|_| invalid("ICC tag count is missing"))?,
    ))
    .map_err(|_| invalid("ICC tag count is unsupported"))?;
    if tag_count > 4096 {
        return Err(invalid("ICC profile contains too many tags"));
    }
    let table_end = 132usize
        .checked_add(
            tag_count
                .checked_mul(12)
                .ok_or_else(|| invalid("ICC tag table size overflow"))?,
        )
        .filter(|end| *end <= profile.len())
        .ok_or_else(|| invalid("ICC tag table is truncated"))?;
    let mut ranges: Vec<std::ops::Range<usize>> = Vec::with_capacity(tag_count);
    for index in 0..tag_count {
        let entry = 132 + index * 12;
        let offset = usize::try_from(u32::from_be_bytes(
            profile[entry + 4..entry + 8].try_into().unwrap(),
        ))
        .map_err(|_| invalid("ICC tag offset is unsupported"))?;
        let size = usize::try_from(u32::from_be_bytes(
            profile[entry + 8..entry + 12].try_into().unwrap(),
        ))
        .map_err(|_| invalid("ICC tag size is unsupported"))?;
        let end = offset
            .checked_add(size)
            .filter(|end| offset >= table_end && *end <= profile.len() && offset % 4 == 0)
            .ok_or_else(|| invalid("ICC tag range is invalid"))?;
        let range = offset..end;
        if ranges.iter().any(|seen| {
            !(seen.start == range.start && seen.end == range.end)
                && seen.start < range.end
                && range.start < seen.end
        }) {
            return Err(invalid("ICC tag payloads partially overlap"));
        }
        ranges.push(range);
    }
    let color_space: &[u8; 4] = profile[16..20]
        .try_into()
        .map_err(|_| invalid("ICC profile color space is missing"))?;
    if !matches!(color_space, b"RGB " | b"GRAY") {
        return Err(invalid(
            "Convert to sRGB currently supports only RGB and grayscale ICC profiles",
        ));
    }
    Ok(color_space)
}

fn checkpoint(cancel: &CancellationToken) -> Result<(), GoopError> {
    if cancel.is_cancelled() {
        Err(GoopError::Cancelled)
    } else {
        Ok(())
    }
}

pub(crate) fn acquire_working_set(
    cancel: &CancellationToken,
) -> Result<MutexGuard<'static, ()>, GoopError> {
    loop {
        checkpoint(cancel)?;
        match COLOR_WORKING_SET.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(10)),
            Err(TryLockError::Poisoned(_)) => {
                return Err(invalid("Color-managed working-set lock is unavailable"));
            }
        }
    }
}

fn validate_color_dimensions(dimensions: (u32, u32)) -> Result<(), GoopError> {
    let pixels = u64::from(dimensions.0)
        .checked_mul(u64::from(dimensions.1))
        .ok_or_else(|| invalid("Color-managed raster dimensions overflow"))?;
    if dimensions.0 > MAX_COLOR_DIMENSION || dimensions.1 > MAX_COLOR_DIMENSION {
        return Err(invalid(
            "Color-managed input exceeds the 32,768-pixel per-axis limit",
        ));
    }
    if pixels == 0 || pixels > MAX_COLOR_PIXELS {
        return Err(invalid(
            "Color-managed input exceeds the 16-million-pixel working-set limit",
        ));
    }
    Ok(())
}

struct BoundedWriter {
    bytes: Vec<u8>,
    limit: usize,
    cancel: CancellationToken,
    #[cfg(test)]
    reserve_count: usize,
}

impl BoundedWriter {
    fn new(limit: usize, cancel: &CancellationToken) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            cancel: cancel.clone(),
            #[cfg(test)]
            reserve_count: 0,
        }
    }

    fn into_inner(self) -> Vec<u8> {
        self.bytes
    }
}

impl Write for BoundedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.cancel.is_cancelled() {
            return Err(io::Error::other("color-managed encoding was cancelled"));
        }
        let length = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .filter(|length| *length <= self.limit)
            .ok_or_else(|| io::Error::other("color-managed encoded output exceeds its limit"))?;
        if length > self.bytes.capacity() {
            const INITIAL_CAPACITY: usize = 4 * 1024;
            let target_capacity = length
                .max(self.bytes.capacity().saturating_mul(2))
                .max(INITIAL_CAPACITY)
                .min(self.limit);
            self.bytes
                .try_reserve_exact(target_capacity - self.bytes.len())
                .map_err(|_| io::Error::other("insufficient memory for color-managed output"))?;
            #[cfg(test)]
            {
                self.reserve_count += 1;
            }
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn allocate_rgb(width: u32, height: u32) -> Result<RgbImage, GoopError> {
    let length = usize::try_from(
        u64::from(width)
            .checked_mul(u64::from(height))
            .and_then(|pixels| pixels.checked_mul(3))
            .ok_or_else(|| invalid("Color-managed destination raster size overflow"))?,
    )
    .map_err(|_| invalid("Color-managed destination raster is too large"))?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| invalid("Insufficient memory for color-managed destination raster"))?;
    bytes.resize(length, 0);
    RgbImage::from_raw(width, height, bytes)
        .ok_or_else(|| invalid("Color-managed destination raster shape is invalid"))
}

#[derive(Debug)]
struct EncodedFacts {
    layout: SourceLayout,
    profile: Option<Vec<u8>>,
    dimensions: (u32, u32),
    has_exif: bool,
}

fn read_u32(bytes: &[u8], offset: usize, label: &str) -> Result<u32, GoopError> {
    bytes
        .get(offset..offset + 4)
        .ok_or_else(|| invalid(format!("{label} is truncated")))?
        .try_into()
        .map(u32::from_be_bytes)
        .map_err(|_| invalid(format!("{label} is truncated")))
}

fn is_sof(marker: u8) -> bool {
    matches!(
        marker,
        0xc0 | 0xc1 | 0xc2 | 0xc3 | 0xc5 | 0xc6 | 0xc7 | 0xc9 | 0xca | 0xcb | 0xcd | 0xce | 0xcf
    )
}

fn inspect_jpeg(bytes: &[u8]) -> Result<EncodedFacts, GoopError> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return Err(invalid("JPEG signature is invalid"));
    }
    let mut offset = 2usize;
    let mut frame = None;
    let mut has_exif = false;
    let mut icc_parts: Option<Vec<Option<&[u8]>>> = None;
    let mut icc_total = 0usize;
    while offset < bytes.len() {
        if bytes[offset] != 0xff {
            return Err(invalid("JPEG marker stream is malformed"));
        }
        while bytes.get(offset) == Some(&0xff) {
            offset += 1;
        }
        let marker = *bytes
            .get(offset)
            .ok_or_else(|| invalid("JPEG marker is truncated"))?;
        offset += 1;
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length = usize::from(u16::from_be_bytes(
            bytes
                .get(offset..offset + 2)
                .ok_or_else(|| invalid("JPEG segment length is truncated"))?
                .try_into()
                .map_err(|_| invalid("JPEG segment length is truncated"))?,
        ));
        if length < 2 {
            return Err(invalid("JPEG segment length is invalid"));
        }
        let data_start = offset + 2;
        let data_end = offset
            .checked_add(length)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| invalid("JPEG segment exceeds the encoded snapshot"))?;
        let data = &bytes[data_start..data_end];
        if is_sof(marker) {
            if frame.is_some() || data.len() < 6 {
                return Err(invalid(
                    "JPEG must contain exactly one complete frame header",
                ));
            }
            if data[0] != 8 {
                return Err(invalid("Color-managed JPEG input must use 8-bit samples"));
            }
            let height = u32::from(u16::from_be_bytes([data[1], data[2]]));
            let width = u32::from(u16::from_be_bytes([data[3], data[4]]));
            let components = data[5];
            let layout = match components {
                1 => SourceLayout::Gray8,
                3 => SourceLayout::Rgb8,
                4 => {
                    return Err(invalid(
                        "CMYK and YCCK JPEG color conversion is not available yet",
                    ));
                }
                _ => return Err(invalid("JPEG component layout is unsupported")),
            };
            let expected = 6usize
                .checked_add(usize::from(components) * 3)
                .ok_or_else(|| invalid("JPEG component table size overflow"))?;
            if width == 0 || height == 0 || data.len() < expected {
                return Err(invalid("JPEG frame geometry or component table is invalid"));
            }
            frame = Some((layout, (width, height)));
        } else if marker == 0xe1 && data.starts_with(b"Exif\0\0") {
            if has_exif {
                return Err(invalid("Multiple JPEG EXIF segments are ambiguous"));
            }
            has_exif = true;
        } else if marker == 0xe2 && data.starts_with(b"ICC_PROFILE\0") {
            let fields = data
                .get(12..14)
                .ok_or_else(|| invalid("JPEG ICC sequence header is truncated"))?;
            if fields[0] == 0 || fields[1] == 0 || fields[0] > fields[1] {
                return Err(invalid("JPEG ICC sequence header is invalid"));
            }
            let count = usize::from(fields[1]);
            let parts = if let Some(parts) = icc_parts.as_mut() {
                if parts.len() != count {
                    return Err(invalid("JPEG ICC sequence count is inconsistent"));
                }
                parts
            } else {
                let mut parts = Vec::new();
                parts
                    .try_reserve_exact(count)
                    .map_err(|_| invalid("Insufficient memory for JPEG ICC sequence"))?;
                parts.resize(count, None);
                icc_parts.insert(parts)
            };
            let index = usize::from(fields[0] - 1);
            if parts[index].is_some() {
                return Err(invalid("JPEG ICC sequence contains a duplicate segment"));
            }
            let payload = &data[14..];
            icc_total = icc_total
                .checked_add(payload.len())
                .filter(|size| *size <= MAX_ICC_BYTES)
                .ok_or_else(|| invalid("JPEG ICC profile exceeds the safety limit"))?;
            parts[index] = Some(payload);
        }
        offset = data_end;
    }
    let (layout, dimensions) = frame.ok_or_else(|| invalid("JPEG frame header is missing"))?;
    let profile = if let Some(parts) = icc_parts {
        if parts.iter().any(Option::is_none) {
            return Err(invalid("JPEG ICC sequence is incomplete or inconsistent"));
        }
        let mut profile = Vec::new();
        profile
            .try_reserve_exact(icc_total)
            .map_err(|_| invalid("Insufficient memory for the bounded ICC profile"))?;
        for part in parts {
            profile.extend_from_slice(part.expect("completeness checked"));
        }
        Some(profile)
    } else {
        None
    };
    Ok(EncodedFacts {
        layout,
        profile,
        dimensions,
        has_exif,
    })
}

fn inspect_png(bytes: &[u8]) -> Result<EncodedFacts, GoopError> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(invalid("PNG signature is invalid"));
    }
    let mut offset = 8usize;
    let mut chunks = 0usize;
    let mut header = None;
    let mut profile = None;
    let mut has_exif = false;
    let mut saw_idat = false;
    let mut saw_iend = false;
    while offset < bytes.len() {
        chunks = chunks
            .checked_add(1)
            .filter(|count| *count <= 16_384)
            .ok_or_else(|| invalid("PNG contains too many chunks"))?;
        let length = usize::try_from(read_u32(bytes, offset, "PNG chunk length")?)
            .map_err(|_| invalid("PNG chunk length is unsupported"))?;
        let kind = bytes
            .get(offset + 4..offset + 8)
            .ok_or_else(|| invalid("PNG chunk type is truncated"))?;
        let data_start = offset + 8;
        let data_end = data_start
            .checked_add(length)
            .filter(|end| {
                end.checked_add(4)
                    .is_some_and(|crc_end| crc_end <= bytes.len())
            })
            .ok_or_else(|| invalid("PNG chunk exceeds the encoded snapshot"))?;
        let data = &bytes[data_start..data_end];
        let expected_crc = read_u32(bytes, data_end, "PNG chunk CRC")?;
        let mut crc = crc32fast::Hasher::new();
        crc.update(kind);
        crc.update(data);
        if crc.finalize() != expected_crc {
            return Err(invalid("PNG chunk CRC is invalid"));
        }
        match kind {
            b"IHDR" => {
                if header.is_some() || chunks != 1 || data.len() != 13 {
                    return Err(invalid("PNG must begin with exactly one IHDR chunk"));
                }
                let width = read_u32(data, 0, "PNG width")?;
                let height = read_u32(data, 4, "PNG height")?;
                if data[8] != 8 || !matches!(data[9], 0 | 2) {
                    return Err(invalid(
                        "Color-managed PNG input must be 8-bit RGB or grayscale without alpha",
                    ));
                }
                if data[10..13] != [0, 0, 0] || width == 0 || height == 0 {
                    return Err(invalid("PNG header methods or dimensions are invalid"));
                }
                header = Some((
                    if data[9] == 0 {
                        SourceLayout::Gray8
                    } else {
                        SourceLayout::Rgb8
                    },
                    (width, height),
                ));
            }
            b"iCCP" => {
                if profile.is_some() || saw_idat {
                    return Err(invalid("PNG ICC profile is duplicate or out of order"));
                }
                let name_end = data
                    .iter()
                    .position(|byte| *byte == 0)
                    .ok_or_else(|| invalid("PNG ICC profile name is malformed"))?;
                if name_end == 0 || name_end > 79 || data.get(name_end + 1) != Some(&0) {
                    return Err(invalid("PNG ICC profile header is invalid"));
                }
                let compressed = data
                    .get(name_end + 2..)
                    .ok_or_else(|| invalid("PNG ICC profile payload is missing"))?;
                let mut inflater = flate2::read::ZlibDecoder::new(compressed);
                profile = Some(crate::image_read::read_snapshot(
                    &mut inflater,
                    MAX_ICC_BYTES as u64,
                    "PNG ICC profile exceeds the safety limit",
                    || Ok(()),
                )?);
            }
            b"eXIf" => {
                if has_exif {
                    return Err(invalid("Multiple PNG EXIF chunks are ambiguous"));
                }
                has_exif = true;
            }
            b"IDAT" => saw_idat = true,
            b"IEND" => {
                if saw_iend || !saw_idat || !data.is_empty() {
                    return Err(invalid("PNG IEND chunk is invalid"));
                }
                saw_iend = true;
                offset = data_end + 4;
                if offset != bytes.len() {
                    return Err(invalid("PNG contains trailing data after IEND"));
                }
                break;
            }
            b"tRNS" | b"PLTE" | b"acTL" | b"fcTL" | b"fdAT" | b"sRGB" | b"gAMA" | b"cHRM"
            | b"cICP" | b"mDCV" | b"cLLI" => {
                return Err(invalid(
                    "PNG contains transparency, animation, palette, or conflicting color description data",
                ));
            }
            _ => {}
        }
        offset = data_end + 4;
    }
    if !saw_iend {
        return Err(invalid("PNG IEND chunk is missing"));
    }
    let (layout, dimensions) = header.ok_or_else(|| invalid("PNG IHDR chunk is missing"))?;
    Ok(EncodedFacts {
        layout,
        profile: profile.map(|bytes| bytes.to_vec()),
        dimensions,
        has_exif,
    })
}

fn inspect_encoded(bytes: &[u8]) -> Result<EncodedFacts, GoopError> {
    if bytes.starts_with(&[0xff, 0xd8]) {
        inspect_jpeg(bytes)
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        inspect_png(bytes)
    } else {
        Err(invalid(
            "Color-managed conversion is available only for JPEG and PNG sources",
        ))
    }
}

fn decoder_for(bytes: Bytes, max_alloc: u64) -> Result<impl ImageDecoder + 'static, GoopError> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| invalid(format!("Could not identify image encoding: {error}")))?;
    if !matches!(reader.format(), Some(ImageFormat::Jpeg | ImageFormat::Png)) {
        return Err(invalid(
            "Color-managed conversion is available only for JPEG and PNG sources",
        ));
    }
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(max_alloc);
    reader.limits(limits);
    reader
        .into_decoder()
        .map_err(|error| invalid(format!("Could not inspect image encoding: {error}")))
}

pub(crate) fn inspect_bytes(bytes: Bytes) -> Result<SourceInspection, GoopError> {
    let encoded = inspect_encoded(&bytes)?;
    validate_color_dimensions(encoded.dimensions)?;
    if let Some(profile) = encoded.profile.as_deref() {
        let space = validate_profile(profile)?;
        let expected = match encoded.layout {
            SourceLayout::Rgb8 => b"RGB ",
            SourceLayout::Gray8 => b"GRAY",
        };
        if space != expected {
            return Err(invalid(
                "The embedded ICC profile does not match the encoded pixel layout",
            ));
        }
    }
    let mut decoder = decoder_for(bytes, crate::jpeg_controls::MAX_ALLOC)?;
    let dimensions = decoder.dimensions();
    if dimensions != encoded.dimensions {
        return Err(invalid(
            "Decoded dimensions do not match the encoded container",
        ));
    }
    crate::jpeg_controls::check_raster(
        dimensions.0,
        dimensions.1,
        u64::from(decoder.color_type().bytes_per_pixel()),
    )?;
    let decoded_layout = match decoder.color_type() {
        ColorType::Rgb8 => SourceLayout::Rgb8,
        ColorType::L8 => SourceLayout::Gray8,
        ColorType::Rgba8 | ColorType::La8 => {
            return Err(invalid(
                "Color-managed conversion with transparency is not available yet",
            ));
        }
        _ => {
            return Err(invalid(
                "Color-managed conversion currently supports only 8-bit RGB or grayscale pixels",
            ));
        }
    };
    if decoded_layout != encoded.layout {
        return Err(invalid(
            "Decoded pixel layout does not match the encoded container",
        ));
    }
    let orientation = decoder
        .orientation()
        .map_err(|error| invalid(format!("Could not determine image orientation: {error}")))?;
    Ok(SourceInspection {
        layout: encoded.layout,
        profile: encoded.profile,
        orientation,
        has_exif: encoded.has_exif,
        dimensions: encoded.dimensions,
    })
}

/// Performs native parser admission for capability inspection. Conversion
/// defers this to `transform_pixels`, so each execution gives the untrusted
/// profile bytes to Little CMS exactly once.
pub(crate) fn validate_native_profile(inspection: &SourceInspection) -> Result<(), GoopError> {
    if let Some(profile) = inspection.profile.as_deref() {
        let profile_space = validate_profile(profile)?;
        let context = ThreadContext::new();
        let source = Profile::new_icc_context(&context, profile)
            .map_err(|error| invalid(format!("ICC profile could not be parsed: {error}")))?;
        let destination = Profile::new_srgb_context(&context);
        match (inspection.layout, profile_space) {
            (SourceLayout::Rgb8, b"RGB ") => {
                let _: Transform<[u8; 3], [u8; 3], ThreadContext> = Transform::new_context(
                    &context,
                    &source,
                    PixelFormat::RGB_8,
                    &destination,
                    PixelFormat::RGB_8,
                    Intent::Perceptual,
                )
                .map_err(|error| invalid(format!("ICC transform could not be created: {error}")))?;
            }
            (SourceLayout::Gray8, b"GRAY") => {
                let _: Transform<u8, [u8; 3], ThreadContext> = Transform::new_context(
                    &context,
                    &source,
                    PixelFormat::GRAY_8,
                    &destination,
                    PixelFormat::RGB_8,
                    Intent::Perceptual,
                )
                .map_err(|error| invalid(format!("ICC transform could not be created: {error}")))?;
            }
            _ => {
                return Err(invalid(
                    "The ICC profile color space does not match the source pixels",
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn prepare_path(
    input: &Path,
    cancel: &CancellationToken,
) -> Result<PreparedSource, GoopError> {
    checkpoint(cancel)?;
    let file = File::open(input)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(invalid("Color-managed conversion requires a file"));
    }
    let bytes = crate::image_read::read_snapshot(
        file,
        MAX_INPUT_BYTES,
        "Color-managed image input exceeds the 64 MiB limit",
        || checkpoint(cancel),
    )?;
    let inspection = inspect_bytes(bytes.clone())?;
    checkpoint(cancel)?;
    Ok(PreparedSource { bytes, inspection })
}

pub(crate) fn prepare_bytes(bytes: Bytes) -> Result<PreparedSource, GoopError> {
    let inspection = inspect_bytes(bytes.clone())?;
    Ok(PreparedSource { bytes, inspection })
}

impl PreparedSource {
    pub(crate) fn decode(&self) -> Result<DynamicImage, GoopError> {
        let decoder = decoder_for(self.bytes.clone(), crate::jpeg_controls::MAX_ALLOC)?;
        let mut pixels = DynamicImage::from_decoder(decoder)
            .map_err(|error| invalid(format!("Could not decode color-managed image: {error}")))?;
        pixels.apply_orientation(self.inspection.orientation);
        Ok(pixels)
    }

    pub(crate) fn verify_unchanged(&self, input: &Path) -> Result<(), GoopError> {
        let changed = || {
            invalid("The source changed during image processing; inspect it again before retrying")
        };
        let mut file = File::open(input)?;
        let mut offset = 0usize;
        let mut buffer = [0_u8; 64 * 1024];
        while offset < self.bytes.len() {
            let requested = (self.bytes.len() - offset).min(buffer.len());
            let count = file.read(&mut buffer[..requested])?;
            if count == 0 || buffer[..count] != self.bytes[offset..offset + count] {
                return Err(changed());
            }
            offset += count;
        }
        if file.read(&mut buffer[..1])? != 0 {
            return Err(changed());
        }
        Ok(())
    }
}

pub(crate) fn validate_policy(
    inspection: &SourceInspection,
    target: goop_core::TargetFormat,
    policy: ImageColorPolicy,
) -> Result<(), GoopError> {
    if policy == ImageColorPolicy::Preserve {
        return Ok(());
    }
    if !matches!(
        target,
        goop_core::TargetFormat::Jpeg | goop_core::TargetFormat::Png
    ) {
        return Err(invalid(
            "Color-managed conversion is available only for JPEG and PNG output",
        ));
    }
    match (policy, inspection.profile.is_some()) {
        (ImageColorPolicy::ConvertToSrgb, true) | (ImageColorPolicy::AssumeSrgb, false) => Ok(()),
        (ImageColorPolicy::ConvertToSrgb, false) => Err(invalid(
            "Convert to sRGB requires a valid embedded RGB or grayscale ICC profile",
        )),
        (ImageColorPolicy::AssumeSrgb, true) => Err(invalid(
            "Assume sRGB is available only when the source has no ICC profile",
        )),
        (ImageColorPolicy::Preserve, _) => Ok(()),
    }
}

pub(crate) fn encode_tagged(
    result: &TransformResult,
    target: goop_core::TargetFormat,
    jpeg_quality: u8,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, GoopError> {
    checkpoint(cancel)?;
    let mut encoded = BoundedWriter::new(MAX_COLOR_OUTPUT_BYTES, cancel);
    match target {
        goop_core::TargetFormat::Jpeg => image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut encoded,
            jpeg_quality.clamp(1, 100),
        )
        .encode_image(&result.pixels)
        .map_err(|error| {
            encoding_error(cancel, || format!("Could not encode sRGB JPEG: {error}"))
        })?,
        goop_core::TargetFormat::Png => {
            use image::ImageEncoder as _;
            image::codecs::png::PngEncoder::new(&mut encoded)
                .write_image(
                    result.pixels.as_raw(),
                    result.pixels.width(),
                    result.pixels.height(),
                    ColorType::Rgb8.into(),
                )
                .map_err(|error| {
                    encoding_error(cancel, || format!("Could not encode sRGB PNG: {error}"))
                })?;
        }
        _ => return Err(invalid("Color-managed output requires JPEG or PNG")),
    }
    let bytes: Bytes = encoded.into_inner().into();
    let finished = match target {
        goop_core::TargetFormat::Jpeg => {
            let mut image = Jpeg::from_bytes(bytes)
                .map_err(|error| invalid(format!("Could not assemble sRGB JPEG: {error}")))?;
            image.set_exif(None);
            image.set_icc_profile(Some(result.destination_profile.clone().into()));
            let mut output = BoundedWriter::new(MAX_COLOR_OUTPUT_BYTES, cancel);
            image.encoder().write_to(&mut output).map_err(|error| {
                encoding_error(cancel, || format!("Could not write sRGB JPEG: {error}"))
            })?;
            output.into_inner()
        }
        goop_core::TargetFormat::Png => {
            let mut image = Png::from_bytes(bytes)
                .map_err(|error| invalid(format!("Could not assemble sRGB PNG: {error}")))?;
            image.set_exif(None);
            image.set_icc_profile(Some(result.destination_profile.clone().into()));
            let mut output = BoundedWriter::new(MAX_COLOR_OUTPUT_BYTES, cancel);
            image.encoder().write_to(&mut output).map_err(|error| {
                encoding_error(cancel, || format!("Could not write sRGB PNG: {error}"))
            })?;
            output.into_inner()
        }
        _ => unreachable!(),
    };
    verify_encoded(
        &finished,
        target,
        result.pixels.dimensions(),
        &result.destination_profile,
    )?;
    checkpoint(cancel)?;
    Ok(finished)
}

fn verify_encoded(
    bytes: &[u8],
    target: goop_core::TargetFormat,
    dimensions: (u32, u32),
    profile: &[u8],
) -> Result<(), GoopError> {
    if !matches!(
        target,
        goop_core::TargetFormat::Jpeg | goop_core::TargetFormat::Png
    ) {
        return Err(invalid("Color-managed output target is invalid"));
    }
    let facts = inspect_encoded(bytes)?;
    if facts.has_exif
        || facts.profile.as_deref() != Some(profile)
        || facts.layout != SourceLayout::Rgb8
        || facts.dimensions != dimensions
    {
        return Err(invalid(
            "Color-managed output did not retain only the canonical sRGB profile",
        ));
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| invalid(format!("Could not identify sRGB output: {error}")))?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_COLOR_PIXELS * 3);
    reader.limits(limits);
    let decoder = reader
        .into_decoder()
        .map_err(|error| invalid(format!("Could not verify sRGB output: {error}")))?;
    if decoder.dimensions() != dimensions || decoder.color_type() != ColorType::Rgb8 {
        return Err(invalid(
            "Color-managed output dimensions or RGB8 layout changed during encode",
        ));
    }
    Ok(())
}

pub(crate) fn transform_pixels(
    source: DynamicImage,
    source_profile: Option<Vec<u8>>,
    policy: ImageColorPolicy,
    cancel: &CancellationToken,
) -> Result<TransformResult, GoopError> {
    checkpoint(cancel)?;
    if policy == ImageColorPolicy::Preserve {
        return Err(invalid(
            "The legacy Preserve path must not invoke the color transformer",
        ));
    }
    let (width, height) = (source.width(), source.height());
    let context = ThreadContext::new();
    let destination = Profile::new_srgb_context(&context);
    let destination_profile = destination
        .icc()
        .map_err(|error| invalid(format!("Could not serialize the sRGB profile: {error}")))?;
    validate_profile(&destination_profile)?;

    let pixels = match (source, policy, source_profile) {
        (DynamicImage::ImageRgb8(image), ImageColorPolicy::AssumeSrgb, None) => image,
        (DynamicImage::ImageLuma8(image), ImageColorPolicy::AssumeSrgb, None) => {
            let mut output = allocate_rgb(width, height)?;
            for (row, (source_row, output_row)) in image.rows().zip(output.rows_mut()).enumerate() {
                if row % 64 == 0 {
                    checkpoint(cancel)?;
                }
                for (gray, rgb) in source_row.zip(output_row) {
                    rgb.0 = [gray.0[0]; 3];
                }
            }
            output
        }
        (_, ImageColorPolicy::AssumeSrgb, Some(_)) => {
            return Err(invalid(
                "Assume sRGB is available only when the source has no ICC profile",
            ));
        }
        (DynamicImage::ImageRgb8(image), ImageColorPolicy::ConvertToSrgb, Some(profile)) => {
            if validate_profile(&profile)? != b"RGB " {
                return Err(invalid(
                    "The ICC profile color space does not match the RGB source pixels",
                ));
            }
            let source_profile = Profile::new_icc_context(&context, &profile)
                .map_err(|error| invalid(format!("ICC profile could not be parsed: {error}")))?;
            let transform = Transform::new_context(
                &context,
                &source_profile,
                PixelFormat::RGB_8,
                &destination,
                PixelFormat::RGB_8,
                Intent::Perceptual,
            )
            .map_err(|error| invalid(format!("ICC transform could not be created: {error}")))?;
            let mut output = allocate_rgb(width, height)?;
            let mut source_pixels = [[0_u8; 3]; TRANSFORM_CHUNK_PIXELS];
            let mut output_pixels = [[0_u8; 3]; TRANSFORM_CHUNK_PIXELS];
            for (source_chunk, output_chunk) in image
                .as_raw()
                .chunks(TRANSFORM_CHUNK_PIXELS * 3)
                .zip(output.as_mut().chunks_mut(TRANSFORM_CHUNK_PIXELS * 3))
            {
                checkpoint(cancel)?;
                let count = source_chunk.len() / 3;
                for (pixel, channels) in source_pixels[..count]
                    .iter_mut()
                    .zip(source_chunk.chunks_exact(3))
                {
                    pixel.copy_from_slice(channels);
                }
                transform.transform_pixels(&source_pixels[..count], &mut output_pixels[..count]);
                for (channels, pixel) in output_chunk
                    .chunks_exact_mut(3)
                    .zip(output_pixels[..count].iter())
                {
                    channels.copy_from_slice(pixel);
                }
            }
            output
        }
        (DynamicImage::ImageLuma8(image), ImageColorPolicy::ConvertToSrgb, Some(profile)) => {
            if validate_profile(&profile)? != b"GRAY" {
                return Err(invalid(
                    "The ICC profile color space does not match the grayscale source pixels",
                ));
            }
            let source_profile = Profile::new_icc_context(&context, &profile)
                .map_err(|error| invalid(format!("ICC profile could not be parsed: {error}")))?;
            let transform = Transform::new_context(
                &context,
                &source_profile,
                PixelFormat::GRAY_8,
                &destination,
                PixelFormat::RGB_8,
                Intent::Perceptual,
            )
            .map_err(|error| invalid(format!("ICC transform could not be created: {error}")))?;
            let mut output = allocate_rgb(width, height)?;
            let mut output_pixels = [[0_u8; 3]; TRANSFORM_CHUNK_PIXELS];
            for (source_chunk, output_chunk) in image
                .as_raw()
                .chunks(TRANSFORM_CHUNK_PIXELS)
                .zip(output.as_mut().chunks_mut(TRANSFORM_CHUNK_PIXELS * 3))
            {
                checkpoint(cancel)?;
                transform.transform_pixels(source_chunk, &mut output_pixels[..source_chunk.len()]);
                for (channels, pixel) in output_chunk
                    .chunks_exact_mut(3)
                    .zip(output_pixels[..source_chunk.len()].iter())
                {
                    channels.copy_from_slice(pixel);
                }
            }
            output
        }
        (_, ImageColorPolicy::ConvertToSrgb, None) => {
            return Err(invalid(
                "Convert to sRGB requires a valid embedded RGB or grayscale ICC profile",
            ));
        }
        _ => {
            return Err(invalid(
                "Color-managed conversion currently supports only 8-bit RGB or grayscale pixels without alpha",
            ));
        }
    };
    checkpoint(cancel)?;
    Ok(TransformResult {
        pixels,
        destination_profile,
        handling: match policy {
            ImageColorPolicy::ConvertToSrgb => ImageColorHandling::ConvertedToSrgb,
            ImageColorPolicy::AssumeSrgb => ImageColorHandling::AssumedSrgb,
            ImageColorPolicy::Preserve => unreachable!(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use goop_core::ImageColorPolicy;
    use image::{DynamicImage, GrayImage, RgbImage};
    use lcms2::{CIExyY, Profile, ToneCurve};
    use tokio_util::sync::CancellationToken;

    fn gray_profile() -> Vec<u8> {
        let d50 = CIExyY {
            x: 0.3457,
            y: 0.3585,
            Y: 1.0,
        };
        Profile::new_gray(&d50, &ToneCurve::new(2.2))
            .unwrap()
            .icc()
            .unwrap()
    }

    fn encode_image(image: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, format).unwrap();
        output.into_inner()
    }

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = Vec::with_capacity(data.len() + 12);
        chunk.extend_from_slice(&u32::try_from(data.len()).unwrap().to_be_bytes());
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(data);
        let mut crc = crc32fast::Hasher::new();
        crc.update(kind);
        crc.update(data);
        chunk.extend_from_slice(&crc.finalize().to_be_bytes());
        chunk
    }

    fn jpeg_icc_segment(sequence: u8, count: u8, payload: &[u8]) -> Vec<u8> {
        let mut segment = vec![0xff, 0xe2];
        let length = u16::try_from(2 + 14 + payload.len()).unwrap();
        segment.extend_from_slice(&length.to_be_bytes());
        segment.extend_from_slice(b"ICC_PROFILE\0");
        segment.extend_from_slice(&[sequence, count]);
        segment.extend_from_slice(payload);
        segment
    }

    #[test]
    fn jpeg_icc_duplicates_are_rejected_before_scanning_later_segments() {
        let mut jpeg = vec![0xff, 0xd8];
        jpeg.extend_from_slice(&jpeg_icc_segment(1, 2, b"first"));
        jpeg.extend_from_slice(&jpeg_icc_segment(1, 2, b"duplicate"));
        jpeg.push(0x00);

        assert!(inspect_jpeg(&jpeg)
            .unwrap_err()
            .user_message()
            .contains("duplicate"));
    }

    #[test]
    fn rejects_declared_length_mismatch_before_native_parse() {
        let mut profile = Profile::new_srgb().icc().unwrap();
        let declared = u32::try_from(profile.len() + 1).unwrap().to_be_bytes();
        profile[..4].copy_from_slice(&declared);
        assert!(validate_profile(&profile)
            .unwrap_err()
            .user_message()
            .contains("declared length"));
    }

    #[test]
    fn working_set_limit_has_exact_boundary_and_fallible_rgb_shape() {
        assert!(validate_color_dimensions((4_000, 4_000)).is_ok());
        assert!(validate_color_dimensions((4_000, 4_001)).is_err());
        assert!(validate_color_dimensions((32_768, 1)).is_ok());
        assert!(validate_color_dimensions((32_769, 1))
            .unwrap_err()
            .user_message()
            .contains("per-axis"));
        assert_eq!(allocate_rgb(2, 3).unwrap().dimensions(), (2, 3));

        let mut writer = BoundedWriter::new(3, &CancellationToken::new());
        writer.write_all(&[1, 2, 3]).unwrap();
        assert!(writer.write_all(&[4]).is_err());
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(BoundedWriter::new(3, &cancelled).write_all(&[1]).is_err());
    }

    #[test]
    fn bounded_writer_grows_geometrically_for_byte_writes() {
        let mut writer = BoundedWriter::new(4_096, &CancellationToken::new());
        for _ in 0..4_096 {
            writer.write_all(&[0x7f]).unwrap();
        }

        assert_eq!(writer.bytes.len(), 4_096);
        assert!(
            writer.reserve_count <= 12,
            "expected logarithmic growth, got {} reservations",
            writer.reserve_count
        );
    }

    #[test]
    fn working_set_gate_is_serial_and_cancellable() {
        let held = acquire_working_set(&CancellationToken::new()).unwrap();
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(matches!(
            acquire_working_set(&cancelled),
            Err(GoopError::Cancelled)
        ));
        drop(held);
        assert!(acquire_working_set(&CancellationToken::new()).is_ok());
    }

    #[test]
    fn tagged_rgb_transforms_to_rgb_srgb() {
        let source = DynamicImage::ImageRgb8(
            RgbImage::from_raw(2, 1, vec![10, 20, 30, 200, 150, 100]).unwrap(),
        );
        let result = transform_pixels(
            source,
            Some(Profile::new_srgb().icc().unwrap()),
            ImageColorPolicy::ConvertToSrgb,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(result.pixels.into_raw(), vec![10, 20, 30, 200, 150, 100]);
        assert_eq!(
            result.handling,
            goop_core::ImageColorHandling::ConvertedToSrgb
        );
        assert!(validate_profile(&result.destination_profile).is_ok());
    }

    #[test]
    fn capability_admission_rejects_profile_without_transform_tags() {
        let mut profile = Profile::new_srgb().icc().unwrap();
        profile.truncate(132);
        profile[..4].copy_from_slice(&132_u32.to_be_bytes());
        profile[128..132].copy_from_slice(&0_u32.to_be_bytes());
        let inspection = SourceInspection {
            layout: SourceLayout::Rgb8,
            profile: Some(profile),
            orientation: image::metadata::Orientation::NoTransforms,
            has_exif: false,
            dimensions: (1, 1),
        };

        assert!(validate_native_profile(&inspection)
            .unwrap_err()
            .user_message()
            .contains("transform could not be created"));
    }

    #[test]
    fn tagged_gray_transforms_to_rgb_srgb() {
        let source =
            DynamicImage::ImageLuma8(GrayImage::from_raw(3, 1, vec![0, 128, 255]).unwrap());
        let result = transform_pixels(
            source,
            Some(gray_profile()),
            ImageColorPolicy::ConvertToSrgb,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(result.pixels.dimensions(), (3, 1));
        assert_eq!(result.pixels.get_pixel(0, 0).0, [0, 0, 0]);
        assert_eq!(result.pixels.get_pixel(2, 0).0, [255, 255, 255]);
    }

    #[test]
    fn assumption_requires_untagged_rgb_or_gray() {
        let rgb = DynamicImage::ImageRgb8(RgbImage::new(1, 1));
        assert!(transform_pixels(
            rgb.clone(),
            Some(Profile::new_srgb().icc().unwrap()),
            ImageColorPolicy::AssumeSrgb,
            &CancellationToken::new(),
        )
        .is_err());
        assert!(transform_pixels(
            rgb,
            None,
            ImageColorPolicy::AssumeSrgb,
            &CancellationToken::new(),
        )
        .is_ok());
    }

    #[test]
    fn untagged_gray_assumption_expands_to_tagged_srgb_execution() {
        let source =
            DynamicImage::ImageLuma8(GrayImage::from_raw(3, 1, vec![0, 128, 255]).unwrap());

        let result = transform_pixels(
            source,
            None,
            ImageColorPolicy::AssumeSrgb,
            &CancellationToken::new(),
        )
        .unwrap();

        assert_eq!(
            result.pixels.into_raw(),
            vec![0, 0, 0, 128, 128, 128, 255, 255, 255]
        );
        assert_eq!(result.handling, goop_core::ImageColorHandling::AssumedSrgb);
        assert_eq!(
            validate_profile(&result.destination_profile).unwrap(),
            b"RGB "
        );
    }

    #[test]
    fn alpha_and_cmyk_style_profiles_fail_closed() {
        let rgba = DynamicImage::new_rgba8(1, 1);
        assert!(transform_pixels(
            rgba,
            None,
            ImageColorPolicy::AssumeSrgb,
            &CancellationToken::new(),
        )
        .is_err());
        let mut cmyk = Profile::new_srgb().icc().unwrap();
        cmyk[16..20].copy_from_slice(b"CMYK");
        assert!(validate_profile(&cmyk).is_err());
    }

    #[test]
    fn strict_container_admission_rejects_alpha_apng_and_non_eight_bit_jpeg() {
        let rgba = encode_image(&DynamicImage::new_rgba8(1, 1), ImageFormat::Png);
        assert!(inspect_bytes(rgba.into())
            .unwrap_err()
            .user_message()
            .contains("without alpha"));

        let mut apng = encode_image(&DynamicImage::new_rgb8(1, 1), ImageFormat::Png);
        let animation_control = png_chunk(b"acTL", &[0, 0, 0, 1, 0, 0, 0, 0]);
        apng.splice(33..33, animation_control);
        assert!(inspect_bytes(apng.into())
            .unwrap_err()
            .user_message()
            .contains("animation"));

        let mut jpeg = encode_image(&DynamicImage::new_rgb8(1, 1), ImageFormat::Jpeg);
        let sof = jpeg
            .windows(2)
            .position(|window| window == [0xff, 0xc0])
            .expect("baseline SOF");
        jpeg[sof + 4] = 12;
        assert!(inspect_bytes(jpeg.into())
            .unwrap_err()
            .user_message()
            .contains("8-bit"));
    }

    #[test]
    fn strict_profile_admission_rejects_bad_class_pcs_version_and_overlaps() {
        let original = Profile::new_srgb().icc().unwrap();
        for (range, replacement) in [
            (8..9, b"\x05".as_slice()),
            (12..16, b"link".as_slice()),
            (20..24, b"BAD!".as_slice()),
        ] {
            let mut profile = original.clone();
            profile[range].copy_from_slice(replacement);
            assert!(validate_profile(&profile).is_err());
        }

        let mut overlap = original;
        let count = u32::from_be_bytes(overlap[128..132].try_into().unwrap());
        assert!(count >= 2);
        let first_offset = overlap[136..140].to_vec();
        overlap[148..152].copy_from_slice(&first_offset);
        overlap[152..156].copy_from_slice(&[0, 0, 0, 4]);
        assert!(validate_profile(&overlap)
            .unwrap_err()
            .user_message()
            .contains("overlap"));
    }

    #[test]
    fn explicit_jpeg_and_png_outputs_are_destination_owned() {
        let transformed = transform_pixels(
            DynamicImage::ImageRgb8(
                RgbImage::from_raw(2, 1, vec![12, 34, 56, 78, 90, 123]).unwrap(),
            ),
            None,
            ImageColorPolicy::AssumeSrgb,
            &CancellationToken::new(),
        )
        .unwrap();
        for target in [goop_core::TargetFormat::Jpeg, goop_core::TargetFormat::Png] {
            let encoded =
                encode_tagged(&transformed, target, 90, &CancellationToken::new()).unwrap();
            let facts = inspect_encoded(&encoded).unwrap();
            assert_eq!(
                facts.profile.as_deref(),
                Some(transformed.destination_profile.as_slice())
            );
            assert!(!facts.has_exif);
            assert_eq!(facts.layout, SourceLayout::Rgb8);
            assert_eq!(facts.dimensions, (2, 1));
        }
    }
}
