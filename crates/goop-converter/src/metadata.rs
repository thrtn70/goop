//! Image metadata propagation (EXIF + ICC) across a convert / compress
//! op. The `image` crate's encoders strip metadata by default, so
//! "Preserve" requires actively reading the source's metadata chunks
//! and writing them into the output file after encoding.
//!
//! v0.2.5 supports the JPEG↔JPEG and PNG↔PNG paths via `img-parts`:
//!
//! * JPEG: EXIF lives in the APP1 marker (`Exif\0\0` prefix). ICC
//!   lives in APP2 (`ICC_PROFILE\0` prefix, possibly split across
//!   multiple APP2 segments which `img-parts::Jpeg::icc_profile`
//!   reassembles).
//! * PNG: EXIF lives in the `eXIf` chunk (PNG 1.5+). ICC lives in
//!   the `iCCP` chunk.
//!
//! Cross-format conversions (e.g. JPEG → AVIF) drop the metadata for
//! v0.2.5 / v0.2.6; broadening the supported matrix is a v0.2.7+
//! candidate.

use goop_core::{GoopError, MetadataPolicy};
use img_parts::jpeg::Jpeg;
use img_parts::png::Png;
use img_parts::{Bytes, ImageEXIF, ImageICC};
use std::path::Path;

const JPEG_EXIF_PREFIX: &[u8] = b"Exif\0\0";
const JPEG_ICC_PREFIX: &[u8] = b"ICC_PROFILE\0";
const MAX_JPEG_SEGMENTS: usize = 16_384;
/// Below the JPEG APP2 sequence ceiling and large enough for normal display,
/// proofing and device-link profiles. Privacy paths refuse larger inputs
/// before concatenating or asking img-parts to split them into segments.
const MAX_JPEG_ICC_BYTES: usize = 15 * 1024 * 1024;

/// Categorize a file path by container format. Used to gate whether
/// the propagation path is implemented for this source / output pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Jpeg,
    Png,
    Other,
}

pub fn container_of(path: &Path) -> Container {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" => Container::Jpeg,
        "png" => Container::Png,
        _ => Container::Other,
    }
}

