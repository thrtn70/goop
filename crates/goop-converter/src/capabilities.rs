//! Engine-owned availability shared by the picker, queue admission and execution.
#[cfg(feature = "heic-thumbnail-preview")]
use crate::heic_preview_sampler::inspect_heic_thumbnail;
use crate::{
    backend_for_extension, BackendKind, ConversionBackend, FfmpegBackend, ImageMagickBackend,
};
use goop_core::{
    AlphaPolicyAvailability, ColorPolicyAvailability, CompressMode, CompressionCapabilities,
    ConversionCapabilities, ConvertRequest, GoopError, ImageAlphaCapabilities,
    ImageColorCapabilities, ImageColorPolicy, ImageMetadataCapabilities, ImageOrientationStatus,
    ImageResize, ImageSettingsCapabilities, MetadataPolicy, MetadataPolicyAvailability,
    ProbeResult, SourceKind, SrgbColor, TargetCapability, TargetFormat, TrackSourceBinding,
};
use goop_sidecar::BinaryResolver;
use img_parts::Bytes;
use std::{
    fs::File,
    io::{Cursor, Read},
    path::Path,
};

pub fn compression_for(target: TargetFormat) -> CompressionCapabilities {
    use TargetFormat::*;
    let (quality, target_size, lossless, reason) = match target {
        Jpeg => (true, true, false, None),
        Webp => (true, false, true, Some("WebP supports Quality and Lossless. Target Size is not available yet.")),
        Png | Tiff => (false, false, true, Some("Only lossless reoptimization is supported. Convert to JPEG for quality or target-size compression.")),
        Bmp | Avif | JpegXl | Srt | Vtt | Gif | Wav | Flac | ExtractAudioKeepCodec => (false, false, false, Some("Compression controls are unavailable for this format. Choose another output format in Convert.")),
        _ => (true, true, false, None),
    };
    CompressionCapabilities {
        quality,
        target_size,
        lossless,
        reason: reason.map(str::to_owned),
    }
}

fn compression_for_image_target(
    target: TargetFormat,
    source_format: &str,
    source_has_alpha: Option<bool>,
) -> CompressionCapabilities {
    if target == TargetFormat::Jpeg && source_has_alpha == Some(true) {
        return CompressionCapabilities {
            quality: false,
            target_size: false,
            lossless: false,
            reason: Some(
                "JPEG compression cannot remove transparency. Use Convert and choose an explicit background."
                    .into(),
            ),
        };
    }
    if target == TargetFormat::Webp && !matches!(source_format, "jpg" | "jpeg" | "png" | "webp") {
        return CompressionCapabilities {
            quality: false,
            target_size: false,
            lossless: true,
            reason: Some(
                "WebP Quality is available for JPEG, PNG and WebP sources. Lossless remains available for this source."
                    .into(),
            ),
        };
    }
    compression_for(target)
}

pub fn capabilities_for(probe: &ProbeResult) -> ConversionCapabilities {
    capabilities_for_with_encoders(probe, None)
}

pub fn capabilities_for_with_encoders(
    probe: &ProbeResult,
    encoders: Option<&crate::DetectedEncoders>,
) -> ConversionCapabilities {
    capabilities_for_bound_source(probe, encoders, None)
}

fn capabilities_for_bound_source(
    probe: &ProbeResult,
    encoders: Option<&crate::DetectedEncoders>,
    track_source: Option<&TrackSourceBinding>,
) -> ConversionCapabilities {
    use TargetFormat::*;
    let mut targets = vec![];
    match probe.source_kind {
        SourceKind::Image => targets.extend([Png, Jpeg, Webp, Avif, JpegXl, Tiff, Bmp]),
        SourceKind::Subtitle => targets.extend([Srt, Vtt]),
        SourceKind::Video | SourceKind::Audio => {
            if probe.has_video {
                targets.extend([Mp4, Mkv, Webm, Gif, Avi, Mov]);
            }
            if probe.has_audio {
                targets.extend([Mp3, M4a, Opus, Wav, Flac, Ogg, Aac, ExtractAudioKeepCodec]);
            }
            if probe.has_subtitles {
                targets.extend([Srt, Vtt]);
            }
        }
        SourceKind::Pdf => {}
    }
    let fmt = probe
        .image_format
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    let raw = fmt == "raw" || crate::raw::is_raw_extension(&fmt);
    let raw_unavailable = raw && !cfg!(target_os = "macos");
    let image = probe.source_kind == SourceKind::Image;
    let source_target = match fmt.as_str() {
        "jpg" | "jpeg" => Some(Jpeg),
        "png" => Some(Png),
        "webp" => Some(Webp),
        "tif" | "tiff" => Some(Tiff),
        "avif" => Some(Avif),
        "jxl" | "jpegxl" | "jpeg_xl" | "jpeg-xl" => Some(JpegXl),
        "bmp" => Some(Bmp),
        _ => None,
    };
    let compression = if image {
        source_target
            .map(compression_for)
            .unwrap_or(CompressionCapabilities {
                quality: false,
                target_size: false,
                lossless: false,
                reason: Some(
                    "Convert this image to JPEG, PNG, WebP or TIFF before compressing.".into(),
                ),
            })
    } else if matches!(probe.source_kind, SourceKind::Video | SourceKind::Audio) {
        let source = match probe
            .container
            .as_deref()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "wav" => Wav,
            "flac" => Flac,
            "gif" => Gif,
            _ => Mp4,
        };
        compression_for(source)
    } else {
        compression_for(Srt)
    };
    let first_subtitle_is_text = crate::subtitle::can_preserve_existing(
        &probe.subtitle_codecs[..probe.subtitle_codecs.len().min(1)],
    );
    ConversionCapabilities {
        targets: targets.into_iter().map(|target| {
            let preserves_metadata = image && matches!((source_target, target), (Some(Jpeg), Jpeg) | (Some(Png), Png));
            let reason = if raw_unavailable {
                Some("RAW rendering requires macOS. Export the original to TIFF or JPEG on a Mac first.".into())
            } else if target.is_subtitle() && !first_subtitle_is_text {
                Some("The first subtitle stream is bitmap-based or unknown. Text extraction requires a supported text subtitle stream; bitmap subtitles need OCR.".into())
            } else { None };
            let empty = crate::DetectedEncoders::empty();
            let encoder_inventory = encoders.unwrap_or(&empty);
            let video_track_settings = if probe.source_kind == SourceKind::Video
                && matches!(target, Mp4 | Mov | Mkv)
            {
                track_source.and_then(|source| {
                    crate::video_track_options::settings(
                        probe,
                        target,
                        encoder_inventory,
                        source,
                    )
                    .ok()
                })
            } else {
                None
            };
            TargetCapability {
                image_color: image.then(|| base_image_color_capabilities(target)),
                image_alpha: (image && target == Jpeg)
                    .then(|| base_image_alpha_capabilities(target)),
                image_metadata: image.then(|| base_image_metadata_capabilities(
                    preserves_metadata,
                    source_target == Some(Jpeg) && target == Jpeg,
                )),
                video_track_settings: video_track_settings.clone(),
                audio_settings: if matches!(target, Mp3 | M4a | Aac | Wav | Flac) {
                    Some(crate::audio_options::capabilities(
                        probe,
                        target,
                        encoder_inventory,
                    ))
                } else {
                    None
                },
                video_settings: if probe.source_kind == SourceKind::Video && matches!(target, Mp4 | Mov | Mkv) {
                    let mut settings = if video_track_settings.is_some() {
                        crate::video_options::capabilities_with_auxiliary(
                            probe,
                            target,
                            encoder_inventory,
                        )
                    } else {
                        crate::video_options::capabilities(probe, target, encoder_inventory)
                    };
                    if encoders.is_none() {
                        settings.copy = goop_core::VideoModeAvailability { available: false, reason: Some("Explicit video settings require an encoder inventory and fresh inspection".into()) };
                    }
                    Some(settings)
                } else { None },
                track_settings: if matches!(target, Mp3 | M4a | Aac | Wav | Flac) {
                    track_source.and_then(|source| {
                        crate::track_options::settings(
                            probe,
                            target,
                            encoder_inventory,
                            source,
                        )
                        .ok()
                    })
                } else {
                    None
                },
                compression: Some(if image {
                    compression_for_image_target(target, &fmt, probe.image_has_alpha)
                } else {
                    compression_for(target)
                }),
                image_settings: image_settings_for(probe, target),
                target,
                available: reason.is_none(),
                reason,
                preserves_metadata,
                metadata_warning: (image && !preserves_metadata).then(|| if raw {
                    "RAW renders as SDR sRGB. Original RAW metadata and HDR range are not preserved.".into()
                } else {
                    "Original EXIF and ICC metadata are not preserved for this conversion.".into()
                }),
            }
        }).collect(),
        compression,
    }
}

