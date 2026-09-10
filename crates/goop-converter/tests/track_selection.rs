use goop_converter::{
    audio_options::{resolve as resolve_audio, validate_output_against_source},
    encoders::DetectedEncoders,
    parse_probe_json,
    track_options::{
        resolve as resolve_tracks, settings as track_settings, validate_output_against_selection,
    },
};
use goop_core::{
    AudioConvertOptions, TargetFormat, TrackConvertOptions, TrackSourceBinding,
    TRACK_SOURCE_BINDING_VERSION,
};
use serde_json::{json, Value};

fn multi_track_probe() -> goop_core::ProbeResult {
    parse_probe_json(
        &serde_json::to_vec(&json!({
            "format": {"duration": "2.0", "size": "4096", "format_name": "matroska"},
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "h264",
                    "id": "0x1",
                    "width": 16,
                    "height": 16,
                    "tags": {"title": "Picture"},
                    "disposition": {"default": 1, "forced": 0, "attached_pic": 0, "still_image": 0}
                },
                {
                    "index": 2,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "id": "0x2",
                    "sample_rate": "48000",
                    "channels": 2,
                    "channel_layout": "stereo",
                    "sample_fmt": "fltp",
                    "time_base": "1/48000",
                    "duration": "2.0",
                    "tags": {"language": "eng", "title": "Main"},
                    "disposition": {"default": 1, "forced": 0, "attached_pic": 0, "hearing_impaired": 0}
                },
                {
                    "index": 5,
                    "codec_type": "audio",
                    "codec_name": "mp3",
                    "sample_rate": "44100",
                    "channels": 1,
                    "channel_layout": "mono",
                    "sample_fmt": "fltp",
                    "time_base": "1/44100",
                    "duration": "2.0",
                    "tags": {"language": "eng", "title": "Commentary"},
                    "disposition": {"default": 0, "forced": 1, "attached_pic": 0, "hearing_impaired": 1}
                },
                {
                    "index": 7,
                    "codec_type": "subtitle",
                    "codec_name": "subrip",
                    "tags": {"language": "und"},
                    "disposition": {"default": 0, "forced": 0, "attached_pic": 0}
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap()
}

fn binding(probe: &goop_core::ProbeResult) -> TrackSourceBinding {
    TrackSourceBinding {
        version: TRACK_SOURCE_BINDING_VERSION,
        canonical_path: "/tmp/source.mkv".into(),
        size_bytes: "4096".into(),
        modified_unix_ns: "1700000000000000000".into(),
        inventory: probe.track_inventory.clone().expect("track inventory"),
    }
}

fn request(
    probe: &goop_core::ProbeResult,
    target: TargetFormat,
    stream_index: u32,
    audio_options: Value,
) -> goop_core::ConvertRequest {
    serde_json::from_value(json!({
        "input_path": "/tmp/source.mkv",
        "output_path": "/tmp/output",
        "target": serde_json::to_value(target).unwrap(),
        "audio_options": audio_options,
        "track_options": {
            "kind": "audio",
            "source": binding(probe),
            "stream_index": stream_index
        }
    }))
    .unwrap()
}

fn encoders() -> DetectedEncoders {
    DetectedEncoders::from_names(["libmp3lame", "aac", "pcm_s16le", "flac"])
}

#[test]
fn probe_builds_a_complete_canonical_track_inventory() {
    let probe = multi_track_probe();
    let source = binding(&probe);
    assert_eq!(
        goop_converter::track_options::source_unavailable_reason(&probe, Some(&source)),
        None
    );
    let inventory = probe.track_inventory.expect("complete inventory");
    assert_eq!(inventory.version, 1);
    assert_eq!(
        inventory
            .streams
            .iter()
            .map(|stream| stream.index)
            .collect::<Vec<_>>(),
        [0, 2, 5, 7]
    );

    let main = &inventory.streams[1];
    assert_eq!(main.codec_type, "audio");
    assert_eq!(
        serde_json::to_value(&main.codec_name).unwrap(),
        json!({"kind": "value", "value": "aac"})
    );
    assert_eq!(
        serde_json::to_value(&main.container_stream_id).unwrap(),
        json!({"kind": "value", "value": "0x2"})
    );
    assert_eq!(
        serde_json::to_value(&main.language).unwrap(),
        json!({"kind": "value", "value": "eng"})
    );
    assert_eq!(main.disposition.default, Some(true));
    assert_eq!(main.disposition.forced, Some(false));
    assert_eq!(main.disposition.other.get("hearing_impaired"), Some(&false));

    let subtitle = &inventory.streams[3];
    assert_eq!(
        serde_json::to_value(&subtitle.language).unwrap(),
        json!({"kind": "value", "value": "und"})
    );
    assert!(!subtitle.disposition.malformed);
    assert_eq!(subtitle.disposition.default, Some(false));
}

#[test]
fn malformed_identity_is_retained_for_diagnostics_but_disables_selection() {
    let probe = parse_probe_json(
        &serde_json::to_vec(&json!({
            "streams": [{
                "index": 1,
                "codec_type": "audio",
                "codec_name": "aac",
                "sample_rate": "48000",
                "channels": 2,
                "tags": {"language": 7},
                "disposition": {"default": "bad"}
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let identity = &probe.track_inventory.as_ref().unwrap().streams[0];
    assert!(matches!(
        identity.language,
        goop_core::TrackTextFact::Malformed
    ));
    assert!(identity.disposition.malformed);
    assert!(
        goop_converter::track_options::source_unavailable_reason(&probe, None)
            .unwrap()
            .contains("malformed stream identity")
    );
}

#[test]
fn malformed_or_oversized_inventory_disables_selection_without_breaking_legacy_probe() {
    for streams in [
        json!([
            {"index": 1, "codec_type": "audio", "codec_name": "aac"},
            {"index": 1, "codec_type": "audio", "codec_name": "aac"}
        ]),
        json!([
            {"index": 2, "codec_type": "audio", "codec_name": "aac"},
            {"index": 1, "codec_type": "audio", "codec_name": "aac"}
        ]),
        json!([
            {"index": 1, "codec_type": "audio", "codec_name": "aac", "tags": {"title": "x".repeat(513)}}
        ]),
        json!([
            {"codec_type": "audio", "codec_name": "aac"}
        ]),
    ] {
        let probe = parse_probe_json(
            &serde_json::to_vec(&json!({
                "format": {"duration": "1", "size": "1"},
                "streams": streams
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(probe.has_audio);
        assert!(probe.track_inventory.is_none());
        assert!(
            goop_converter::track_options::source_unavailable_reason(&probe, None)
                .unwrap()
                .contains("complete bounded stream inventory")
        );
    }
}

#[test]
fn exact_second_track_drives_map_processing_and_omission_summary() {
    let probe = multi_track_probe();
    let request = request(&probe, TargetFormat::Mp3, 5, json!({"kind": "copy"}));
    let selected = resolve_tracks(&request, &probe).unwrap().unwrap();
    let audio = resolve_audio(&request, &probe, &encoders()).unwrap();

    assert_eq!(
        audio.plan.args,
        ["-map", "0:5", "-vn", "-sn", "-dn", "-c:a", "copy"]
    );
    assert!(audio.summary.copied);
    assert_eq!(audio.summary.audio_stream_index, 5);
    assert_eq!(selected.selected.index, 5);
    assert_eq!(
        selected
            .dropped_audio
            .iter()
            .map(|stream| stream.index)
            .collect::<Vec<_>>(),
        [2]
    );
    assert_eq!(
        selected
            .dropped_other
            .iter()
            .map(|stream| stream.index)
            .collect::<Vec<_>>(),
        [0, 7]
    );
    assert_eq!(selected.output_stream_index, 0);
    assert!(selected
        .notices
        .iter()
        .any(|notice| notice.contains("1 additional audio")));
    assert!(selected
        .notices
        .iter()
        .any(|notice| notice.contains("2 non-audio")));
}

#[test]
fn stale_or_incompatible_selection_fails_without_fallback() {
    let probe = multi_track_probe();
    let wrong_codec = request(&probe, TargetFormat::Mp3, 2, json!({"kind": "copy"}));
    assert!(resolve_audio(&wrong_codec, &probe, &encoders()).is_err());

    let selected = request(&probe, TargetFormat::Mp3, 5, json!({"kind": "copy"}));
    let mut changed = probe.clone();
    let inventory = changed.track_inventory.as_mut().unwrap();
    inventory.streams[2].title = goop_core::TrackTextFact::Value {
        value: "Replacement".into(),
    };
    assert!(resolve_tracks(&selected, &changed)
        .unwrap_err()
        .user_message()
        .contains("reinspect"));
    assert!(resolve_audio(&selected, &changed, &encoders()).is_err());
}

#[test]
fn per_track_capabilities_follow_each_selected_codec() {
    let probe = multi_track_probe();
    let source = binding(&probe);
    let settings = track_settings(&probe, TargetFormat::Mp3, &encoders(), &source).unwrap();
    assert_eq!(settings.audio_choices.len(), 2);

    let aac = settings
        .audio_choices
        .iter()
        .find(|choice| choice.track.index == 2)
        .unwrap();
    assert!(!aac.copy.available);
    assert!(!(aac.copy.reason.as_deref().unwrap_or("").is_empty()));
    assert!(aac.encode.available);

    let mp3 = settings
        .audio_choices
        .iter()
        .find(|choice| choice.track.index == 5)
        .unwrap();
    assert!(mp3.copy.available);
    assert!(mp3.encode.available);

    for choice in &settings.audio_choices {
        let copy = request(
            &probe,
            TargetFormat::Mp3,
            choice.track.index,
            json!({"kind": "copy"}),
        );
        let encode = request(
            &probe,
            TargetFormat::Mp3,
            choice.track.index,
            json!({
                "kind": "encode",
                "bitrate": {"kind": "target", "kbps": 192},
                "channels": {"kind": "preserve"},
                "sample_rate": {"kind": "preserve"}
            }),
        );
        assert_eq!(
            choice.copy.available,
            resolve_audio(&copy, &probe, &encoders()).is_ok()
        );
        assert_eq!(
            choice.encode.available,
            resolve_audio(&encode, &probe, &encoders()).is_ok()
        );
    }
}

#[test]
fn maximum_inventory_preserves_one_capability_result_per_audio_stream() {
    let streams = (0..goop_core::MAX_TRACK_STREAMS)
        .map(|index| {
            json!({
                "index": index,
                "codec_type": "audio",
                "codec_name": if index % 2 == 0 { "aac" } else { "flac" },
                "sample_rate": "48000",
                "channels": 2,
                "channel_layout": "stereo",
                "sample_fmt": "fltp",
                "time_base": "1/48000",
                "duration": "2.0",
                "tags": {"title": format!("Track {index}")},
                "disposition": {"default": index == 0, "forced": false, "attached_pic": false}
            })
        })
        .collect::<Vec<_>>();
    let probe = parse_probe_json(
        &serde_json::to_vec(&json!({
            "format": {"duration": "2.0", "size": "4096", "format_name": "matroska"},
            "streams": streams
        }))
        .unwrap(),
    )
    .unwrap();
    let source = binding(&probe);
    let settings = track_settings(&probe, TargetFormat::M4a, &encoders(), &source).unwrap();

    assert_eq!(settings.audio_choices.len(), goop_core::MAX_TRACK_STREAMS);
    for (index, choice) in settings.audio_choices.iter().enumerate() {
        assert_eq!(choice.track.index, index as u32);
        assert_eq!(choice.copy.available, index % 2 == 0);
        assert!(choice.encode.available);
    }
}

#[test]
fn selected_output_validation_uses_the_requested_source_index_and_requires_output_zero() {
    let probe = multi_track_probe();
    let request = request(&probe, TargetFormat::Mp3, 5, json!({"kind": "copy"}));
    let selected = resolve_tracks(&request, &probe).unwrap().unwrap();
    let expected = resolve_audio(&request, &probe, &encoders())
        .unwrap()
        .summary;
    let actual = parse_probe_json(
        &serde_json::to_vec(&json!({
            "format": {"duration": "2.0", "size": "2048"},
            "streams": [{
                "index": 0,
                "codec_type": "audio",
                "codec_name": "mp3",
                "sample_rate": "44100",
                "channels": 1,
                "channel_layout": "mono",
                "sample_fmt": "fltp",
                "time_base": "1/44100",
                "duration": "2.0"
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(validate_output_against_source(&expected, &probe, &actual).is_ok());
    assert!(validate_output_against_selection(&selected, &actual).is_ok());

    let mut wrong_index = actual;
    wrong_index.audio_details.as_mut().unwrap().streams[0].index = 1;
    assert!(validate_output_against_source(&expected, &probe, &wrong_index).is_ok());
    assert!(validate_output_against_selection(&selected, &wrong_index).is_err());
}

#[test]
fn absent_and_null_track_options_preserve_the_existing_single_track_plan() {
    let single = parse_probe_json(
        &serde_json::to_vec(&json!({
            "format": {"duration": "2.0", "size": "2048"},
            "streams": [{
                "index": 3,
                "codec_type": "audio",
                "codec_name": "mp3",
                "sample_rate": "44100",
                "channels": 1,
                "channel_layout": "mono",
                "sample_fmt": "fltp",
                "time_base": "1/44100",
                "duration": "2.0"
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let absent: goop_core::ConvertRequest = serde_json::from_value(json!({
        "input_path": "in.wav",
        "output_path": "out.mp3",
        "target": "mp3",
        "audio_options": {"kind": "copy"}
    }))
    .unwrap();
    let null: goop_core::ConvertRequest = serde_json::from_value(json!({
        "input_path": "in.wav",
        "output_path": "out.mp3",
        "target": "mp3",
        "audio_options": {"kind": "copy"},
        "track_options": null
    }))
    .unwrap();
    let absent = resolve_audio(&absent, &single, &encoders()).unwrap();
    let null = resolve_audio(&null, &single, &encoders()).unwrap();
    assert_eq!(absent.plan, null.plan);
    assert_eq!(absent.summary, null.summary);
    assert_eq!(
        absent.plan.args,
        ["-map", "0:3", "-vn", "-sn", "-dn", "-c:a", "copy"]
    );
    assert!(resolve_tracks(
        &serde_json::from_value::<goop_core::ConvertRequest>(json!({
            "input_path": "in.wav", "output_path": "out.mp3", "target": "mp3"
        }))
        .unwrap(),
        &single
    )
    .unwrap()
    .is_none());
}

#[test]
fn selected_request_keeps_processing_and_selection_as_separate_contracts() {
    let probe = multi_track_probe();
    let request = request(
        &probe,
        TargetFormat::Flac,
        2,
        json!({
            "kind": "encode",
            "bitrate": null,
            "channels": {"kind": "stereo"},
            "sample_rate": {"kind": "exact", "hz": 48000}
        }),
    );
    assert!(matches!(
        request.audio_options,
        Some(AudioConvertOptions::Encode { .. })
    ));
    assert!(matches!(
        request.track_options,
        Some(TrackConvertOptions::Audio {
            stream_index: 2,
            ..
        })
    ));
}
