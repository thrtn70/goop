//! Engine-owned availability shared by the picker, queue admission and execution.
use crate::{
    backend_for_extension, BackendKind, ConversionBackend, FfmpegBackend, ImageMagickBackend,
};
use goop_core::{
    CompressMode, CompressionCapabilities, ConversionCapabilities, ConvertRequest, GoopError,
    ImageMetadataCapabilities, ImageOrientationStatus, ImageResize, ImageSettingsCapabilities,
    MetadataPolicy, MetadataPolicyAvailability, ProbeResult, SourceKind, TargetCapability,
    TargetFormat, TrackSourceBinding,
};
use goop_sidecar::BinaryResolver;
use std::path::Path;

pub fn compression_for(target: TargetFormat) -> CompressionCapabilities {
    use TargetFormat::*;
    let (quality, target_size, lossless, reason) = match target {
        Jpeg => (true, true, false, None),
        Png | Tiff | Webp => (false, false, true, Some("Only lossless reoptimization is supported. Convert to JPEG for quality or target-size compression.")),
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
                compression: Some(compression_for(target)),
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
    explicit_preserve_unavailable_reason: Option<String>,
}

async fn inspect_image_source_snapshot(path: &Path) -> Result<ImageSourceInspection, GoopError> {
    let inspection_path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let source =
            crate::jpeg_controls::prepare(&inspection_path, crate::jpeg_controls::MAX_INPUT_BYTES)?;
        let probe = crate::jpeg_controls::probe_prepared(&inspection_path, source.as_ref())?;
        let jpeg_metadata = source
            .as_ref()
            .map(|source| source.inspect_metadata(crate::metadata::JpegOutputColor::Rgb))
            .transpose()?;
        let explicit_preserve_unavailable_reason = source.as_ref().and_then(|source| {
            crate::metadata::prepare_jpeg_plan(
                source.bytes.clone(),
                MetadataPolicy::Preserve,
                crate::metadata::JpegOutputColor::Rgb,
            )
            .err()
            .map(|error| error.user_message())
        });
        Ok(ImageSourceInspection {
            probe,
            jpeg_metadata,
            explicit_preserve_unavailable_reason,
        })
    })
    .await
    .map_err(|error| GoopError::InvalidRequest(format!("Image inspection task failed: {error}")))?
}

fn validate_metadata_policy(
    req: &ConvertRequest,
    capabilities: &ConversionCapabilities,
) -> Result<(), GoopError> {
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
    let heic = format == "heic";
    let raw = format == "raw" || crate::raw::is_raw_extension(&format);
    let dimensions = probe.width.zip(probe.height);
    let dimension_error = dimensions
        .and_then(|source| {
            crate::image_options::output_dimensions(source, &ImageResize::Original).err()
        })
        .map(|error| error.user_message());

    let reason = if probe.source_kind != SourceKind::Image || !(jpeg || heic || raw) {
        Some("Explicit JPEG settings are available for JPEG, HEIC and RAW sources.".into())
    } else if raw && !cfg!(target_os = "macos") {
        Some("RAW rendering requires macOS.".into())
    } else if probe.image_has_alpha == Some(true) {
        Some("JPEG settings are unavailable for images with transparency.".into())
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
        let c = compression_for(req.target);
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
    let path = goop_core::path::expand(&req.input_path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let backend = backend_for_extension(extension);
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
        if req.image_options.is_some()
            && req.metadata_policy.unwrap_or_default() == MetadataPolicy::Preserve
        {
            if let Some(reason) = image_inspection
                .as_ref()
                .and_then(|inspection| inspection.explicit_preserve_unavailable_reason.as_ref())
            {
                return Err(GoopError::InvalidRequest(reason.clone()));
            }
        }
        validate_metadata_policy(req, &capabilities)?;
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
    if req.video_options.is_some() {
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
}
