use goop_core::{CompressMode, GoopError, Preset, QualityPreset, ResolutionCap, TargetFormat};
use std::path::Path;
use std::sync::Mutex;

// All command mutations and first-use seeding share one synchronous boundary.
static MUTATIONS: Mutex<()> = Mutex::new(());

/// Load presets from the given JSON file. Returns an empty vec if the file
/// is missing — callers typically follow up with `seed_if_missing` to write
/// the built-in defaults.
pub fn load(path: &Path) -> Result<Vec<Preset>, GoopError> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let s = std::fs::read_to_string(path)?;
    serde_json::from_str(&s).map_err(|e| GoopError::Config(e.to_string()))
}

/// Atomic save via tempfile + rename so a crash mid-write can't leave a
/// half-written presets file behind.
pub fn save(path: &Path, presets: &[Preset]) -> Result<(), GoopError> {
    let _guard = MUTATIONS
        .lock()
        .map_err(|_| GoopError::Config("Preset storage lock is unavailable".into()))?;
    save_unlocked(path, presets)
}

fn save_unlocked(path: &Path, presets: &[Preset]) -> Result<(), GoopError> {
    for preset in presets {
        validate(preset)?;
    }
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(presets)?;
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Source-dependent applicability is checked when applying a preset. Reject only
/// combinations that cannot represent a single conversion intent here.
pub fn validate(preset: &Preset) -> Result<(), GoopError> {
    if preset.image_options.is_some() && preset.compress_mode.is_some() {
        return Err(GoopError::Config(format!(
            "Preset \"{}\": compression and image settings cannot be combined",
            preset.name
        )));
    }
    let request = goop_core::ConvertRequest {
        audio_options: preset.audio_options.clone(),
        track_options: None,
        input_path: String::new(),
        output_path: String::new(),
        target: preset.target,
        quality_preset: preset.quality_preset,
        resolution_cap: preset.resolution_cap,
        gif_options: preset.gif_options.clone(),
        compress_mode: preset.compress_mode,
        batch_id: None,
        metadata_policy: preset.metadata_policy,
        image_color_policy: preset.image_color_policy,
        subtitle: preset.subtitle.clone(),
        image_options: preset.image_options.clone(),
        video_options: preset.video_options.clone(),
    };
    goop_core::validate_audio_request(&request)
        .and_then(|()| goop_core::validate_video_request(&request))
        .and_then(|()| goop_core::validate_image_color_request_shape(&request))
        .map_err(|error| GoopError::Config(format!("Preset \"{}\": {error}", preset.name)))
        .and_then(|()| match preset.track_policy.as_ref() {
            None => Ok(()),
            Some(goop_core::TrackPresetPolicy::Audio { .. }) => {
                if preset.audio_options.is_none() {
                    return Err(GoopError::Config(format!(
                        "Preset \"{}\": audio track selection requires Copy audio or Custom encode",
                        preset.name
                    )));
                }
                if !matches!(
                    preset.target,
                    TargetFormat::Mp3
                        | TargetFormat::M4a
                        | TargetFormat::Aac
                        | TargetFormat::Wav
                        | TargetFormat::Flac
                ) {
                    return Err(GoopError::Config(format!(
                        "Preset \"{}\": audio track selection requires MP3, M4A, AAC, WAV or FLAC output",
                        preset.name
                    )));
                }
                Ok(())
            }
            Some(goop_core::TrackPresetPolicy::Video { .. }) => {
                if preset.video_options.is_none() {
                    return Err(GoopError::Config(format!(
                        "Preset \"{}\": video track policies require explicit Copy or Custom video settings",
                        preset.name
                    )));
                }
                if preset.audio_options.is_some() {
                    return Err(GoopError::Config(format!(
                        "Preset \"{}\": video track policies cannot be combined with audio-only processing",
                        preset.name
                    )));
                }
                if !matches!(
                    preset.target,
                    TargetFormat::Mp4 | TargetFormat::Mov | TargetFormat::Mkv
                ) {
                    return Err(GoopError::Config(format!(
                        "Preset \"{}\": video track policies require MP4, MOV or MKV output",
                        preset.name
                    )));
                }
                Ok(())
            }
        })
}

/// Validate the whole incoming bundle and merged records before publishing once.
pub fn import(path: &Path, incoming: Vec<Preset>) -> Result<Vec<Preset>, GoopError> {
    for preset in &incoming {
        validate(preset)?;
    }
    mutate(path, |mut current| {
        for preset in &incoming {
            current = upsert(current, preset.clone());
        }
        current
    })?;
    Ok(incoming)
}

pub fn save_one(path: &Path, preset: Preset) -> Result<Preset, GoopError> {
    validate(&preset)?;
    mutate(path, |current| upsert(current, preset.clone()))?;
    Ok(preset)
}

pub fn delete(path: &Path, id: &str) -> Result<(), GoopError> {
    mutate(path, |current| remove(current, id)).map(|_| ())
}

fn mutate(
    path: &Path,
    edit: impl FnOnce(Vec<Preset>) -> Vec<Preset>,
) -> Result<Vec<Preset>, GoopError> {
    let _guard = MUTATIONS
        .lock()
        .map_err(|_| GoopError::Config("Preset storage lock is unavailable".into()))?;
    let current = if path.exists() {
        load(path)?
    } else {
        builtin_defaults()
    };
    let next = edit(current);
    save_unlocked(path, &next)?;
    Ok(next)
}

/// Upsert a preset by id. Replaces an existing entry in place (preserving
/// position) or appends a new one.
pub fn upsert(presets: Vec<Preset>, preset: Preset) -> Vec<Preset> {
    let mut out = presets;
    if let Some(idx) = out.iter().position(|p| p.id == preset.id) {
        out[idx] = preset;
    } else {
        out.push(preset);
    }
    out
}

/// Remove a preset by id. No-op if the id is absent.
pub fn remove(presets: Vec<Preset>, id: &str) -> Vec<Preset> {
    presets.into_iter().filter(|p| p.id != id).collect()
}

/// The 4 built-in presets seeded on first launch when `presets.json` is absent.
/// Covers the most common creator workflows (YouTube, Twitter/X, podcast, web
/// image). Users can rename them but not delete them.
pub fn builtin_defaults() -> Vec<Preset> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    vec![
        Preset {
            audio_options: None,
            video_options: None,
            track_policy: None,
            id: "builtin-youtube-upload".into(),
            name: "YouTube Upload".into(),
            target: TargetFormat::Mp4,
            quality_preset: Some(QualityPreset::Balanced),
            resolution_cap: Some(ResolutionCap::R1080p),
            compress_mode: None,
            metadata_policy: None,
            image_color_policy: None,
            gif_options: None,
            subtitle: None,
            image_options: None,
            is_builtin: true,
            created_at: now,
        },
        Preset {
            audio_options: None,
            video_options: None,
            track_policy: None,
            id: "builtin-twitter-video".into(),
            name: "Twitter/X Video".into(),
            target: TargetFormat::Mp4,
            quality_preset: Some(QualityPreset::Balanced),
            resolution_cap: Some(ResolutionCap::R720p),
            compress_mode: Some(CompressMode::TargetSizeBytes(200_000_000)),
            metadata_policy: None,
            image_color_policy: None,
            gif_options: None,
            subtitle: None,
            image_options: None,
            is_builtin: true,
            created_at: now,
        },
        Preset {
            audio_options: None,
            video_options: None,
            track_policy: None,
            id: "builtin-podcast-mp3".into(),
            name: "Podcast MP3".into(),
            target: TargetFormat::Mp3,
            quality_preset: None,
            resolution_cap: None,
            compress_mode: Some(CompressMode::Quality(75)),
            metadata_policy: None,
            image_color_policy: None,
            gif_options: None,
            subtitle: None,
            image_options: None,
            is_builtin: true,
            created_at: now,
        },
        Preset {
            audio_options: None,
            video_options: None,
            track_policy: None,
            id: "builtin-web-image".into(),
            name: "Web Image".into(),
            target: TargetFormat::Webp,
            quality_preset: None,
            resolution_cap: None,
            compress_mode: Some(CompressMode::LosslessReoptimize),
            metadata_policy: None,
            image_color_policy: None,
            gif_options: None,
            subtitle: None,
            image_options: None,
            is_builtin: true,
            created_at: now,
        },
    ]
}