fn policy_availability(
    available: bool,
    summary: impl Into<String>,
    reason: Option<String>,
) -> MetadataPolicyAvailability {
    MetadataPolicyAvailability {
        available,
        reason,
        summary: summary.into(),
    }
}

fn color_availability(
    available: bool,
    summary: impl Into<String>,
    reason: Option<String>,
) -> ColorPolicyAvailability {
    ColorPolicyAvailability {
        available,
        reason,
        summary: summary.into(),
    }
}

fn base_image_color_capabilities(target: TargetFormat) -> ImageColorCapabilities {
    let target_reason = (!matches!(target, TargetFormat::Jpeg | TargetFormat::Png))
        .then(|| "Color-managed conversion is available only for JPEG and PNG output.".into());
    ImageColorCapabilities {
        preserve: color_availability(
            true,
            "Keep the existing pixel and color-metadata behavior.",
            None,
        ),
        convert_to_srgb: color_availability(
            false,
            "Convert a tagged 8-bit RGB or grayscale source to sRGB.",
            target_reason.clone().or_else(|| {
                Some("Fresh color-profile inspection is required before conversion.".into())
            }),
        ),
        assume_srgb: color_availability(
            false,
            "Treat an untagged 8-bit RGB or grayscale source as sRGB.",
            target_reason.or_else(|| {
                Some(
                    "Fresh color-profile inspection is required before making an assumption."
                        .into(),
                )
            }),
        ),
    }
}

fn base_image_alpha_capabilities(target: TargetFormat) -> ImageAlphaCapabilities {
    let reason = if target == TargetFormat::Jpeg {
        "Fresh transparency and color-profile inspection is required before flattening."
    } else {
        "Transparency flattening is currently available only for JPEG output."
    };
    ImageAlphaCapabilities {
        source_has_alpha: None,
        flatten: AlphaPolicyAvailability {
            available: false,
            reason: Some(reason.into()),
            summary: "Composite transparency over an explicit sRGB background in linear sRGB."
                .into(),
        },
        required_color_policy: None,
        suggested_background: SrgbColor {
            red: 255,
            green: 255,
            blue: 255,
        },
    }
}

fn enrich_image_alpha_capabilities(
    inspection: &Result<crate::color::SourceInspection, String>,
    probed_alpha: Option<bool>,
    capabilities: &mut ConversionCapabilities,
) {
    for target in &mut capabilities.targets {
        let Some(alpha) = target.image_alpha.as_mut() else {
            continue;
        };
        if target.target != TargetFormat::Jpeg {
            continue;
        }
        alpha.source_has_alpha = probed_alpha;
        match inspection {
            Ok(source) => {
                alpha.source_has_alpha = Some(source.layout.has_alpha());
                alpha.required_color_policy = Some(if source.profile.is_some() {
                    ImageColorPolicy::ConvertToSrgb
                } else {
                    ImageColorPolicy::AssumeSrgb
                });
                alpha.flatten = AlphaPolicyAvailability {
                    available: true,
                    reason: None,
                    summary: if source.layout.has_alpha() {
                        "Transparency will be composited over the selected background in linear sRGB."
                            .into()
                    } else {
                        "This source is opaque; the saved background remains available for transparent inputs."
                            .into()
                    },
                };
            }
            Err(reason) => {
                alpha.flatten.reason = Some(reason.clone());
            }
        }
    }
}

fn enrich_image_color_capabilities(
    inspection: &Result<crate::color::SourceInspection, String>,
    probe: &ProbeResult,
    capabilities: &mut ConversionCapabilities,
) {
    let png_source = probe
        .image_format
        .as_deref()
        .is_some_and(|format| format.eq_ignore_ascii_case("png"));
    let image_settings_required_color_policy = if png_source {
        inspection.as_ref().ok().map(|source| {
            if source.profile.is_some() {
                ImageColorPolicy::ConvertToSrgb
            } else {
                ImageColorPolicy::AssumeSrgb
            }
        })
    } else {
        None
    };
    for target in &mut capabilities.targets {
        if target.target == TargetFormat::Jpeg {
            if let Some(settings) = target.image_settings.as_mut() {
                if png_source {
                    match inspection {
                        Ok(_) => {
                            settings.required_color_policy = image_settings_required_color_policy;
                            if settings.available {
                                let original_reason = if probe.file_size
                                    > crate::preview::MAX_INPUT_BYTES
                                {
                                    Some(
                                        "Image preview source exceeds the 64 MiB input limit."
                                            .into(),
                                    )
                                } else if probe.width.zip(probe.height).is_none_or(
                                    |(width, height)| {
                                        width == 0
                                            || height == 0
                                            || u64::from(width) * u64::from(height)
                                                > crate::preview::MAX_SOURCE_PIXELS
                                    },
                                ) {
                                    Some(
                                        "Image preview source exceeds the 4 million decoded-pixel limit."
                                            .into(),
                                    )
                                } else {
                                    None
                                };
                                settings.preview_original_available = original_reason.is_none();
                                settings.preview_unavailable_reason =
                                    original_reason.or_else(|| {
                                        Some(
                                            "Fit within image samples are not available yet."
                                                .into(),
                                        )
                                    });
                            }
                        }
                        Err(reason) => {
                            settings.available = false;
                            settings.reason = Some(reason.clone());
                            settings.required_color_policy = None;
                            settings.preview_original_available = false;
                            settings.preview_fit_within = false;
                            settings.preview_unavailable_reason = Some(reason.clone());
                        }
                    }
                }
            }
        }
        let Some(color) = target.image_color.as_mut() else {
            continue;
        };
        if !matches!(target.target, TargetFormat::Jpeg | TargetFormat::Png) {
            continue;
        }
        if target.target == TargetFormat::Png
            && inspection
                .as_ref()
                .is_ok_and(|source| source.layout.has_alpha())
        {
            let reason = "Explicit color handling is not available for alpha-bearing PNG output.";
            color.convert_to_srgb.reason = Some(reason.into());
            color.assume_srgb.reason = Some(reason.into());
            continue;
        }
        match inspection {
            Ok(source) if source.profile.is_some() => {
                color.convert_to_srgb = color_availability(
                    true,
                    "Pixels will be converted from the embedded profile to sRGB; source EXIF is omitted and a canonical sRGB profile is attached.",
                    None,
                );
                color.assume_srgb.reason =
                    Some("The source already has an embedded ICC profile.".into());
            }
            Ok(_) => {
                color.assume_srgb = color_availability(
                    true,
                    "Untagged pixels will be explicitly treated as sRGB; source EXIF is omitted and a canonical sRGB profile is attached.",
                    None,
                );
                color.convert_to_srgb.reason = Some(
                    "The source has no embedded ICC profile. Choose Assume sRGB only if that assumption is correct."
                        .into(),
                );
            }
            Err(reason) => {
                color.convert_to_srgb.reason = Some(reason.clone());
                color.assume_srgb.reason = Some(reason.clone());
            }
        }
    }
}