/// Optional EXIF + ICC bytes pulled from a source image.
pub type Metadata = (Option<Vec<u8>>, Option<Vec<u8>>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JpegOutputColor {
    Rgb,
}

/// Metadata decisions derived from one immutable JPEG snapshot. Existing
/// Preserve rendering continues to use its legacy path; this plan is the
/// strict boundary used by privacy and metadata-aware candidate assembly.
#[derive(Debug, Clone)]
pub(crate) struct JpegMetadataPlan {
    policy: MetadataPolicy,
    source_exif: Option<Vec<u8>>,
    source_icc: Option<Vec<u8>>,
    orientation: image::metadata::Orientation,
    normalize_preserve_exif: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JpegMetadataInspection {
    pub(crate) source_has_exif: bool,
    pub(crate) source_has_icc: bool,
    pub(crate) orientation: crate::exif_geometry::OrientationStatus,
    pub(crate) preserve_unavailable_reason: Option<String>,
    pub(crate) remove_personal_unavailable_reason: Option<String>,
    pub(crate) strip_all_unavailable_reason: Option<String>,
}

impl JpegMetadataPlan {
    pub(crate) fn orientation(&self) -> image::metadata::Orientation {
        self.orientation
    }

    fn expected_exif(&self, candidate: &Jpeg) -> Result<Option<Vec<u8>>, GoopError> {
        if self.policy != MetadataPolicy::Preserve {
            return Ok(None);
        }
        let Some(exif) = self.source_exif.as_deref() else {
            return Ok(None);
        };
        if !self.normalize_preserve_exif {
            return Ok(Some(exif.to_vec()));
        }
        let (width, height) = jpeg_dimensions(candidate)?;
        crate::exif_geometry::normalize(exif, width, height).map(Some)
    }

    fn expected_icc(&self) -> Option<&[u8]> {
        if self.policy == MetadataPolicy::StripAll {
            None
        } else {
            self.source_icc.as_deref()
        }
    }

    /// Assemble the exact bytes that may be measured or staged. The encoded
    /// candidate is first scrubbed of any unexpected EXIF/ICC blocks so the
    /// finished state is determined solely by this source-derived plan.
    pub(crate) fn assemble_candidate(&self, encoded: Vec<u8>) -> Result<Vec<u8>, GoopError> {
        let mut jpeg = parse_jpeg(encoded.into(), "encoded JPEG candidate")?;
        jpeg.set_exif(self.expected_exif(&jpeg)?.map(Into::into));
        jpeg.set_icc_profile(self.expected_icc().map(|bytes| bytes.to_vec().into()));
        let bytes = jpeg.encoder().bytes().to_vec();
        self.verify_candidate(&bytes)?;
        Ok(bytes)
    }

    /// Verify the finished container rather than trusting a successful encode.
    /// Parsing is strict again so duplicate or malformed blocks cannot satisfy
    /// an expected present/absent boolean accidentally.
    pub(crate) fn verify_candidate(&self, bytes: &[u8]) -> Result<(), GoopError> {
        if self.policy == MetadataPolicy::Preserve {
            // Preserve intentionally retains legacy opaque-ICC behavior. The
            // strict ICC proof below belongs only to the privacy policies.
            let jpeg = parse_jpeg(bytes.to_vec().into(), "finished JPEG candidate")?;
            let expected_exif = self.expected_exif(&jpeg)?;
            if jpeg.exif().as_deref() != expected_exif.as_deref() {
                return Err(metadata_invalid(
                    "finished JPEG EXIF state does not match the requested metadata policy",
                ));
            }
            if jpeg.icc_profile().as_deref() != self.expected_icc() {
                return Err(metadata_invalid(
                    "finished JPEG ICC state does not match the requested metadata policy",
                ));
            }
            return Ok(());
        }
        let jpeg = parse_jpeg(bytes.to_vec().into(), "finished JPEG candidate")?;
        let parsed = strict_jpeg_metadata(&jpeg)?;
        if parsed.exif.is_some() {
            return Err(metadata_invalid(
                "finished JPEG EXIF state does not match the requested metadata policy",
            ));
        }
        if parsed.icc.as_deref() != self.expected_icc() {
            return Err(metadata_invalid(
                "finished JPEG ICC state does not match the requested metadata policy",
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
struct StrictJpegMetadata {
    exif: Option<Vec<u8>>,
    icc: Option<Vec<u8>>,
    components: u8,
}

fn metadata_invalid(detail: impl AsRef<str>) -> GoopError {
    GoopError::InvalidRequest(format!(
        "Cannot safely process JPEG metadata: {}",
        detail.as_ref()
    ))
}

fn parse_jpeg(bytes: Bytes, label: &str) -> Result<Jpeg, GoopError> {
    preflight_jpeg_segments(&bytes, label)?;
    Jpeg::from_bytes(bytes)
        .map_err(|error| metadata_invalid(format!("{label} is malformed: {error}")))
}

fn preflight_jpeg_segments(bytes: &[u8], label: &str) -> Result<(), GoopError> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return Ok(());
    }
    let mut cursor = 2usize;
    let mut segments = 0usize;
    loop {
        let prefix = *bytes
            .get(cursor)
            .ok_or_else(|| metadata_invalid(format!("{label} is truncated")))?;
        cursor += 1;
        if prefix != 0xff {
            continue;
        }
        let marker = loop {
            let marker = *bytes
                .get(cursor)
                .ok_or_else(|| metadata_invalid(format!("{label} is truncated")))?;
            cursor += 1;
            if marker != 0xff {
                break marker;
            }
        };
        if marker == 0xd9 {
            return Ok(());
        }
        segments += 1;
        if segments > MAX_JPEG_SEGMENTS {
            return Err(metadata_invalid(format!(
                "{label} exceeds the {MAX_JPEG_SEGMENTS} segment safety limit"
            )));
        }
        let has_length = matches!(
            marker,
            0xc0..=0xcf | 0xd0..=0xd7 | 0xda | 0xdb | 0xdd | 0xe0..=0xef | 0xfe
        );
        if !has_length {
            continue;
        }
        let length = u16::from_be_bytes(
            bytes
                .get(cursor..cursor + 2)
                .ok_or_else(|| metadata_invalid(format!("{label} is truncated")))?
                .try_into()
                .map_err(|_| metadata_invalid(format!("{label} segment length is missing")))?,
        );
        let payload = usize::from(length)
            .checked_sub(2)
            .ok_or_else(|| metadata_invalid(format!("{label} has an invalid segment length")))?;
        cursor = cursor
            .checked_add(2 + payload)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| metadata_invalid(format!("{label} is truncated")))?;
        if marker == 0xda {
            return Ok(());
        }
    }
}

fn is_sof(marker: u8) -> bool {
    (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc)
}

fn jpeg_dimensions(jpeg: &Jpeg) -> Result<(u32, u32), GoopError> {
    let mut dimensions = None;
    for segment in jpeg
        .segments()
        .iter()
        .filter(|segment| is_sof(segment.marker()))
    {
        let contents = segment.contents();
        let height = u16::from_be_bytes(
            contents
                .get(1..3)
                .ok_or_else(|| metadata_invalid("JPEG frame header is truncated"))?
                .try_into()
                .map_err(|_| metadata_invalid("JPEG frame height is missing"))?,
        );
        let width = u16::from_be_bytes(
            contents
                .get(3..5)
                .ok_or_else(|| metadata_invalid("JPEG frame header is truncated"))?
                .try_into()
                .map_err(|_| metadata_invalid("JPEG frame width is missing"))?,
        );
        if width == 0 || height == 0 || dimensions.replace((width, height)).is_some() {
            return Err(metadata_invalid(
                "JPEG frame geometry is invalid or ambiguous",
            ));
        }
    }
    dimensions
        .map(|(width, height)| (u32::from(width), u32::from(height)))
        .ok_or_else(|| metadata_invalid("JPEG frame header is missing"))
}

fn validate_icc_profile(profile: &[u8]) -> Result<(), GoopError> {
    if profile.len() < 128 {
        return Err(metadata_invalid(
            "ICC profile is shorter than its 128-byte header",
        ));
    }
    if profile.len() > MAX_JPEG_ICC_BYTES {
        return Err(metadata_invalid(format!(
            "ICC profile exceeds the {} byte safety limit",
            MAX_JPEG_ICC_BYTES
        )));
    }
    let declared = u32::from_be_bytes(
        profile[..4]
            .try_into()
            .map_err(|_| metadata_invalid("ICC profile size is missing"))?,
    ) as usize;
    if declared != profile.len() {
        return Err(metadata_invalid(
            "ICC profile declared length does not match its payload",
        ));
    }
    if profile.get(36..40) != Some(b"acsp") {
        return Err(metadata_invalid("ICC profile signature is invalid"));
    }
    let data_space = &profile[16..20];
    let named_space = matches!(
        data_space,
        b"XYZ "
            | b"Lab "
            | b"Luv "
            | b"YCbr"
            | b"Yxy "
            | b"RGB "
            | b"GRAY"
            | b"HSV "
            | b"HLS "
            | b"CMYK"
            | b"CMY "
    );
    let n_color_space = matches!(data_space, [b'2'..=b'9' | b'A'..=b'F', b'C', b'L', b'R']);
    if !named_space && !n_color_space {
        return Err(metadata_invalid("ICC profile data color space is invalid"));
    }
    Ok(())
}

fn has_icc_segments(jpeg: &Jpeg) -> bool {
    jpeg.segments()
        .iter()
        .any(|segment| segment.marker() == 0xe2 && segment.contents().starts_with(JPEG_ICC_PREFIX))
}

fn collect_icc_profile(jpeg: &Jpeg, validate: bool) -> Result<Option<Vec<u8>>, GoopError> {
    let mut icc_parts: Vec<(u8, Vec<u8>)> = Vec::new();
    let mut icc_count = None;
    let mut combined_icc = 0usize;

    for segment in jpeg.segments() {
        let contents = segment.contents();
        if segment.marker() == 0xe2 && contents.starts_with(JPEG_ICC_PREFIX) {
            let fields = contents
                .get(JPEG_ICC_PREFIX.len()..JPEG_ICC_PREFIX.len() + 2)
                .ok_or_else(|| metadata_invalid("ICC APP2 sequence header is truncated"))?;
            let sequence = fields[0];
            let count = fields[1];
            if count == 0 || sequence == 0 || sequence > count {
                return Err(metadata_invalid("ICC APP2 sequence numbers are invalid"));
            }
            if icc_count.replace(count).is_some_and(|seen| seen != count) {
                return Err(metadata_invalid(
                    "ICC APP2 segments disagree on their count",
                ));
            }
            if icc_parts.iter().any(|(seen, _)| *seen == sequence) {
                return Err(metadata_invalid("ICC APP2 sequence number is duplicated"));
            }
            let payload = contents[JPEG_ICC_PREFIX.len() + 2..].to_vec();
            combined_icc = combined_icc
                .checked_add(payload.len())
                .ok_or_else(|| metadata_invalid("ICC profile size overflow"))?;
            if validate && combined_icc > MAX_JPEG_ICC_BYTES {
                return Err(metadata_invalid(format!(
                    "ICC profile exceeds the {} byte safety limit",
                    MAX_JPEG_ICC_BYTES
                )));
            }
            icc_parts.push((sequence, payload));
        }
    }

    let icc = if let Some(count) = icc_count {
        if icc_parts.len() != usize::from(count) {
            return Err(metadata_invalid("ICC APP2 sequence is incomplete"));
        }
        icc_parts.sort_by_key(|(sequence, _)| *sequence);
        if icc_parts
            .iter()
            .enumerate()
            .any(|(index, (sequence, _))| usize::from(*sequence) != index + 1)
        {
            return Err(metadata_invalid("ICC APP2 sequence is not contiguous"));
        }
        let mut profile = Vec::with_capacity(combined_icc);
        for (_, payload) in icc_parts {
            profile.extend_from_slice(&payload);
        }
        if validate {
            validate_icc_profile(&profile)?;
        }
        Some(profile)
    } else {
        None
    };

    Ok(icc)
}

fn strict_jpeg_metadata(jpeg: &Jpeg) -> Result<StrictJpegMetadata, GoopError> {
    let mut exif = None;
    let mut components = None;

    for segment in jpeg.segments() {
        let contents = segment.contents();
        if segment.marker() == 0xe1 && contents.starts_with(JPEG_EXIF_PREFIX) {
            if exif.is_some() {
                return Err(metadata_invalid("multiple EXIF segments are ambiguous"));
            }
            exif = Some(contents[JPEG_EXIF_PREFIX.len()..].to_vec());
        }
        if is_sof(segment.marker()) {
            let count = *contents
                .get(5)
                .ok_or_else(|| metadata_invalid("JPEG frame header is truncated"))?;
            if count == 0 || contents.len() < 6usize.saturating_add(usize::from(count) * 3) {
                return Err(metadata_invalid("JPEG frame component table is malformed"));
            }
            if components.replace(count).is_some() {
                return Err(metadata_invalid(
                    "multiple JPEG frame headers are ambiguous",
                ));
            }
        }
    }

    Ok(StrictJpegMetadata {
        exif,
        icc: collect_icc_profile(jpeg, true)?,
        components: components.ok_or_else(|| metadata_invalid("JPEG frame header is missing"))?,
    })
}

fn prepare_jpeg_plan_from_parsed(
    jpeg: &Jpeg,
    policy: MetadataPolicy,
    output_color: JpegOutputColor,
) -> Result<JpegMetadataPlan, GoopError> {
    if policy == MetadataPolicy::Preserve {
        if jpeg
            .segments()
            .iter()
            .filter(|segment| {
                segment.marker() == 0xe1 && segment.contents().starts_with(JPEG_EXIF_PREFIX)
            })
            .count()
            > 1
        {
            return Err(metadata_invalid("multiple EXIF segments are ambiguous"));
        }
        let source_exif = jpeg.exif().map(|bytes| bytes.to_vec());
        let orientation = source_exif
            .as_deref()
            .map(crate::exif_geometry::orientation)
            .transpose()?
            .unwrap_or(image::metadata::Orientation::NoTransforms);
        return Ok(JpegMetadataPlan {
            policy,
            source_exif,
            source_icc: collect_icc_profile(jpeg, false)?,
            orientation,
            normalize_preserve_exif: true,
        });
    }

    if policy == MetadataPolicy::RemovePersonal && has_icc_segments(jpeg) {
        return Err(metadata_invalid(
            "Remove personal data is unavailable for JPEGs with an ICC profile",
        ));
    }

    let parsed = strict_jpeg_metadata(jpeg)?;
    let orientation = parsed
        .exif
        .as_deref()
        .map(crate::exif_geometry::orientation)
        .transpose()?
        .unwrap_or(image::metadata::Orientation::NoTransforms);

    if policy == MetadataPolicy::RemovePersonal
        && (parsed.components != 3 || output_color != JpegOutputColor::Rgb)
    {
        return Err(metadata_invalid(
            "Remove personal data currently requires RGB JPEG input and RGB output",
        ));
    }

    Ok(JpegMetadataPlan {
        policy,
        source_exif: parsed.exif,
        source_icc: None,
        orientation,
        normalize_preserve_exif: false,
    })
}

/// Build a strict policy plan from one caller-owned immutable JPEG snapshot.
/// RemovePersonal is deliberately limited to an RGB JPEG rendered as RGB; it
/// never reattaches a GRAY/CMYK profile to converted RGB sample values.
pub(crate) fn prepare_jpeg_plan(
    source_bytes: Bytes,
    policy: MetadataPolicy,
    output_color: JpegOutputColor,
) -> Result<JpegMetadataPlan, GoopError> {
    let jpeg = parse_jpeg(source_bytes, "source JPEG")?;
    prepare_jpeg_plan_from_parsed(&jpeg, policy, output_color)
}

/// Preserve target-size compression must retain the legacy stored-pixel and
/// EXIF representation while still assembling metadata before byte counting.
pub(crate) fn prepare_jpeg_target_plan(source_bytes: Bytes) -> Result<JpegMetadataPlan, GoopError> {
    let jpeg = parse_jpeg(source_bytes, "source JPEG")?;
    prepare_jpeg_target_plan_from_parsed(&jpeg)
}

fn prepare_jpeg_target_plan_from_parsed(jpeg: &Jpeg) -> Result<JpegMetadataPlan, GoopError> {
    Ok(JpegMetadataPlan {
        policy: MetadataPolicy::Preserve,
        source_exif: jpeg.exif().map(|bytes| bytes.to_vec()),
        source_icc: collect_icc_profile(jpeg, false)?,
        orientation: image::metadata::Orientation::NoTransforms,
        normalize_preserve_exif: false,
    })
}

/// Source-derived facts for capability mapping. Container parsing failures are
/// returned because they invalidate image inspection itself; malformed or
/// ambiguous metadata remains a policy-specific unavailable reason.
pub(crate) fn inspect_jpeg_metadata(
    source_bytes: Bytes,
    output_color: JpegOutputColor,
) -> Result<JpegMetadataInspection, GoopError> {
    let jpeg = parse_jpeg(source_bytes, "source JPEG")?;
    let exif_segments: Vec<&[u8]> = jpeg
        .segments()
        .iter()
        .filter(|segment| {
            segment.marker() == 0xe1 && segment.contents().starts_with(JPEG_EXIF_PREFIX)
        })
        .map(|segment| &segment.contents()[JPEG_EXIF_PREFIX.len()..])
        .collect();
    let source_has_icc = has_icc_segments(&jpeg);
    let orientation = match exif_segments.as_slice() {
        [] => crate::exif_geometry::OrientationStatus::Absent,
        [exif] => crate::exif_geometry::orientation_status(exif),
        _ => crate::exif_geometry::OrientationStatus::Ambiguous,
    };
    let preserve_unavailable_reason = prepare_jpeg_target_plan_from_parsed(&jpeg)
        .err()
        .map(|error| error.user_message());
    let remove_personal_unavailable_reason =
        prepare_jpeg_plan_from_parsed(&jpeg, MetadataPolicy::RemovePersonal, output_color)
            .err()
            .map(|error| error.user_message());
    let strip_all_unavailable_reason =
        prepare_jpeg_plan_from_parsed(&jpeg, MetadataPolicy::StripAll, output_color)
            .err()
            .map(|error| error.user_message());
    Ok(JpegMetadataInspection {
        source_has_exif: !exif_segments.is_empty(),
        source_has_icc,
        orientation,
        preserve_unavailable_reason,
        remove_personal_unavailable_reason,
        strip_all_unavailable_reason,
    })
}

/// Read EXIF + ICC bytes from a JPEG or PNG input. Returns `(None,
/// None)` for unsupported containers — callers should branch on the
/// container before invoking. EXIF / ICC may individually be `None`
/// when the source doesn't carry that chunk.
pub fn read(input: &Path) -> Result<Metadata, GoopError> {
    let bytes = std::fs::read(input).map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("failed to read input for metadata: {e}"),
    })?;
    match container_of(input) {
        Container::Jpeg => {
            let jpeg = parse_jpeg(bytes.into(), "source JPEG")?;
            Ok((
                jpeg.exif().map(|b| b.to_vec()),
                collect_icc_profile(&jpeg, false)?,
            ))
        }
        Container::Png => {
            let png = Png::from_bytes(bytes.into()).map_err(|e| GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("metadata: failed to parse PNG: {e}"),
            })?;
            Ok((
                png.exif().map(|b| b.to_vec()),
                png.icc_profile().map(|b| b.to_vec()),
            ))
        }
        Container::Other => Ok((None, None)),
    }
}

/// Apply `policy` to `output` using the source metadata read from
/// `input`. If `policy` is `StripAll` this is a no-op (output is
/// already clean after encode). If `policy` is `Preserve` and both
/// input + output containers are JPEG or PNG (matching), the EXIF
/// and ICC bytes from the source are written into the output.
///
/// Returns `Ok(true)` if metadata was actually copied, `Ok(false)`
/// if the policy was `Preserve` but the container pair isn't
/// supported (e.g. JPEG → AVIF). The boolean lets the caller log
/// the difference at INFO level for the dev console.
pub fn apply(input: &Path, output: &Path, policy: MetadataPolicy) -> Result<bool, GoopError> {
    match policy {
        MetadataPolicy::StripAll => return Ok(true),
        MetadataPolicy::RemovePersonal => {
            return Err(GoopError::InvalidRequest(
                "Remove personal data requires the verified JPEG rendering path".into(),
            ));
        }
        MetadataPolicy::Preserve => {}
    }
    let in_container = container_of(input);
    let out_container = container_of(output);
    if in_container != out_container || matches!(in_container, Container::Other) {
        return Ok(false);
    }

    let (exif, icc) = read(input)?;
    if exif.is_none() && icc.is_none() {
        return Ok(false);
    }

    let out_bytes = std::fs::read(output).map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("metadata: failed to read output for update: {e}"),
    })?;

    let updated: Vec<u8> = match out_container {
        Container::Jpeg => {
            let mut jpeg = parse_jpeg(out_bytes.into(), "JPEG output")?;
            if let Some(bytes) = exif {
                jpeg.set_exif(Some(bytes.into()));
            }
            if let Some(bytes) = icc {
                jpeg.set_icc_profile(Some(bytes.into()));
            }
            let mut out = Vec::new();
            jpeg.encoder()
                .write_to(&mut out)
                .map_err(|e| GoopError::SubprocessFailed {
                    binary: "image".into(),
                    stderr: format!("metadata: JPEG re-encode failed: {e}"),
                })?;
            out
        }
        Container::Png => {
            let mut png =
                Png::from_bytes(out_bytes.into()).map_err(|e| GoopError::SubprocessFailed {
                    binary: "image".into(),
                    stderr: format!("metadata: failed to parse PNG output: {e}"),
                })?;
            if let Some(bytes) = exif {
                png.set_exif(Some(bytes.into()));
            }
            if let Some(bytes) = icc {
                png.set_icc_profile(Some(bytes.into()));
            }
            let mut out = Vec::new();
            png.encoder()
                .write_to(&mut out)
                .map_err(|e| GoopError::SubprocessFailed {
                    binary: "image".into(),
                    stderr: format!("metadata: PNG re-encode failed: {e}"),
                })?;
            out
        }
        Container::Other => return Ok(false),
    };

    std::fs::write(output, &updated).map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("metadata: failed to write updated output: {e}"),
    })?;
    Ok(true)
}

