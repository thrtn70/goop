//! Engine-owned availability shared by the picker, queue admission and execution.
use crate::{
    backend_for_extension, BackendKind, ConversionBackend, FfmpegBackend, ImageMagickBackend,
};
use goop_core::{
    CompressMode, CompressionCapabilities, ConversionCapabilities, ConvertRequest, GoopError,
    ProbeResult, SourceKind, TargetCapability, TargetFormat,
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
            TargetCapability {
                compression: Some(compression_for(target)),
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

fn refused(reason: impl Into<String>) -> GoopError {
    GoopError::SubprocessFailed {
        binary: "converter".into(),
        stderr: reason.into(),
    }
}

/// The probe must be obtained from the engine's source read, never from client input.
pub fn validate_request(req: &ConvertRequest, probe: &ProbeResult) -> Result<(), GoopError> {
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
    let caps = capabilities_for(probe);
    let target = caps
        .targets
        .iter()
        .find(|t| t.target == req.target)
        .ok_or_else(|| refused("This output format is incompatible with the source."))?;
    if !target.available {
        return Err(refused(target.reason.clone().unwrap_or_default()));
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
    Ok(capabilities_for(&probe_source(resolver, path).await?))
}
pub async fn validate_request_source(
    resolver: &BinaryResolver,
    req: &ConvertRequest,
) -> Result<(), GoopError> {
    validate_request(
        req,
        &probe_source(resolver, &goop_core::path::expand(&req.input_path)).await?,
    )
}

/// Inspect once so dimensions and available operations describe the same source read.
pub async fn inspect_source(
    resolver: &BinaryResolver,
    path: &Path,
) -> Result<goop_core::ConversionInspection, GoopError> {
    let probe = probe_source(resolver, path).await?;
    let capabilities = capabilities_for(&probe);
    Ok(goop_core::ConversionInspection {
        probe,
        capabilities,
    })
}