fn enrich_heic_preview_capabilities(
    inspection: &ImageSourceInspection,
    capabilities: &mut ConversionCapabilities,
) {
    let Some(preview) = inspection.heic_preview.as_ref() else {
        return;
    };
    let Some(settings) = capabilities
        .targets
        .iter_mut()
        .find(|target| target.target == TargetFormat::Jpeg)
        .and_then(|target| target.image_settings.as_mut())
    else {
        return;
    };
    if !settings.available {
        return;
    }
    match preview {
        Ok(()) => {
            settings.preview_original_available = true;
            settings.preview_fit_within = true;
            settings.preview_unavailable_reason = None;
        }
        Err(reason) => {
            settings.preview_original_available = false;
            settings.preview_fit_within = false;
            settings.preview_unavailable_reason = Some(reason.clone());
        }
    }
}

fn base_image_metadata_capabilities(
    preserves_metadata: bool,
    jpeg_pair: bool,
) -> ImageMetadataCapabilities {
    ImageMetadataCapabilities {
        preserve: policy_availability(
            true,
            if preserves_metadata {
                "Supported source EXIF and ICC metadata will be retained."
            } else {
                "This output path does not retain source EXIF or ICC metadata."
            },
            None,
        ),
        rgb_reencode_preserve: policy_availability(
            true,
            if preserves_metadata {
                "Supported source EXIF and RGB ICC metadata will be retained."
            } else {
                "This output path does not retain source EXIF or ICC metadata."
            },
            None,
        ),
        remove_personal: policy_availability(
            false,
            "Remove personal data is unavailable for this source and output.",
            Some(if jpeg_pair {
                "Fresh JPEG metadata inspection is required before personal data can be removed."
                    .into()
            } else {
                "Remove personal data is currently available only for JPEG to JPEG processing."
                    .into()
            }),
        ),
        strip_all: policy_availability(
            true,
            "All source metadata and the ICC color profile will be removed.",
            None,
        ),
        source_has_exif: None,
        source_has_icc: None,
        orientation: ImageOrientationStatus::Uninspected,
    }
}

fn enrich_jpeg_metadata_capabilities(
    inspection: Option<&crate::metadata::JpegMetadataInspection>,
    capabilities: &mut ConversionCapabilities,
) {
    let Some(inspection) = inspection else {
        return;
    };
    let orientation = match inspection.orientation {
        crate::exif_geometry::OrientationStatus::Absent => ImageOrientationStatus::Absent,
        crate::exif_geometry::OrientationStatus::Valid(_) => ImageOrientationStatus::Valid,
        crate::exif_geometry::OrientationStatus::Malformed => ImageOrientationStatus::Malformed,
        crate::exif_geometry::OrientationStatus::Ambiguous => ImageOrientationStatus::Ambiguous,
    };
    let orientation_reason = match orientation {
        ImageOrientationStatus::Malformed => Some(
            "JPEG orientation metadata is malformed, so privacy modes cannot safely normalize the image."
                .into(),
        ),
        ImageOrientationStatus::Ambiguous => Some(
            "JPEG orientation metadata is ambiguous, so privacy modes cannot safely normalize the image."
                .into(),
        ),
        ImageOrientationStatus::Uninspected => Some(
            "JPEG orientation metadata was not inspected, so privacy modes cannot safely normalize the image."
                .into(),
        ),
        ImageOrientationStatus::Absent | ImageOrientationStatus::Valid => None,
    };
    for target in &mut capabilities.targets {
        let Some(metadata) = target.image_metadata.as_mut() else {
            continue;
        };
        metadata.source_has_exif = Some(inspection.source_has_exif);
        metadata.source_has_icc = Some(inspection.source_has_icc);
        metadata.orientation = orientation;
        if target.target == TargetFormat::Jpeg {
            metadata.preserve = policy_availability(
                inspection.preserve_unavailable_reason.is_none(),
                "Supported source EXIF and ICC metadata will be retained.",
                inspection.preserve_unavailable_reason.clone(),
            );
            metadata.rgb_reencode_preserve = policy_availability(
                inspection
                    .rgb_reencode_preserve_unavailable_reason
                    .is_none(),
                "Supported source EXIF and RGB ICC metadata will be retained.",
                inspection.rgb_reencode_preserve_unavailable_reason.clone(),
            );
            let remove_reason = orientation_reason
                .clone()
                .or_else(|| inspection.remove_personal_unavailable_reason.clone());
            metadata.remove_personal = policy_availability(
                remove_reason.is_none(),
                "Personal metadata will be removed from this untagged JPEG.",
                remove_reason,
            );
            metadata.strip_all = policy_availability(
                inspection.strip_all_unavailable_reason.is_none() && orientation_reason.is_none(),
                "All source metadata and the ICC color profile will be removed.",
                orientation_reason
                    .clone()
                    .or_else(|| inspection.strip_all_unavailable_reason.clone()),
            );
        }
    }
}

struct ImageSourceInspection {
    probe: ProbeResult,
    jpeg_metadata: Option<crate::metadata::JpegMetadataInspection>,
    color: Result<crate::color::SourceInspection, String>,
    heic_preview: Option<Result<(), String>>,
}

enum ColorRasterSnapshot {
    Captured(Bytes),
    OversizedPng { header: Vec<u8>, file_size: u64 },
}

fn oversized_png_probe(header: &[u8], file_size: u64) -> Result<ProbeResult, GoopError> {
    if header.len() < 33
        || !header.starts_with(b"\x89PNG\r\n\x1a\n")
        || header.get(8..12) != Some(13_u32.to_be_bytes().as_slice())
        || header.get(12..16) != Some(b"IHDR")
    {
        return Err(GoopError::InvalidRequest(
            "failed to read image snapshot: invalid PNG header".into(),
        ));
    }
    let width = u32::from_be_bytes(header[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(header[20..24].try_into().unwrap());
    if width == 0 || height == 0 {
        return Err(GoopError::InvalidRequest(
            "failed to read image snapshot: invalid PNG dimensions".into(),
        ));
    }
    let bit_depth = header[24];
    let color_type = header[25];
    let legal_layout = matches!(
        (color_type, bit_depth),
        (0, 1 | 2 | 4 | 8 | 16) | (2, 8 | 16) | (3, 1 | 2 | 4 | 8) | (4, 8 | 16) | (6, 8 | 16)
    );
    let mut crc = crc32fast::Hasher::new();
    crc.update(&header[12..29]);
    let declared_crc = u32::from_be_bytes(header[29..33].try_into().unwrap());
    if !legal_layout
        || header[26] != 0
        || header[27] != 0
        || header[28] > 1
        || crc.finalize() != declared_crc
    {
        return Err(GoopError::InvalidRequest(
            "failed to read image snapshot: invalid PNG header".into(),
        ));
    }
    Ok(crate::imagemagick_probe::image_probe_result(
        (width, height),
        Some("Png".into()),
        matches!(color_type, 4 | 6).then_some(true),
        file_size,
    ))
}

fn color_raster_snapshot(path: &Path) -> Result<Option<ColorRasterSnapshot>, GoopError> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(GoopError::InvalidRequest(
            "Image inspection requires a file".into(),
        ));
    }
    let mut signature = Vec::with_capacity(8);
    (&mut file).take(8).read_to_end(&mut signature)?;
    let jpeg = signature.starts_with(&[0xff, 0xd8, 0xff]);
    let png = signature.starts_with(b"\x89PNG\r\n\x1a\n");
    if !jpeg && !png {
        return Ok(None);
    }
    if png && metadata.len() > crate::color::MAX_INPUT_BYTES {
        let mut header = signature;
        (&mut file).take(25).read_to_end(&mut header)?;
        return Ok(Some(ColorRasterSnapshot::OversizedPng {
            header,
            file_size: metadata.len(),
        }));
    }
    let (limit, message) = if jpeg {
        (
            crate::jpeg_controls::MAX_INPUT_BYTES,
            "Image inspection input exceeds the 512 MiB limit",
        )
    } else {
        (
            crate::color::MAX_INPUT_BYTES,
            "Image inspection input exceeds the 64 MiB limit",
        )
    };
    crate::image_read::read_snapshot(
        Cursor::new(signature).chain(file),
        limit,
        message,
        || Ok(()),
    )
    .map(|bytes| Some(ColorRasterSnapshot::Captured(bytes)))
}