/// Read presets from `path`. If the file is missing, write the built-in
/// defaults to it and return them. This is the command layer's entry point
/// so `preset_list` seeds on first use.
pub fn load_or_seed(path: &Path) -> Result<Vec<Preset>, GoopError> {
    let _guard = MUTATIONS
        .lock()
        .map_err(|_| GoopError::Config("Preset storage lock is unavailable".into()))?;
    if path.exists() {
        return load(path);
    }
    let seed = builtin_defaults();
    save_unlocked(path, &seed)?;
    Ok(seed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample(id: &str, name: &str) -> Preset {
        Preset {
            audio_options: None,
            video_options: None,
            track_policy: None,
            id: id.into(),
            name: name.into(),
            target: TargetFormat::Mp4,
            quality_preset: Some(QualityPreset::Balanced),
            resolution_cap: None,
            compress_mode: None,
            metadata_policy: None,
            image_color_policy: None,
            gif_options: None,
            subtitle: None,
            image_options: None,
            is_builtin: false,
            created_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn portable_track_policy_roundtrips_without_source_identity() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets.json");
        let mut preset = sample("track", "Choose audio per file");
        preset.target = TargetFormat::Mp3;
        preset.quality_preset = None;
        preset.audio_options = Some(goop_core::AudioConvertOptions::Copy);
        preset.track_policy = Some(goop_core::TrackPresetPolicy::Audio {
            selection: goop_core::TrackPresetSelection::ChoosePerFile,
        });

        save(&path, std::slice::from_ref(&preset)).unwrap();
        assert_eq!(load(&path).unwrap(), vec![preset]);
        let stored = std::fs::read_to_string(path).unwrap();
        assert!(stored.contains("choose_per_file"));
        assert!(!stored.contains("canonical_path"));
        assert!(!stored.contains("stream_index"));
        assert!(!stored.contains("inventory"));
    }

    #[test]
    fn track_policy_requires_explicit_audio_processing_and_audio_target() {
        let mut preset = sample("track", "Choose audio per file");
        preset.track_policy = Some(goop_core::TrackPresetPolicy::Audio {
            selection: goop_core::TrackPresetSelection::ChoosePerFile,
        });
        assert!(validate(&preset).is_err());
        preset.target = TargetFormat::Mp3;
        preset.quality_preset = None;
        assert!(validate(&preset).is_err());
        preset.audio_options = Some(goop_core::AudioConvertOptions::Copy);
        assert!(validate(&preset).is_ok());
    }

    #[test]
    fn explicit_color_presets_reject_intrinsically_impossible_combinations() {
        let mut preset = sample("color", "Color managed");
        preset.image_color_policy = Some(goop_core::ImageColorPolicy::ConvertToSrgb);
        assert!(validate(&preset).is_err());

        preset.target = TargetFormat::Png;
        preset.quality_preset = Some(QualityPreset::Original);
        assert!(validate(&preset).is_ok());

        preset.compress_mode = Some(CompressMode::Quality(75));
        assert!(validate(&preset).is_err());
        preset.compress_mode = None;
        preset.image_options = Some(goop_core::ImageConvertOptions {
            jpeg_quality: 75,
            resize: goop_core::ImageResize::Original,
        });
        assert!(validate(&preset).is_err());
    }

    #[test]
    fn portable_video_track_policies_roundtrip_without_source_identity() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets.json");
        let mut preset = sample("video-tracks", "Keep video tracks");
        preset.quality_preset = None;
        preset.video_options = Some(goop_core::VideoConvertOptions::Copy);
        preset.track_policy = Some(goop_core::TrackPresetPolicy::Video {
            audio: goop_core::TrackPresetStreamPolicy::KeepAll,
            subtitles: goop_core::TrackPresetStreamPolicy::ChoosePerFile,
        });

        save(&path, std::slice::from_ref(&preset)).unwrap();
        assert_eq!(load(&path).unwrap(), vec![preset]);
        let stored = std::fs::read_to_string(path).unwrap();
        assert!(stored.contains("keep_all"));
        assert!(stored.contains("choose_per_file"));
        assert!(!stored.contains("canonical_path"));
        assert!(!stored.contains("stream_index"));
        assert!(!stored.contains("inventory"));
    }

    #[test]
    fn video_track_policy_requires_supported_explicit_video_intent() {
        let mut preset = sample("video-tracks", "Video tracks");
        preset.track_policy = Some(goop_core::TrackPresetPolicy::Video {
            audio: goop_core::TrackPresetStreamPolicy::None,
            subtitles: goop_core::TrackPresetStreamPolicy::KeepAll,
        });
        assert!(validate(&preset).is_err());

        preset.quality_preset = None;
        preset.video_options = Some(goop_core::VideoConvertOptions::Copy);
        assert!(validate(&preset).is_ok());

        preset.target = TargetFormat::Webm;
        assert!(validate(&preset).is_err());
        preset.target = TargetFormat::Mp4;
        preset.audio_options = Some(goop_core::AudioConvertOptions::Copy);
        assert!(validate(&preset).is_err());
        preset.audio_options = None;
        preset.subtitle = Some(goop_core::SubtitleOptions {
            source_path: "sub.srt".into(),
            mode: goop_core::SubtitleMode::Soft,
        });
        assert!(validate(&preset).is_err());
    }

    #[test]
    fn video_presets_roundtrip_and_reject_structural_conflicts() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets.json");
        let mut preset = sample("video", "Custom video");
        preset.quality_preset = None;
        preset.video_options = Some(goop_core::VideoConvertOptions::Encode {
            codec: goop_core::VideoCodec::Hevc,
            processor: goop_core::VideoProcessor::Software,
            speed: goop_core::VideoSpeed::Slow,
            rate_control: goop_core::VideoRateControl::AverageBitrate { kbps: 5000 },
            resize: Some(goop_core::VideoResize::FitWithin {
                width: 1_920,
                height: 1_080,
            }),
            frame_rate: Some(goop_core::VideoFrameRate::Constant {
                numerator: 30_000,
                denominator: 1_001,
            }),
        });
        import(&path, vec![preset.clone()]).unwrap();
        assert_eq!(load(&path).unwrap().last().unwrap(), &preset);
        let before = std::fs::read(&path).unwrap();
        preset.target = TargetFormat::Webm;
        let error = save_one(&path, preset.clone()).unwrap_err().to_string();
        assert!(error.contains("Custom video") && error.contains("MP4"));
        preset.target = TargetFormat::Mp4;
        preset.video_options = Some(goop_core::VideoConvertOptions::Copy);
        preset.resolution_cap = Some(ResolutionCap::R720p);
        assert!(save_one(&path, preset).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn audio_presets_roundtrip_and_reject_structural_conflicts() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets.json");
        let mut preset = sample("audio", "Podcast audio");
        preset.target = TargetFormat::Mp3;
        preset.quality_preset = None;
        preset.audio_options = Some(goop_core::AudioConvertOptions::Encode {
            bitrate: Some(goop_core::AudioBitrate::Target { kbps: 192 }),
            channels: goop_core::AudioChannels::Stereo,
            sample_rate: goop_core::AudioSampleRate::Exact { hz: 48_000 },
        });

        save(&path, std::slice::from_ref(&preset)).unwrap();
        assert_eq!(load(&path).unwrap(), vec![preset.clone()]);

        let before = std::fs::read(&path).unwrap();
        preset.target = TargetFormat::Mp4;
        let error = save_one(&path, preset).unwrap_err().to_string();
        assert!(error.contains("Podcast audio") && error.contains("Explicit audio"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn legacy_presets_load_without_audio_options() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets.json");
        std::fs::write(
            &path,
            r#"[{"id":"old","name":"Old","target":"mp3","quality_preset":null,"resolution_cap":null,"compress_mode":null,"is_builtin":false,"created_at":0}]"#,
        )
        .unwrap();

        let preset = &load(&path).unwrap()[0];
        assert_eq!(preset.audio_options, None);
        assert_eq!(preset.track_policy, None);
    }

    #[test]
    fn bulk_import_validates_every_record_before_one_write() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets.json");
        save(&path, &[sample("old", "Keep")]).unwrap();
        let before = std::fs::read(&path).unwrap();
        let mut invalid = sample("bad", "Invalid second");
        invalid.video_options = Some(goop_core::VideoConvertOptions::Copy);
        assert!(import(&path, vec![sample("first", "First"), invalid]).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::create_dir(path.with_extension("json.tmp")).unwrap();
        assert!(import(&path, vec![sample("first", "First")]).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    #[test]
    fn concurrent_import_save_delete_and_seed_retain_mutations() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets.json");
        std::thread::scope(|scope| {
            for index in 0..12 {
                let path = &path;
                scope.spawn(move || {
                    if index % 2 == 0 {
                        save_one(path, sample(&index.to_string(), "Saved")).unwrap();
                    } else {
                        import(path, vec![sample(&index.to_string(), "Imported")]).unwrap();
                    }
                });
            }
            let path = &path;
            scope.spawn(move || {
                delete(path, "absent").unwrap();
            });
            scope.spawn(move || {
                load_or_seed(path).unwrap();
            });
        });
        assert_eq!(load(&path).unwrap().len(), 16);
    }

    #[test]
    fn presets_image_settings_roundtrip_and_legacy_fixture() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets.json");
        let mut preset = sample("jpeg", "Portrait");
        preset.target = TargetFormat::Jpeg;
        preset.quality_preset = None;
        preset.image_options = Some(goop_core::ImageConvertOptions {
            jpeg_quality: 90,
            resize: goop_core::ImageResize::FitWithin {
                width: 2048,
                height: 2048,
            },
        });
        save(&path, std::slice::from_ref(&preset)).unwrap();
        assert_eq!(load(&path).unwrap(), vec![preset]);
        std::fs::write(&path, r#"[{"id":"old","name":"Old","target":"jpeg","quality_preset":null,"resolution_cap":null,"compress_mode":null,"is_builtin":false,"created_at":0}]"#).unwrap();
        assert_eq!(load(&path).unwrap()[0].image_options, None);
    }

    #[test]
    fn presets_reject_mixed_compression_and_image_settings_before_writing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets.json");
        save(&path, &[sample("old", "Keep")]).unwrap();
        let before = std::fs::read(&path).unwrap();
        let mut preset = sample("jpeg", "Portrait");
        preset.image_options = Some(goop_core::ImageConvertOptions {
            jpeg_quality: 90,
            resize: goop_core::ImageResize::Original,
        });
        preset.compress_mode = Some(CompressMode::Quality(75));
        let error = save(&path, &[preset]).unwrap_err().to_string();
        assert!(error.contains("Portrait"), "{error}");
        assert!(error.contains("compression"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn load_returns_empty_when_missing() {
        let d = tempdir().unwrap();
        let presets = load(&d.path().join("missing.json")).unwrap();
        assert!(presets.is_empty());
    }

    #[test]
    fn save_then_load_roundtrip() {
        let d = tempdir().unwrap();
        let p = d.path().join("presets.json");
        let presets = vec![sample("a", "A"), sample("b", "B")];
        save(&p, &presets).unwrap();
        let loaded = load(&p).unwrap();
        assert_eq!(loaded, presets);
    }

    #[test]
    fn upsert_replaces_by_id() {
        let mut presets = vec![sample("a", "First"), sample("b", "B")];
        let updated = sample("a", "First Renamed");
        presets = upsert(presets, updated);
        assert_eq!(presets.len(), 2);
        assert_eq!(presets[0].name, "First Renamed");
    }

    #[test]
    fn upsert_appends_when_new() {
        let presets = vec![sample("a", "A")];
        let after = upsert(presets, sample("b", "B"));
        assert_eq!(after.len(), 2);
        assert_eq!(after[1].id, "b");
    }

    #[test]
    fn remove_drops_matching_id() {
        let presets = vec![sample("a", "A"), sample("b", "B")];
        let after = remove(presets, "a");
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, "b");
    }

    #[test]
    fn remove_missing_id_is_noop() {
        let presets = vec![sample("a", "A")];
        let after = remove(presets.clone(), "zzz");
        assert_eq!(after, presets);
    }

    #[test]
    fn load_or_seed_writes_builtins_on_first_call() {
        let d = tempdir().unwrap();
        let p = d.path().join("presets.json");
        let seeded = load_or_seed(&p).unwrap();
        assert!(p.exists());
        assert_eq!(seeded.len(), 4);
        assert!(seeded.iter().all(|pr| pr.is_builtin));
        // Second call returns the same entries without re-seeding.
        let again = load_or_seed(&p).unwrap();
        assert_eq!(again, seeded);
    }

    #[test]
    fn fresh_web_image_preset_uses_supported_lossless_mode() {
        let dir = tempdir().unwrap();
        let seeded = load_or_seed(&dir.path().join("presets.json")).unwrap();
        let web_image = seeded
            .iter()
            .find(|preset| preset.id == "builtin-web-image")
            .unwrap();
        assert_eq!(web_image.target, TargetFormat::Webp);
        assert_eq!(
            web_image.compress_mode,
            Some(CompressMode::LosslessReoptimize)
        );
    }

    #[test]
    fn loading_saved_legacy_webp_mode_does_not_rewrite_user_data() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets.json");
        let mut legacy = sample("builtin-web-image", "My existing Web Image");
        legacy.target = TargetFormat::Webp;
        legacy.compress_mode = Some(CompressMode::Quality(85));
        legacy.is_builtin = true;
        save(&path, std::slice::from_ref(&legacy)).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert_eq!(load_or_seed(&path).unwrap(), vec![legacy]);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn builtin_defaults_have_unique_ids() {
        let defaults = builtin_defaults();
        let mut ids: Vec<&str> = defaults.iter().map(|p| p.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), defaults.len());
    }
}