/// Copy JPEG metadata after a pixel transform, normalizing only known geometry.
/// Non-JPEG transfer remains unsupported and is described by source capabilities.
pub(crate) fn apply_rendered_jpeg(
    source: Option<&crate::jpeg_controls::JpegSource>,
    output: &Path,
    _width: u32,
    _height: u32,
    policy: MetadataPolicy,
) -> Result<(), GoopError> {
    match policy {
        MetadataPolicy::StripAll => return Ok(()),
        MetadataPolicy::RemovePersonal => {
            return Err(GoopError::InvalidRequest(
                "Remove personal data requires a prepared privacy plan".into(),
            ));
        }
        MetadataPolicy::Preserve => {}
    }
    let Some(source) = source else {
        return Ok(());
    };
    let plan = prepare_jpeg_plan(
        source.bytes.clone(),
        MetadataPolicy::Preserve,
        JpegOutputColor::Rgb,
    )?;
    let finished = plan.assemble_candidate(std::fs::read(output)?)?;
    std::fs::write(output, finished)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use img_parts::jpeg::JpegSegment;
    use img_parts::Bytes;
    use std::path::PathBuf;

    fn tmp_dir(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static C: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let c = C.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("goop-metadata-{label}-{n}-{c}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_test_jpeg(path: &Path) {
        use image::{Rgb, RgbImage};
        let img: RgbImage =
            ImageBuffer::from_fn(64, 64, |x, y| Rgb([x as u8, y as u8, ((x + y) as u8) / 2]));
        img.save(path).unwrap();
    }

    fn write_test_png(path: &Path) {
        let img: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_fn(32, 32, |x, y| Rgba([x as u8, y as u8, 128, 255]));
        img.save(path).unwrap();
    }

    fn make_fake_exif() -> Vec<u8> {
        // A minimal but valid-looking EXIF blob: TIFF header + 0 IFD
        // entries. img-parts doesn't validate the inner TIFF
        // structure on set_exif — it just wraps the bytes in an
        // APP1 marker.
        let mut buf = Vec::new();
        buf.extend_from_slice(&[0x49, 0x49, 0x2a, 0x00]); // little-endian TIFF magic
        buf.extend_from_slice(&[0x08, 0x00, 0x00, 0x00]); // IFD0 offset = 8
        buf.extend_from_slice(&[0x00, 0x00]); // 0 entries
        buf.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // next IFD = 0
        buf
    }

    fn make_fake_icc() -> Vec<u8> {
        // ICC profiles start with a 128-byte header. A real profile
        // is much larger; img-parts only requires the bytes for
        // wrapping into the iCCP / APP2 chunk.
        vec![0u8; 128]
    }

    #[test]
    fn container_of_recognizes_jpeg_and_png() {
        assert_eq!(container_of(Path::new("/x.jpg")), Container::Jpeg);
        assert_eq!(container_of(Path::new("/x.jpeg")), Container::Jpeg);
        assert_eq!(container_of(Path::new("/x.png")), Container::Png);
        assert_eq!(container_of(Path::new("/x.webp")), Container::Other);
    }

    #[test]
    fn jpeg_preserve_round_trips_exif() {
        let dir = tmp_dir("jpeg-preserve");
        // Build a JPEG with fake EXIF baked in.
        let in_path = dir.join("in.jpg");
        write_test_jpeg(&in_path);
        let raw = std::fs::read(&in_path).unwrap();
        let mut jpeg = Jpeg::from_bytes(raw.into()).unwrap();
        jpeg.set_exif(Some(Bytes::from(make_fake_exif())));
        jpeg.set_icc_profile(Some(Bytes::from(make_fake_icc())));
        let mut with_meta = Vec::new();
        jpeg.encoder().write_to(&mut with_meta).unwrap();
        std::fs::write(&in_path, &with_meta).unwrap();

        // Synthesize a "converted" output JPEG (same encode, no
        // metadata) and run apply() to copy metadata back in.
        let out_path = dir.join("out.jpg");
        write_test_jpeg(&out_path);

        let copied = apply(&in_path, &out_path, MetadataPolicy::Preserve).unwrap();
        assert!(copied);

        let (exif, icc) = read(&out_path).unwrap();
        assert!(exif.is_some());
        assert!(icc.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn jpeg_strip_all_is_noop() {
        let dir = tmp_dir("jpeg-strip");
        let in_path = dir.join("in.jpg");
        write_test_jpeg(&in_path);
        let out_path = dir.join("out.jpg");
        write_test_jpeg(&out_path);

        // No metadata in either file; StripAll should still succeed
        // and report `true` (i.e. "stripping happened" — even when
        // there was nothing to strip).
        let stripped = apply(&in_path, &out_path, MetadataPolicy::StripAll).unwrap();
        assert!(stripped);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cross_format_preserve_returns_false() {
        let dir = tmp_dir("cross");
        let in_path = dir.join("in.jpg");
        write_test_jpeg(&in_path);
        let out_path = dir.join("out.png");
        write_test_png(&out_path);

        // JPEG → PNG isn't a supported preserve path in v0.2.5; the
        // function returns Ok(false) so the caller can log "metadata
        // dropped for cross-format conversion".
        let copied = apply(&in_path, &out_path, MetadataPolicy::Preserve).unwrap();
        assert!(!copied);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn png_preserve_round_trips_icc() {
        let dir = tmp_dir("png-preserve");
        let in_path = dir.join("in.png");
        write_test_png(&in_path);
        let raw = std::fs::read(&in_path).unwrap();
        let mut png = Png::from_bytes(raw.into()).unwrap();
        png.set_icc_profile(Some(Bytes::from(make_fake_icc())));
        let mut with_meta = Vec::new();
        png.encoder().write_to(&mut with_meta).unwrap();
        std::fs::write(&in_path, &with_meta).unwrap();

        let out_path = dir.join("out.png");
        write_test_png(&out_path);

        let copied = apply(&in_path, &out_path, MetadataPolicy::Preserve).unwrap();
        assert!(copied);

        let (_, icc) = read(&out_path).unwrap();
        assert!(icc.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preserve_no_metadata_in_source_returns_false() {
        let dir = tmp_dir("no-meta");
        let in_path = dir.join("in.jpg");
        write_test_jpeg(&in_path);
        let out_path = dir.join("out.jpg");
        write_test_jpeg(&out_path);

        // image crate writes JPEGs without EXIF / ICC. apply()
        // returns Ok(false) so the caller knows nothing was carried.
        let copied = apply(&in_path, &out_path, MetadataPolicy::Preserve).unwrap();
        assert!(!copied);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn direct_apply_rejects_remove_personal_without_touching_output() {
        let dir = tmp_dir("direct-remove-personal");
        let in_path = dir.join("in.jpg");
        let out_path = dir.join("out.jpg");
        write_test_jpeg(&in_path);
        write_test_jpeg(&out_path);
        let before = std::fs::read(&out_path).unwrap();

        let failure = apply(&in_path, &out_path, MetadataPolicy::RemovePersonal).unwrap_err();

        assert!(failure.user_message().contains("Remove personal data"));
        assert_eq!(std::fs::read(&out_path).unwrap(), before);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn direct_apply_refuses_fragmented_jpeg_output_without_touching_it() {
        let dir = tmp_dir("fragmented-apply-output");
        let input = dir.join("input.jpg");
        let output = dir.join("output.jpg");
        write_test_jpeg(&input);
        let mut source = Jpeg::from_bytes(std::fs::read(&input).unwrap().into()).unwrap();
        source.set_exif(Some(Bytes::from(make_fake_exif())));
        std::fs::write(&input, source.encoder().bytes()).unwrap();

        let encoded = std::fs::read(&input).unwrap();
        let mut fragmented = Vec::with_capacity(encoded.len() + 20_000 * 4);
        fragmented.extend_from_slice(&encoded[..2]);
        for _ in 0..20_000 {
            fragmented.extend_from_slice(&[0xff, 0xe2, 0x00, 0x02]);
        }
        fragmented.extend_from_slice(&encoded[2..]);
        std::fs::write(&output, &fragmented).unwrap();

        let error = apply(&input, &output, MetadataPolicy::Preserve).unwrap_err();
        assert!(error.user_message().contains("segment safety limit"));
        assert_eq!(std::fs::read(&output).unwrap(), fragmented);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn direct_apply_rendered_jpeg_rejects_remove_personal_without_touching_output() {
        let dir = tmp_dir("rendered-remove-personal");
        let in_path = dir.join("in.jpg");
        let out_path = dir.join("out.jpg");
        write_test_jpeg(&in_path);
        write_test_jpeg(&out_path);
        let source = crate::jpeg_controls::prepare(&in_path, crate::jpeg_controls::MAX_INPUT_BYTES)
            .unwrap()
            .unwrap();
        let before = std::fs::read(&out_path).unwrap();

        let failure = apply_rendered_jpeg(
            Some(&source),
            &out_path,
            64,
            64,
            MetadataPolicy::RemovePersonal,
        )
        .unwrap_err();

        assert!(failure.user_message().contains("Remove personal data"));
        assert_eq!(std::fs::read(&out_path).unwrap(), before);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn exif_with_orientation(value: u16) -> Vec<u8> {
        let mut exif = b"II".to_vec();
        exif.extend_from_slice(&42u16.to_le_bytes());
        exif.extend_from_slice(&8u32.to_le_bytes());
        exif.extend_from_slice(&1u16.to_le_bytes());
        exif.extend_from_slice(&0x0112u16.to_le_bytes());
        exif.extend_from_slice(&3u16.to_le_bytes());
        exif.extend_from_slice(&1u32.to_le_bytes());
        exif.extend_from_slice(&value.to_le_bytes());
        exif.extend_from_slice(&[0, 0]);
        exif.extend_from_slice(&0u32.to_le_bytes());
        exif
    }

    fn rgb_icc(size: usize) -> Vec<u8> {
        assert!(size >= 128);
        let mut profile = vec![0; size];
        profile[..4].copy_from_slice(&(size as u32).to_be_bytes());
        profile[16..20].copy_from_slice(b"RGB ");
        profile[36..40].copy_from_slice(b"acsp");
        profile
    }

    fn base_jpeg() -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut bytes)
            .encode_image(&image::RgbImage::new(16, 8))
            .unwrap();
        bytes
    }

    fn jpeg_with_segments(segments: Vec<(u8, Vec<u8>)>) -> Vec<u8> {
        let mut jpeg = Jpeg::from_bytes(base_jpeg().into()).unwrap();
        for (marker, contents) in segments.into_iter().rev() {
            jpeg.segments_mut().insert(
                1,
                JpegSegment::new_with_contents(marker, Bytes::from(contents)),
            );
        }
        jpeg.encoder().bytes().to_vec()
    }

    fn exif_segment(value: u16) -> (u8, Vec<u8>) {
        let mut contents = b"Exif\0\0".to_vec();
        contents.extend_from_slice(&exif_with_orientation(value));
        (0xe1, contents)
    }

    fn icc_segment(sequence: u8, count: u8, payload: &[u8]) -> (u8, Vec<u8>) {
        let mut contents = b"ICC_PROFILE\0".to_vec();
        contents.extend_from_slice(&[sequence, count]);
        contents.extend_from_slice(payload);
        (0xe2, contents)
    }

    #[test]
    fn remove_personal_plan_removes_exif_and_emits_no_icc() {
        let source = jpeg_with_segments(vec![exif_segment(6)]);
        let plan = prepare_jpeg_plan(
            source.clone().into(),
            MetadataPolicy::RemovePersonal,
            JpegOutputColor::Rgb,
        )
        .unwrap();
        assert_eq!(plan.orientation().to_exif(), 6);

        let candidate = plan.assemble_candidate(base_jpeg()).unwrap();
        plan.verify_candidate(&candidate).unwrap();
        let parsed = Jpeg::from_bytes(candidate.into()).unwrap();
        assert!(parsed.exif().is_none());
        assert!(parsed.icc_profile().is_none());
    }

    #[test]
    fn remove_personal_rejects_every_icc_profile() {
        let profile = rgb_icc(128);
        let source = jpeg_with_segments(vec![icc_segment(1, 1, &profile)]);
        let failure = prepare_jpeg_plan(
            source.into(),
            MetadataPolicy::RemovePersonal,
            JpegOutputColor::Rgb,
        )
        .unwrap_err();
        assert!(failure.user_message().contains("ICC profile"));
        assert!(failure.user_message().contains("unavailable"));
    }

    #[test]
    fn remove_personal_rejects_non_three_component_jpeg() {
        let mut source = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut source)
            .encode_image(&image::GrayImage::new(16, 8))
            .unwrap();

        let failure = prepare_jpeg_plan(
            source.into(),
            MetadataPolicy::RemovePersonal,
            JpegOutputColor::Rgb,
        )
        .unwrap_err();

        assert!(failure.user_message().contains("RGB JPEG input"));
    }

    #[test]
    fn strip_all_plan_removes_exif_and_icc_but_keeps_orientation_fact() {
        let profile = rgb_icc(128);
        let source = jpeg_with_segments(vec![exif_segment(8), icc_segment(1, 1, &profile)]);
        let plan = prepare_jpeg_plan(
            source.clone().into(),
            MetadataPolicy::StripAll,
            JpegOutputColor::Rgb,
        )
        .unwrap();
        assert_eq!(plan.orientation().to_exif(), 8);
        let candidate = plan.assemble_candidate(base_jpeg()).unwrap();
        plan.verify_candidate(&candidate).unwrap();
        let parsed = Jpeg::from_bytes(candidate.into()).unwrap();
        assert!(parsed.exif().is_none());
        assert!(parsed.icc_profile().is_none());
    }

    #[test]
    fn privacy_plan_refuses_duplicate_or_malformed_exif() {
        let duplicates = jpeg_with_segments(vec![exif_segment(1), exif_segment(6)]);
        assert!(prepare_jpeg_plan(
            duplicates.into(),
            MetadataPolicy::StripAll,
            JpegOutputColor::Rgb,
        )
        .is_err());

        let malformed = jpeg_with_segments(vec![exif_segment(9)]);
        assert!(prepare_jpeg_plan(
            malformed.into(),
            MetadataPolicy::RemovePersonal,
            JpegOutputColor::Rgb
        )
        .is_err());
    }

    #[test]
    fn privacy_plan_refuses_malformed_icc_sequences() {
        let profile = rgb_icc(128);
        for segments in [
            vec![icc_segment(0, 1, &profile)],
            vec![icc_segment(1, 0, &profile)],
            vec![icc_segment(1, 2, &profile)],
            vec![
                icc_segment(1, 2, &profile[..64]),
                icc_segment(1, 2, &profile[64..]),
            ],
            vec![
                icc_segment(1, 2, &profile[..64]),
                icc_segment(2, 3, &profile[64..]),
            ],
        ] {
            let source = jpeg_with_segments(segments);
            assert!(prepare_jpeg_plan(
                source.into(),
                MetadataPolicy::StripAll,
                JpegOutputColor::Rgb,
            )
            .is_err());
        }
        let truncated_header = jpeg_with_segments(vec![(0xe2, b"ICC_PROFILE\0".to_vec())]);
        assert!(prepare_jpeg_plan(
            truncated_header.into(),
            MetadataPolicy::StripAll,
            JpegOutputColor::Rgb
        )
        .is_err());
    }

    #[test]
    fn truncated_icc_prefixes_return_errors_without_panicking() {
        for contents in [JPEG_ICC_PREFIX.to_vec(), {
            let mut contents = JPEG_ICC_PREFIX.to_vec();
            contents.push(1);
            contents
        }] {
            let source = jpeg_with_segments(vec![(0xe2, contents)]);
            let result = std::panic::catch_unwind(|| {
                prepare_jpeg_plan(
                    source.clone().into(),
                    MetadataPolicy::StripAll,
                    JpegOutputColor::Rgb,
                )
            });
            assert!(result.is_ok(), "truncated ICC APP2 must not panic");
            assert!(result.unwrap().is_err());

            let dir = tmp_dir("truncated-icc");
            let input = dir.join("input.jpg");
            std::fs::write(&input, source).unwrap();
            let read_result = std::panic::catch_unwind(|| read(&input));
            assert!(read_result.is_ok(), "metadata read must not panic");
            assert!(read_result.unwrap().is_err());
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[test]
    fn remove_personal_requires_valid_rgb_icc_for_rgb_output() {
        let mut wrong_size = rgb_icc(128);
        wrong_size[..4].copy_from_slice(&127u32.to_be_bytes());
        let mut wrong_magic = rgb_icc(128);
        wrong_magic[36..40].copy_from_slice(b"nope");
        let mut gray = rgb_icc(128);
        gray[16..20].copy_from_slice(b"GRAY");
        for profile in [wrong_size, wrong_magic, gray] {
            let source = jpeg_with_segments(vec![icc_segment(1, 1, &profile)]);
            assert!(prepare_jpeg_plan(
                source.into(),
                MetadataPolicy::RemovePersonal,
                JpegOutputColor::Rgb
            )
            .is_err());
        }
    }

    #[test]
    fn privacy_plan_rejects_invalid_icc_data_color_space() {
        let mut invalid = rgb_icc(128);
        invalid[16..20].copy_from_slice(b"NOPE");
        let source = jpeg_with_segments(vec![icc_segment(1, 1, &invalid)]);
        assert!(prepare_jpeg_plan(
            source.into(),
            MetadataPolicy::StripAll,
            JpegOutputColor::Rgb,
        )
        .is_err());
    }

    #[test]
    fn candidate_verifier_rejects_unexpected_private_metadata() {
        let source = base_jpeg();
        let plan = prepare_jpeg_plan(
            source.into(),
            MetadataPolicy::RemovePersonal,
            JpegOutputColor::Rgb,
        )
        .unwrap();
        let contaminated = jpeg_with_segments(vec![exif_segment(1)]);
        assert!(plan.verify_candidate(&contaminated).is_err());
    }

    #[test]
    fn inspection_reports_container_facts_and_policy_specific_availability() {
        let profile = rgb_icc(128);
        let source = jpeg_with_segments(vec![exif_segment(6), icc_segment(1, 1, &profile)]);
        let inspection = inspect_jpeg_metadata(source.into(), JpegOutputColor::Rgb).unwrap();
        assert!(inspection.source_has_exif);
        assert!(inspection.source_has_icc);
        let crate::exif_geometry::OrientationStatus::Valid(orientation) = inspection.orientation
        else {
            panic!("expected a valid orientation");
        };
        assert_eq!(orientation.to_exif(), 6);
        assert!(inspection.remove_personal_unavailable_reason.is_some());

        let ambiguous = jpeg_with_segments(vec![exif_segment(1), exif_segment(6)]);
        let inspection = inspect_jpeg_metadata(ambiguous.into(), JpegOutputColor::Rgb).unwrap();
        assert_eq!(
            inspection.orientation,
            crate::exif_geometry::OrientationStatus::Ambiguous
        );
        assert!(inspection.remove_personal_unavailable_reason.is_some());
    }

    #[test]
    fn preserve_plan_keeps_legacy_nonconforming_icc_and_normalizes_orientation() {
        // Legacy Preserve treats ICC as opaque bytes. In particular, existing
        // users can carry profiles that predate the stricter privacy proof.
        let legacy_icc = vec![37; 4_000];
        let source = jpeg_with_segments(vec![exif_segment(6), icc_segment(1, 1, &legacy_icc)]);
        let plan = prepare_jpeg_plan(
            source.into(),
            MetadataPolicy::Preserve,
            JpegOutputColor::Rgb,
        )
        .unwrap();
        let candidate = plan.assemble_candidate(base_jpeg()).unwrap();
        plan.verify_candidate(&candidate).unwrap();

        let parsed = Jpeg::from_bytes(candidate.into()).unwrap();
        assert_eq!(parsed.icc_profile().unwrap().as_ref(), legacy_icc);
        assert_eq!(
            crate::exif_geometry::orientation(parsed.exif().unwrap().as_ref())
                .unwrap()
                .to_exif(),
            1
        );
    }

    #[test]
    fn target_preserve_accepts_malformed_and_duplicate_exif_and_keeps_the_first() {
        let malformed = {
            let mut contents = JPEG_EXIF_PREFIX.to_vec();
            contents.extend_from_slice(b"not-a-tiff");
            (0xe1, contents)
        };
        let first = malformed.1[JPEG_EXIF_PREFIX.len()..].to_vec();
        let source = jpeg_with_segments(vec![malformed, exif_segment(6)]);

        let plan = prepare_jpeg_target_plan(source.into()).unwrap();
        assert_eq!(plan.orientation().to_exif(), 1);
        let candidate = plan.assemble_candidate(base_jpeg()).unwrap();
        let parsed = Jpeg::from_bytes(candidate.into()).unwrap();
        assert_eq!(parsed.exif().unwrap().as_ref(), first);
    }
}