#[cfg(feature = "heic-thumbnail-preview")]
fn path_matches_snapshot(path: &Path, snapshot: &[u8]) -> Result<bool, GoopError> {
    let mut file = File::open(path)?;
    let mut offset = 0usize;
    let mut buffer = [0_u8; 64 * 1024];
    while offset < snapshot.len() {
        let requested = (snapshot.len() - offset).min(buffer.len());
        let count = file.read(&mut buffer[..requested])?;
        if count == 0 || buffer[..count] != snapshot[offset..offset + count] {
            return Ok(false);
        }
        offset += count;
    }
    Ok(file.read(&mut buffer[..1])? == 0)
}

fn inspect_image_source_snapshot_blocking(
    path: &Path,
    after_snapshot: impl FnOnce(),
) -> Result<ImageSourceInspection, GoopError> {
    if let Some(snapshot) = color_raster_snapshot(path)? {
        after_snapshot();
        let (probe, jpeg_metadata, color) = match snapshot {
            ColorRasterSnapshot::Captured(bytes) => {
                let probe = crate::imagemagick_probe::probe_raster_snapshot(bytes.clone())?;
                let jpeg = crate::jpeg_controls::JpegSource::from_snapshot(bytes.clone());
                let jpeg_metadata = jpeg
                    .as_ref()
                    .map(|source| source.inspect_metadata(crate::metadata::JpegOutputColor::Rgb))
                    .transpose()?;
                let color = if bytes.len() as u64 > crate::color::MAX_INPUT_BYTES {
                    Err("Color-managed image input exceeds the 64 MiB limit".into())
                } else {
                    crate::color::prepare_bytes(bytes)
                        .and_then(|prepared| {
                            crate::color::validate_native_profile(&prepared.inspection)?;
                            Ok(prepared.inspection)
                        })
                        .map_err(|error| error.user_message())
                };
                (probe, jpeg_metadata, color)
            }
            ColorRasterSnapshot::OversizedPng { header, file_size } => (
                oversized_png_probe(&header, file_size)?,
                None,
                Err("Color-managed image input exceeds the 64 MiB limit".into()),
            ),
        };
        return Ok(ImageSourceInspection {
            probe,
            jpeg_metadata,
            color,
            heic_preview: None,
        });
    }

    let is_heic = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("heic") || extension.eq_ignore_ascii_case("heif")
        });
    #[cfg(not(feature = "heic-thumbnail-preview"))]
    let heic_preview =
        is_heic.then(|| Err("Bounded HEIC preview is not enabled in this build.".into()));
    #[cfg(feature = "heic-thumbnail-preview")]
    let (heic_preview, heic_snapshot) = if is_heic {
        let file = File::open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(GoopError::InvalidRequest(
                "Image inspection requires a file".into(),
            ));
        }
        if metadata.len() > crate::preview::MAX_INPUT_BYTES {
            (
                Some(Err(
                    "Image preview source exceeds the 64 MiB input limit.".into()
                )),
                None,
            )
        } else {
            let bytes = crate::image_read::read_snapshot(
                file,
                crate::preview::MAX_INPUT_BYTES,
                "Image preview source exceeds the 64 MiB input limit",
                || Ok(()),
            )?;
            let preview =
                inspect_heic_thumbnail(bytes.as_ref(), &|| Ok(())).map_err(|error| match error {
                    crate::heic_preview_sampler::SamplerError::NoAdmittedThumbnail => {
                        "This source has no bounded embedded thumbnail.".into()
                    }
                    error => format!("HEIC preview unavailable: {error}."),
                });
            (Some(preview), Some(bytes))
        }
    } else {
        (None, None)
    };
    after_snapshot();
    let probe = crate::imagemagick_probe::probe_image(path)?;
    #[cfg(feature = "heic-thumbnail-preview")]
    if let Some(snapshot) = heic_snapshot {
        if !path_matches_snapshot(path, &snapshot)? {
            return Err(GoopError::InvalidRequest(
                "Source changed while inspecting HEIC preview capability".into(),
            ));
        }
    }
    Ok(ImageSourceInspection {
        probe,
        jpeg_metadata: None,
        color: Err("Color-managed conversion currently requires JPEG or PNG input".into()),
        heic_preview,
    })
}

async fn inspect_image_source_snapshot(path: &Path) -> Result<ImageSourceInspection, GoopError> {
    let inspection_path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        inspect_image_source_snapshot_blocking(&inspection_path, || {})
    })
    .await
    .map_err(|error| GoopError::InvalidRequest(format!("Image inspection task failed: {error}")))?
}

fn validate_metadata_policy(
    req: &ConvertRequest,
    capabilities: &ConversionCapabilities,
) -> Result<(), GoopError> {
    if req.image_color_policy.unwrap_or_default() != ImageColorPolicy::Preserve {
        return Ok(());
    }
    let policy = req.metadata_policy.unwrap_or_default();
    let metadata = capabilities
        .targets
        .iter()
        .find(|target| target.target == req.target)
        .and_then(|target| target.image_metadata.as_ref())
        .ok_or_else(|| {
            GoopError::InvalidRequest(
                "Metadata policy is unavailable for this source and output.".into(),
            )
        })?;
    let availability = match policy {
        MetadataPolicy::Preserve if req.image_options.is_none() => &metadata.rgb_reencode_preserve,
        MetadataPolicy::Preserve => &metadata.preserve,
        MetadataPolicy::RemovePersonal => &metadata.remove_personal,
        MetadataPolicy::StripAll => &metadata.strip_all,
    };
    if availability.available {
        Ok(())
    } else {
        Err(GoopError::InvalidRequest(
            availability
                .reason
                .clone()
                .unwrap_or_else(|| availability.summary.clone()),
        ))
    }
}

fn validate_color_policy(
    req: &ConvertRequest,
    capabilities: &ConversionCapabilities,
) -> Result<(), GoopError> {
    let policy = req.image_color_policy.unwrap_or_default();
    if policy == ImageColorPolicy::Preserve {
        return Ok(());
    }
    if req.compress_mode.is_some() {
        return Err(GoopError::InvalidRequest(
            "Explicit color handling is currently available in Convert only".into(),
        ));
    }
    let color = capabilities
        .targets
        .iter()
        .find(|target| target.target == req.target)
        .and_then(|target| target.image_color.as_ref())
        .ok_or_else(|| {
            GoopError::InvalidRequest(
                "Color policy is unavailable for this source and output.".into(),
            )
        })?;
    let availability = match policy {
        ImageColorPolicy::Preserve => &color.preserve,
        ImageColorPolicy::ConvertToSrgb => &color.convert_to_srgb,
        ImageColorPolicy::AssumeSrgb => &color.assume_srgb,
    };
    if availability.available {
        Ok(())
    } else {
        Err(GoopError::InvalidRequest(
            availability
                .reason
                .clone()
                .unwrap_or_else(|| availability.summary.clone()),
        ))
    }
}

fn validate_alpha_policy(
    req: &ConvertRequest,
    capabilities: &ConversionCapabilities,
) -> Result<(), GoopError> {
    let target = capabilities
        .targets
        .iter()
        .find(|target| target.target == req.target)
        .and_then(|target| target.image_alpha.as_ref());
    let source_has_alpha = target.and_then(|alpha| alpha.source_has_alpha);
    if req.image_alpha_policy.is_none() {
        return if source_has_alpha == Some(true) {
            Err(GoopError::InvalidRequest(
                "JPEG removes transparency; choose an explicit background before converting."
                    .into(),
            ))
        } else {
            Ok(())
        };
    }
    let alpha = target.ok_or_else(|| {
        GoopError::InvalidRequest(
            "Transparency flattening is unavailable for this source and output.".into(),
        )
    })?;
    if !alpha.flatten.available {
        return Err(GoopError::InvalidRequest(
            alpha
                .flatten
                .reason
                .clone()
                .unwrap_or_else(|| alpha.flatten.summary.clone()),
        ));
    }
    if alpha.required_color_policy != req.image_color_policy {
        return Err(GoopError::InvalidRequest(match alpha.required_color_policy {
            Some(ImageColorPolicy::ConvertToSrgb) => {
                "This source has an embedded profile; choose Convert to sRGB before flattening."
                    .into()
            }
            Some(ImageColorPolicy::AssumeSrgb) => {
                "This source has no ICC profile; explicitly choose Assume sRGB before flattening."
                    .into()
            }
            _ => "The selected color policy cannot flatten this source.".into(),
        }));
    }
    Ok(())
}

fn image_settings_for(
    probe: &ProbeResult,
    target: TargetFormat,
) -> Option<ImageSettingsCapabilities> {
    if target != TargetFormat::Jpeg {
        return None;
    }

    let format = probe
        .image_format
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    let jpeg = matches!(format.as_str(), "jpg" | "jpeg");
    let png = format == "png";
    let heic = matches!(format.as_str(), "heic" | "heif");
    let raw = format == "raw" || crate::raw::is_raw_extension(&format);
    let dimensions = probe.width.zip(probe.height);
    let dimension_error = dimensions
        .and_then(|source| {
            crate::image_options::output_dimensions(source, &ImageResize::Original).err()
        })
        .map(|error| error.user_message());

    let reason = if probe.source_kind != SourceKind::Image || !(jpeg || png || heic || raw) {
        Some("Explicit JPEG settings are available for JPEG, PNG, HEIC and RAW sources.".into())
    } else if raw && !cfg!(target_os = "macos") {
        Some("RAW rendering requires macOS.".into())
    } else if !png && probe.image_has_alpha == Some(true) {
        Some("JPEG settings are unavailable for unsupported transparent sources.".into())
    } else if probe.image_has_alpha.is_none() {
        Some("JPEG settings require a source whose opacity can be verified.".into())
    } else if dimensions.is_none() {
        Some("JPEG settings require known source dimensions.".into())
    } else {
        dimension_error
    };
    let available = reason.is_none();

    let preview_original_reason = if !available {
        reason.clone()
    } else if heic {
        Some(if cfg!(feature = "heic-thumbnail-preview") {
            "Fresh bounded HEIC thumbnail inspection is required.".into()
        } else {
            "Bounded HEIC preview is not enabled in this build.".into()
        })
    } else if !jpeg {
        Some("Original image samples are available for JPEG sources only.".into())
    } else if probe.file_size > crate::preview::MAX_INPUT_BYTES {
        Some("Image preview source exceeds the 64 MiB input limit.".into())
    } else if dimensions.is_none_or(|(width, height)| {
        width == 0
            || height == 0
            || u64::from(width) * u64::from(height) > crate::preview::MAX_SOURCE_PIXELS
    }) {
        Some("Image preview source exceeds the 4 million decoded-pixel limit.".into())
    } else {
        None
    };
    let preview_original_available = preview_original_reason.is_none();
    let preview_unavailable_reason = preview_original_reason
        .or_else(|| Some("Fit within image samples are not available yet.".into()));

    Some(ImageSettingsCapabilities {
        available,
        reason,
        required_color_policy: None,
        quality_min: 1,
        quality_max: 100,
        default_quality: 75,
        max_dimension: crate::image_options::MAX_DIMENSION,
        max_output_pixels: crate::image_options::MAX_OUTPUT_PIXELS,
        fit_within: true,
        upscale: false,
        preview_original_available,
        preview_fit_within: false,
        preview_unavailable_reason,
    })
}

fn refused(reason: impl Into<String>) -> GoopError {
    GoopError::SubprocessFailed {
        binary: "converter".into(),
        stderr: reason.into(),
    }
}

/// The probe must be obtained from the engine's source read, never from client input.
pub fn validate_request(req: &ConvertRequest, probe: &ProbeResult) -> Result<(), GoopError> {
    goop_core::validate_image_alpha_request_shape(req)?;
    goop_core::validate_video_request(req)?;
    goop_core::validate_audio_request(req)?;
    goop_core::validate_track_request(req)?;
    crate::track_options::resolve(req, probe)?;
    // Compression uses a separate plan that cannot apply these video settings.
    let video_settings_supported =
        probe.source_kind == SourceKind::Video && req.compress_mode.is_none();
    let quality_supported = video_settings_supported
        && matches!(
            req.target,
            TargetFormat::Mp4 | TargetFormat::Mkv | TargetFormat::Webm | TargetFormat::Mov
        );
    let resolution_supported =
        quality_supported || (video_settings_supported && req.target == TargetFormat::Avi);
    if (req
        .quality_preset
        .is_some_and(|q| q != goop_core::QualityPreset::Original)
        && !quality_supported)
        || (req
            .resolution_cap
            .is_some_and(|r| r != goop_core::ResolutionCap::Original)
            && !resolution_supported)
    {
        return Err(refused("The selected output or compression mode does not support these video quality or resolution settings. Clear unsupported video settings; GIF uses its own size controls."));
    }
    if let Some(options) = &req.image_options {
        crate::image_options::validate_options(options)?;
        if req.target != TargetFormat::Jpeg {
            return Err(GoopError::InvalidRequest(
                "Image settings require JPEG output.".into(),
            ));
        }
        if req.compress_mode.is_some() {
            return Err(GoopError::InvalidRequest(
                "Image settings cannot be combined with compression controls.".into(),
            ));
        }
        if req.gif_options.is_some() || req.subtitle.is_some() {
            return Err(GoopError::InvalidRequest(
                "Image settings cannot be combined with GIF or subtitle controls.".into(),
            ));
        }
        if probe
            .image_format
            .as_deref()
            .is_some_and(|format| format.eq_ignore_ascii_case("png"))
            && req.image_color_policy.unwrap_or_default() == ImageColorPolicy::Preserve
        {
            return Err(GoopError::InvalidRequest(
                "PNG JPEG settings require explicit color handling.".into(),
            ));
        }
    }
    if req.target == TargetFormat::Jpeg
        && probe.image_has_alpha == Some(true)
        && req.image_alpha_policy.is_none()
    {
        return Err(GoopError::InvalidRequest(
            "JPEG removes transparency; choose an explicit background before converting.".into(),
        ));
    }
    let caps = capabilities_for(probe);
    let target = caps
        .targets
        .iter()
        .find(|t| t.target == req.target)
        .ok_or_else(|| refused("This output format is incompatible with the source."))?;
    if !target.available {
        return Err(refused(target.reason.clone().unwrap_or_default()));
    }
    if let Some(options) = &req.image_options {
        let settings = target.image_settings.as_ref().ok_or_else(|| {
            GoopError::InvalidRequest("Image settings are unavailable for this output.".into())
        })?;
        if !settings.available {
            return Err(GoopError::InvalidRequest(
                settings
                    .reason
                    .clone()
                    .unwrap_or_else(|| "Image settings are unavailable for this source.".into()),
            ));
        }
        let source = probe.width.zip(probe.height).ok_or_else(|| {
            GoopError::InvalidRequest("Image settings require known source dimensions.".into())
        })?;
        crate::image_options::output_dimensions(source, &options.resize)?;
    }
    if let Some(mode) = req.compress_mode {
        let c = target
            .compression
            .clone()
            .unwrap_or_else(|| compression_for(req.target));
        let allowed = match mode {
            CompressMode::Quality(q) => c.quality && (1..=100).contains(&q),
            CompressMode::TargetSizeBytes(n) => c.target_size && n > 0,
            CompressMode::LosslessReoptimize => c.lossless,
        };
        if !allowed {
            return Err(refused(c.reason.unwrap_or_else(|| {
                "Unsupported compression mode or value.".into()
            })));
        }
    }
    Ok(())
}

pub async fn probe_source(
    resolver: &BinaryResolver,
    path: &Path,
) -> Result<ProbeResult, GoopError> {
    let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("");
    match backend_for_extension(ext) {
        BackendKind::Ffmpeg => FfmpegBackend::probe(resolver, path).await,
        BackendKind::ImageMagick => ImageMagickBackend::probe(resolver, path).await,
    }
}
pub async fn probe_capabilities(
    resolver: &BinaryResolver,
    path: &Path,
) -> Result<ConversionCapabilities, GoopError> {
    Ok(inspect_source(resolver, path).await?.capabilities)
}
pub async fn validate_request_source(
    resolver: &BinaryResolver,
    req: &ConvertRequest,
) -> Result<(), GoopError> {
    goop_core::validate_image_color_request_shape(req)?;
    goop_core::validate_image_alpha_request_shape(req)?;
    let path = goop_core::path::expand(&req.input_path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let backend = backend_for_extension(extension);
    if req.image_color_policy.unwrap_or_default() != ImageColorPolicy::Preserve
        && backend != BackendKind::ImageMagick
    {
        return Err(GoopError::InvalidRequest(
            "Explicit color handling requires a source routed to the image converter.".into(),
        ));
    }
    if req.video_options.is_some() {
        return Err(GoopError::InvalidRequest(
            "Explicit video admission requires an encoder inventory".into(),
        ));
    }
    if req.audio_options.is_some() {
        let encoders = crate::encoders::detect(resolver).await;
        resolve_audio_request_source(resolver, req, &encoders).await?;
        return Ok(());
    }
    if req.image_options.is_some() && backend != BackendKind::ImageMagick {
        return Err(GoopError::InvalidRequest(
            "Image settings require a source routed to the image converter.".into(),
        ));
    }
    let image_inspection = if backend == BackendKind::ImageMagick {
        Some(inspect_image_source_snapshot(&path).await?)
    } else {
        None
    };
    let probe = if let Some(inspection) = image_inspection.as_ref() {
        inspection.probe.clone()
    } else {
        probe_source(resolver, &path).await?
    };
    validate_request(req, &probe)?;
    if probe.source_kind == SourceKind::Image {
        let mut capabilities = capabilities_for(&probe);
        enrich_jpeg_metadata_capabilities(
            image_inspection
                .as_ref()
                .and_then(|inspection| inspection.jpeg_metadata.as_ref()),
            &mut capabilities,
        );
        enrich_image_color_capabilities(
            &image_inspection
                .as_ref()
                .expect("image inspection exists")
                .color,
            &probe,
            &mut capabilities,
        );
        enrich_image_alpha_capabilities(
            &image_inspection
                .as_ref()
                .expect("image inspection exists")
                .color,
            probe.image_has_alpha,
            &mut capabilities,
        );
        validate_metadata_policy(req, &capabilities)?;
        validate_color_policy(req, &capabilities)?;
        validate_alpha_policy(req, &capabilities)?;
    }
    Ok(())
}

/// Inspect once so dimensions and available operations describe the same source read.
pub async fn inspect_source(
    resolver: &BinaryResolver,
    path: &Path,
) -> Result<goop_core::ConversionInspection, GoopError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let backend = backend_for_extension(extension);
    let image_inspection = if backend == BackendKind::ImageMagick {
        Some(inspect_image_source_snapshot(path).await?)
    } else {
        None
    };
    let (probe, track_source, track_source_unavailable_reason) = if backend == BackendKind::Ffmpeg {
        crate::track_options::probe_bound_source_for_inspection(
            resolver,
            path,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await?
    } else {
        (
            image_inspection
                .as_ref()
                .ok_or_else(|| GoopError::InvalidRequest("Image inspection is unavailable".into()))?
                .probe
                .clone(),
            None,
            None,
        )
    };
    let track_source_unavailable_reason = track_source_unavailable_reason.map(str::to_owned);
    let mut capabilities = capabilities_for_bound_source(&probe, None, track_source.as_ref());
    enrich_jpeg_metadata_capabilities(
        image_inspection
            .as_ref()
            .and_then(|inspection| inspection.jpeg_metadata.as_ref()),
        &mut capabilities,
    );
    if let Some(inspection) = image_inspection.as_ref() {
        enrich_image_color_capabilities(&inspection.color, &inspection.probe, &mut capabilities);
        enrich_image_alpha_capabilities(
            &inspection.color,
            inspection.probe.image_has_alpha,
            &mut capabilities,
        );
        enrich_heic_preview_capabilities(inspection, &mut capabilities);
    }
    Ok(goop_core::ConversionInspection {
        probe,
        capabilities,
        track_source,
        track_source_unavailable_reason,
    })
}

/// Fresh admission for explicit video controls, shared by planning and enqueue.
pub async fn resolve_video_request_source(
    resolver: &BinaryResolver,
    req: &ConvertRequest,
    encoders: &crate::DetectedEncoders,
) -> Result<goop_core::VideoExecutionSummary, GoopError> {
    goop_core::validate_video_request(req)?;
    goop_core::validate_track_request(req)?;
    let path = goop_core::path::expand(&req.input_path);
    let extension = path.extension().and_then(|x| x.to_str()).unwrap_or("");
    if backend_for_extension(extension) != BackendKind::Ffmpeg {
        return Err(GoopError::InvalidRequest(
            "Explicit video settings require a source routed to the video converter".into(),
        ));
    }
    let cancel = tokio_util::sync::CancellationToken::new();
    if let Some(goop_core::TrackConvertOptions::Video { source, .. }) = req.track_options.as_ref() {
        let (probe, actual) =
            crate::track_options::probe_bound_source(resolver, &path, &cancel).await?;
        crate::track_options::verify_source_binding(source, actual.as_ref())?;
        Ok(crate::video_track_options::resolve(req, &probe, encoders)?.video_summary)
    } else {
        let probe = FfmpegBackend::probe_with_cancel(resolver, &path, &cancel).await?;
        Ok(crate::video_options::resolve(req, &probe, encoders)?.summary)
    }
}

/// Fresh admission for explicit audio controls, shared by planning and enqueue.
pub async fn resolve_audio_request_source(
    resolver: &BinaryResolver,
    req: &ConvertRequest,
    encoders: &crate::DetectedEncoders,
) -> Result<goop_core::AudioExecutionSummary, GoopError> {
    goop_core::validate_audio_request(req)?;
    goop_core::validate_track_request(req)?;
    let path = goop_core::path::expand(&req.input_path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if backend_for_extension(extension) != BackendKind::Ffmpeg {
        return Err(GoopError::InvalidRequest(
            "Explicit audio settings require a source routed to the media converter".into(),
        ));
    }
    let cancel = tokio_util::sync::CancellationToken::new();
    let probe = if let Some(goop_core::TrackConvertOptions::Audio { source, .. }) =
        req.track_options.as_ref()
    {
        let (probe, actual) =
            crate::track_options::probe_bound_source(resolver, &path, &cancel).await?;
        crate::track_options::verify_source_binding(source, actual.as_ref())?;
        crate::track_options::resolve(req, &probe)?;
        probe
    } else {
        FfmpegBackend::probe_with_cancel(resolver, &path, &cancel).await?
    };
    Ok(crate::audio_options::resolve(req, &probe, encoders)?.summary)
}

pub async fn validate_request_source_with_encoders(
    resolver: &BinaryResolver,
    req: &ConvertRequest,
    encoders: &crate::DetectedEncoders,
) -> Result<(), GoopError> {
    if req.image_color_policy.unwrap_or_default() != ImageColorPolicy::Preserve {
        validate_request_source(resolver, req).await
    } else if req.video_options.is_some() {
        resolve_video_request_source(resolver, req, encoders).await?;
        Ok(())
    } else if req.audio_options.is_some() {
        resolve_audio_request_source(resolver, req, encoders).await?;
        Ok(())
    } else {
        validate_request_source(resolver, req).await
    }
}
pub async fn inspect_source_with_encoders(
    resolver: &BinaryResolver,
    path: &Path,
    encoders: &crate::DetectedEncoders,
) -> Result<goop_core::ConversionInspection, GoopError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let backend = backend_for_extension(extension);
    let image_inspection = if backend == BackendKind::ImageMagick {
        Some(inspect_image_source_snapshot(path).await?)
    } else {
        None
    };
    let (probe, track_source, track_source_unavailable_reason) = if backend == BackendKind::Ffmpeg {
        crate::track_options::probe_bound_source_for_inspection(
            resolver,
            path,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await?
    } else {
        (
            image_inspection
                .as_ref()
                .ok_or_else(|| GoopError::InvalidRequest("Image inspection is unavailable".into()))?
                .probe
                .clone(),
            None,
            None,
        )
    };
    let track_source_unavailable_reason = track_source_unavailable_reason.map(str::to_owned);
    let mut capabilities =
        capabilities_for_bound_source(&probe, Some(encoders), track_source.as_ref());
    enrich_jpeg_metadata_capabilities(
        image_inspection
            .as_ref()
            .and_then(|inspection| inspection.jpeg_metadata.as_ref()),
        &mut capabilities,
    );
    if let Some(inspection) = image_inspection.as_ref() {
        enrich_image_color_capabilities(&inspection.color, &inspection.probe, &mut capabilities);
        enrich_image_alpha_capabilities(
            &inspection.color,
            inspection.probe.image_has_alpha,
            &mut capabilities,
        );
        enrich_heic_preview_capabilities(inspection, &mut capabilities);
    }
    Ok(goop_core::ConversionInspection {
        probe,
        capabilities,
        track_source,
        track_source_unavailable_reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{parse_probe_json, DetectedEncoders};
    use goop_core::TRACK_SOURCE_BINDING_VERSION;
    use serde_json::json;
    use std::io::{Seek, SeekFrom, Write};

    #[test]
    fn oversized_png_inspection_keeps_only_the_header_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oversized.png");
        image::RgbImage::new(16, 8).save(&path).unwrap();
        let mut file = File::options().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start(crate::color::MAX_INPUT_BYTES))
            .unwrap();
        file.write_all(&[0]).unwrap();
        drop(file);

        let snapshot = color_raster_snapshot(&path).unwrap().unwrap();
        assert!(matches!(
            snapshot,
            ColorRasterSnapshot::OversizedPng { file_size, .. }
                if file_size == crate::color::MAX_INPUT_BYTES + 1
        ));
    }

    #[test]
    fn oversized_png_probe_rejects_a_corrupt_ihdr() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.png");
        image::RgbImage::new(16, 8).save(&path).unwrap();
        let mut header = std::fs::read(path).unwrap()[..33].to_vec();
        header[32] ^= 0xff;

        assert!(
            oversized_png_probe(&header, crate::color::MAX_INPUT_BYTES + 1)
                .unwrap_err()
                .user_message()
                .contains("invalid PNG header")
        );
    }

    #[test]
    fn image_inspection_uses_one_snapshot_when_path_is_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.png");
        image::RgbImage::from_pixel(16, 8, image::Rgb([220, 20, 10]))
            .save(&path)
            .unwrap();

        let inspection = inspect_image_source_snapshot_blocking(&path, || {
            image::RgbImage::from_pixel(8, 16, image::Rgb([10, 20, 220]))
                .save(&path)
                .unwrap();
        })
        .unwrap();

        assert_eq!(
            (inspection.probe.width, inspection.probe.height),
            (Some(16), Some(8))
        );
        assert_eq!(inspection.color.unwrap().dimensions, (16, 8));
        assert_eq!(
            image::ImageReader::open(path)
                .unwrap()
                .into_dimensions()
                .unwrap(),
            (8, 16)
        );
    }

    #[cfg(feature = "heic-thumbnail-preview")]
    #[test]
    fn heic_preview_capability_rejects_a_replaced_source() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.heic");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/heic-with-thumbnail.heic"
            ),
            &path,
        )
        .unwrap();

        let error = inspect_image_source_snapshot_blocking(&path, || {
            std::fs::copy(
                concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sample.heic"),
                &path,
            )
            .unwrap();
        })
        .err()
        .expect("a replaced HEIC source must be rejected");

        assert_eq!(
            error.user_message(),
            "Source changed while inspecting HEIC preview capability"
        );
    }

    #[test]
    fn bound_video_track_capabilities_keep_explicit_modes_reachable() {
        let probe = parse_probe_json(
            &serde_json::to_vec(&json!({
                "format": {
                    "duration": "2.0",
                    "size": "4096",
                    "format_name": "matroska"
                },
                "streams": [
                    {
                        "index": 0,
                        "codec_type": "video",
                        "codec_name": "h264",
                        "width": 1920,
                        "height": 1080,
                        "pix_fmt": "yuv420p",
                        "field_order": "progressive",
                        "sample_aspect_ratio": "1:1",
                        "avg_frame_rate": "24/1",
                        "r_frame_rate": "24/1",
                        "time_base": "1/24000",
                        "start_time": "0",
                        "duration": "2",
                        "disposition": {"default": 1, "forced": 0, "attached_pic": 0}
                    },
                    {
                        "index": 1,
                        "codec_type": "audio",
                        "codec_name": "aac",
                        "start_time": "0",
                        "duration": "2",
                        "disposition": {"default": 1, "forced": 0, "attached_pic": 0}
                    },
                    {
                        "index": 2,
                        "codec_type": "audio",
                        "codec_name": "aac",
                        "start_time": "0",
                        "duration": "2",
                        "disposition": {"default": 0, "forced": 0, "attached_pic": 0}
                    },
                    {
                        "index": 3,
                        "codec_type": "subtitle",
                        "codec_name": "subrip",
                        "start_time": "0",
                        "duration": "2",
                        "disposition": {"default": 0, "forced": 0, "attached_pic": 0}
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        let source = TrackSourceBinding {
            version: TRACK_SOURCE_BINDING_VERSION,
            canonical_path: "/tmp/source.mkv".into(),
            size_bytes: "4096".into(),
            modified_unix_ns: "1700000000000000000".into(),
            inventory: probe.track_inventory.clone().unwrap(),
        };
        let encoders = DetectedEncoders::from_names(["libx264", "libx265", "aac"]);

        let capabilities = capabilities_for_bound_source(&probe, Some(&encoders), Some(&source));
        let mp4 = capabilities
            .targets
            .iter()
            .find(|candidate| candidate.target == TargetFormat::Mp4)
            .unwrap();
        assert!(mp4.video_track_settings.is_some());
        let video = mp4.video_settings.as_ref().unwrap();
        assert!(video.copy.available);
        assert!(video.encode.available);
    }

    #[tokio::test]
    async fn video_admission_rejects_audio_only_track_options_before_sidecar_work() {
        let source = TrackSourceBinding {
            version: TRACK_SOURCE_BINDING_VERSION,
            canonical_path: "/tmp/source.mp4".into(),
            size_bytes: "4096".into(),
            modified_unix_ns: "1700000000000000000".into(),
            inventory: serde_json::from_value(json!({
                "version": 1,
                "streams": [{
                    "index": 1,
                    "codec_type": "audio",
                    "codec_name": {"kind": "value", "value": "aac"},
                    "container_stream_id": {"kind": "missing"},
                    "language": {"kind": "missing"},
                    "title": {"kind": "missing"},
                    "disposition": {
                        "default": true,
                        "forced": false,
                        "attached_pic": false,
                        "other": {},
                        "malformed": false
                    }
                }]
            }))
            .unwrap(),
        };
        let request: ConvertRequest = serde_json::from_value(json!({
            "input_path": "/tmp/source.mp4",
            "output_path": "/tmp/output.mp4",
            "target": "mp4",
            "video_options": {"kind": "copy"},
            "track_options": {"kind": "audio", "source": source, "stream_index": 1}
        }))
        .unwrap();
        let resolver = BinaryResolver::new(std::env::temp_dir().join("missing-goop-sidecars"));

        let error = resolve_video_request_source(&resolver, &request, &DetectedEncoders::empty())
            .await
            .unwrap_err();

        assert!(
            error
                .user_message()
                .contains("Audio track selection requires MP3, M4A, AAC, WAV or FLAC output"),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn explicit_image_color_rejects_media_routing_before_sidecar_work() {
        let request: ConvertRequest = serde_json::from_value(json!({
            "input_path": "/tmp/source.mp4",
            "output_path": "/tmp/output.png",
            "target": "png",
            "image_color_policy": "assume_srgb"
        }))
        .unwrap();
        let resolver = BinaryResolver::new(std::env::temp_dir().join("missing-goop-sidecars"));

        let error = validate_request_source(&resolver, &request)
            .await
            .unwrap_err();

        assert!(
            error
                .user_message()
                .contains("source routed to the image converter"),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn rgba_png_inspection_exposes_source_bound_alpha_contract_and_requires_policy() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("source.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([20, 40, 80, 128]))
            .save(&input)
            .unwrap();
        let resolver = BinaryResolver::new(directory.path().to_owned());

        let inspection = inspect_source(&resolver, &input).await.unwrap();
        assert_eq!(inspection.probe.image_has_alpha, Some(true));
        let jpeg = inspection
            .capabilities
            .targets
            .iter()
            .find(|target| target.target == TargetFormat::Jpeg)
            .unwrap();
        let alpha = jpeg.image_alpha.as_ref().unwrap();
        assert_eq!(alpha.source_has_alpha, Some(true));
        assert!(alpha.flatten.available);
        assert_eq!(
            alpha.required_color_policy,
            Some(ImageColorPolicy::AssumeSrgb)
        );
        assert_eq!(
            alpha.suggested_background,
            SrgbColor {
                red: 255,
                green: 255,
                blue: 255
            }
        );

        let output = directory.path().join("output.jpg");
        let missing: ConvertRequest = serde_json::from_value(json!({
            "input_path": input,
            "output_path": output,
            "target": "jpeg"
        }))
        .unwrap();
        assert!(validate_request_source(&resolver, &missing)
            .await
            .unwrap_err()
            .user_message()
            .contains("background"));

        let explicit: ConvertRequest = serde_json::from_value(json!({
            "input_path": input,
            "output_path": output,
            "target": "jpeg",
            "image_color_policy": "assume_srgb",
            "image_alpha_policy": {
                "kind": "flatten",
                "background": {"red": 255, "green": 255, "blue": 255}
            }
        }))
        .unwrap();
        validate_request_source(&resolver, &explicit).await.unwrap();
    }

    #[tokio::test]
    async fn rgba_png_does_not_widen_color_management_for_png_output() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("source.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([20, 40, 80, 128]))
            .save(&input)
            .unwrap();
        let resolver = BinaryResolver::new(directory.path().to_owned());

        let inspection = inspect_source(&resolver, &input).await.unwrap();
        let png = inspection
            .capabilities
            .targets
            .iter()
            .find(|target| target.target == TargetFormat::Png)
            .unwrap();
        let color = png.image_color.as_ref().unwrap();
        assert!(!color.convert_to_srgb.available);
        assert!(!color.assume_srgb.available);

        let explicit: ConvertRequest = serde_json::from_value(json!({
            "input_path": input,
            "output_path": directory.path().join("output.png"),
            "target": "png",
            "image_color_policy": "assume_srgb"
        }))
        .unwrap();
        let error = validate_request_source(&resolver, &explicit)
            .await
            .unwrap_err();
        assert!(error.user_message().contains("not available"), "{error:?}");

        let jpeg = inspection
            .capabilities
            .targets
            .iter()
            .find(|target| target.target == TargetFormat::Jpeg)
            .unwrap();
        assert!(jpeg.image_color.as_ref().unwrap().assume_srgb.available);
    }

    #[tokio::test]
    async fn unsupported_png_layout_keeps_jpeg_settings_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("sixteen-bit.png");
        image::ImageBuffer::<image::Luma<u16>, Vec<u16>>::from_pixel(2, 2, image::Luma([32_768]))
            .save(&input)
            .unwrap();
        let resolver = BinaryResolver::new(directory.path().to_owned());

        let inspection = inspect_source(&resolver, &input).await.unwrap();
        let settings = inspection
            .capabilities
            .targets
            .iter()
            .find(|target| target.target == TargetFormat::Jpeg)
            .unwrap()
            .image_settings
            .as_ref()
            .unwrap();
        assert!(!settings.available);
        assert_eq!(settings.required_color_policy, None);
        assert!(settings
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("8-bit")));
        assert!(!settings.preview_original_available);

        let request: ConvertRequest = serde_json::from_value(json!({
            "input_path": input,
            "output_path": directory.path().join("output.jpg"),
            "target": "jpeg",
            "image_color_policy": "assume_srgb",
            "image_options": {
                "jpeg_quality": 75,
                "resize": {"kind": "original"}
            }
        }))
        .unwrap();
        let error = validate_request_source(&resolver, &request)
            .await
            .unwrap_err();
        assert!(error.user_message().contains("8-bit"), "{error:?}");
    }

    #[tokio::test]
    async fn transparent_webp_reports_alpha_but_keeps_flattening_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("source.webp");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([20, 40, 80, 128]))
            .save(&input)
            .unwrap();
        let resolver = BinaryResolver::new(directory.path().to_owned());

        let inspection = inspect_source(&resolver, &input).await.unwrap();
        assert_eq!(inspection.probe.image_has_alpha, Some(true));
        let alpha = inspection
            .capabilities
            .targets
            .iter()
            .find(|target| target.target == TargetFormat::Jpeg)
            .unwrap()
            .image_alpha
            .as_ref()
            .unwrap();
        assert_eq!(alpha.source_has_alpha, Some(true));
        assert!(!alpha.flatten.available);
        assert!(alpha.flatten.reason.is_some());
        assert_eq!(alpha.required_color_policy, None);
    }
}
