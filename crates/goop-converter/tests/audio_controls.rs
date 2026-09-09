use goop_converter::{
    audio_options::{capabilities, resolve, validate_output_against_source},
    encoders::DetectedEncoders,
    parse_probe_json,
};
use goop_core::*;
use serde_json::json;

fn probe(codec: &str, rate: serde_json::Value, channels: serde_json::Value) -> ProbeResult {
    parse_probe_json(
        &serde_json::to_vec(&json!({
            "format":{"duration":"2.0","size":"4096"},
            "streams":[
                {"index":0,"codec_type":"video","codec_name":"h264","width":16,"height":16,"disposition":{"attached_pic":0}},
                {"index":3,"codec_type":"audio","codec_name":codec,"sample_rate":rate,"channels":channels,"channel_layout":"stereo","sample_fmt":"fltp","bits_per_raw_sample":"0","time_base":"1/48000","start_time":"0.0","duration":"2.0","disposition":{"attached_pic":0}}
            ]
        }))
        .unwrap(),
    )
    .unwrap()
}

fn output_probe(codec: &str, rate: u32, channels: u32) -> ProbeResult {
    parse_probe_json(
        &serde_json::to_vec(&json!({
            "format":{"duration":"2.0","size":"2048"},
            "streams":[{"index":0,"codec_type":"audio","codec_name":codec,
                "sample_rate":rate,"channels":channels,
                "channel_layout":if channels == 1 { "mono" } else { "stereo" },
                "sample_fmt":"s16","bits_per_sample":16,"bit_rate":"256000",
                "time_base":format!("1/{rate}"),"duration":"2.0"}]
        }))
        .unwrap(),
    )
    .unwrap()
}

fn request(target: &str, options: serde_json::Value) -> ConvertRequest {
    serde_json::from_value(json!({
        "input_path":"in.mkv","output_path":"out","target":target,"audio_options":options
    }))
    .unwrap()
}

fn encoders() -> DetectedEncoders {
    DetectedEncoders::from_names(["libmp3lame", "aac", "pcm_s16le", "flac"])
}

#[test]
fn probe_carries_exact_audio_source_facts_and_non_audio_presence() {
    let source = probe("aac", json!(48000), json!(2));
    let details = source.audio_details.unwrap();
    assert!(details.has_non_audio_streams);
    assert_eq!(details.streams.len(), 1);
    let stream = &details.streams[0];
    assert_eq!(stream.index, 3);
    assert_eq!(stream.codec_name.as_deref(), Some("aac"));
    assert_eq!(
        stream.sample_rate_hz,
        Some(AudioNumericFact::Exact { value: 48_000 })
    );
    assert_eq!(stream.channels, Some(AudioNumericFact::Exact { value: 2 }));
    assert_eq!(stream.channel_layout.as_deref(), Some("stereo"));
    assert_eq!(stream.sample_format.as_deref(), Some("fltp"));
}

#[test]
fn explicit_plans_are_deterministic_and_custom_never_copies() {
    let source = probe("mp3", json!(48000), json!(2));
    let copy = resolve(
        &request("mp3", json!({"kind":"copy"})),
        &source,
        &encoders(),
    )
    .unwrap();
    assert_eq!(
        copy.plan.args,
        ["-map", "0:3", "-vn", "-sn", "-dn", "-c:a", "copy"]
    );
    assert!(!copy.plan.reencoded);
    assert!(copy.summary.copied);

    let custom = resolve(
        &request(
            "mp3",
            json!({
                "kind":"encode",
                "bitrate":{"kind":"target","kbps":320},
                "channels":{"kind":"mono"},
                "sample_rate":{"kind":"exact","hz":44100}
            }),
        ),
        &source,
        &encoders(),
    )
    .unwrap();
    assert_eq!(
        custom.plan.args,
        [
            "-map",
            "0:3",
            "-vn",
            "-sn",
            "-dn",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "320k",
            "-af",
            "pan=mono|c0=0.5*c0+0.5*c1",
            "-ar",
            "44100"
        ]
    );
    assert!(custom.plan.reencoded);
    assert!(!custom.summary.copied);
}

#[test]
fn explicit_admission_refuses_multiple_streams_unknown_channels_and_missing_encoder() {
    let mut multiple = probe("aac", json!(48000), json!(2));
    let second = multiple.audio_details.as_ref().unwrap().streams[0].clone();
    multiple
        .audio_details
        .as_mut()
        .unwrap()
        .streams
        .push(second);
    multiple.audio_codecs.push("aac".into());
    let req = request("m4a", json!({"kind":"copy"}));
    assert!(resolve(&req, &multiple, &encoders())
        .unwrap_err()
        .user_message()
        .contains("audio-track selection"));

    let unknown_channels = probe("aac", json!(48000), serde_json::Value::Null);
    let custom = request(
        "m4a",
        json!({
            "kind":"encode","bitrate":{"kind":"target","kbps":192},
            "channels":{"kind":"stereo"},"sample_rate":{"kind":"exact","hz":48000}
        }),
    );
    assert!(resolve(&custom, &unknown_channels, &encoders()).is_err());
    assert!(resolve(
        &custom,
        &probe("aac", json!(48000), json!(2)),
        &DetectedEncoders::empty()
    )
    .unwrap_err()
    .user_message()
    .contains("aac"));
}

#[test]
fn capabilities_expose_copy_and_custom_reasons_from_fresh_facts() {
    let source = probe("aac", json!(44100), json!(1));
    let settings = capabilities(&source, TargetFormat::M4a, &encoders());
    assert!(settings.copy.available);
    assert!(settings.encode.available);
    assert_eq!(settings.bitrate_choices_kbps, [64, 96, 128, 160, 192, 256]);
    assert_eq!(settings.default_bitrate_kbps, Some(192));
    assert_eq!(settings.default_channels, Some(AudioChannels::Preserve));
    assert_eq!(
        settings.default_sample_rate,
        Some(AudioSampleRate::Preserve)
    );
}

#[test]
fn completion_validation_rejects_wrong_facts_and_records_measured_facts() {
    let source = probe("aac", json!(48000), json!(2));
    let request = request(
        "wav",
        json!({
            "kind":"encode","bitrate":null,"channels":{"kind":"mono"},
            "sample_rate":{"kind":"exact","hz":44100}
        }),
    );
    let expected = resolve(&request, &source, &encoders()).unwrap().summary;
    let actual = output_probe("pcm_s16le", 44_100, 1);
    let completed = validate_output_against_source(&expected, &source, &actual).unwrap();
    assert_eq!(completed.sample_format.as_deref(), Some("s16"));
    assert_eq!(completed.bit_depth, Some(16));
    assert_eq!(completed.reported_bitrate_kbps, Some(256));

    let mut unrelated_container_durations = source.clone();
    unrelated_container_durations.duration_ms = 9_000;
    let mut output_with_other_container_duration = actual.clone();
    output_with_other_container_duration.duration_ms = 8_000;
    assert!(validate_output_against_source(
        &expected,
        &unrelated_container_durations,
        &output_with_other_container_duration,
    )
    .is_ok());

    assert!(validate_output_against_source(
        &expected,
        &source,
        &output_probe("pcm_s16le", 48_000, 1),
    )
    .is_err());
    assert!(validate_output_against_source(
        &expected,
        &source,
        &probe("pcm_s16le", json!(44100), json!(1)),
    )
    .is_err());

    let mut missing_output_duration = output_probe("pcm_s16le", 44_100, 1);
    missing_output_duration
        .audio_details
        .as_mut()
        .unwrap()
        .streams[0]
        .duration_ms = None;
    assert!(
        validate_output_against_source(&expected, &source, &missing_output_duration)
            .unwrap_err()
            .user_message()
            .contains("output has no verified stream duration")
    );

    let mut missing_source_duration = source.clone();
    missing_source_duration
        .audio_details
        .as_mut()
        .unwrap()
        .streams[0]
        .duration_ms = None;
    assert!(
        validate_output_against_source(&expected, &missing_source_duration, &actual)
            .unwrap_err()
            .user_message()
            .contains("source audio has no verified stream duration")
    );

    let mut missing_output_time_base = actual.clone();
    missing_output_time_base
        .audio_details
        .as_mut()
        .unwrap()
        .streams[0]
        .time_base = None;
    assert!(
        validate_output_against_source(&expected, &source, &missing_output_time_base)
            .unwrap_err()
            .user_message()
            .contains("output has no verified stream time base")
    );

    let mut missing_source_time_base = source.clone();
    missing_source_time_base
        .audio_details
        .as_mut()
        .unwrap()
        .streams[0]
        .time_base = None;
    assert!(
        validate_output_against_source(&expected, &missing_source_time_base, &actual)
            .unwrap_err()
            .user_message()
            .contains("source audio has no verified stream time base")
    );
}

#[test]
fn preserve_rate_is_strict_but_an_explicit_common_rate_accepts_other_sources() {
    let source = probe("aac", json!(96000), json!(2));
    let preserve = request(
        "m4a",
        json!({
            "kind":"encode","bitrate":{"kind":"target","kbps":192},
            "channels":{"kind":"preserve"},"sample_rate":{"kind":"preserve"}
        }),
    );
    assert!(resolve(&preserve, &source, &encoders()).is_err());
    let exact = request(
        "m4a",
        json!({
            "kind":"encode","bitrate":{"kind":"target","kbps":192},
            "channels":{"kind":"preserve"},"sample_rate":{"kind":"exact","hz":48000}
        }),
    );
    assert!(resolve(&exact, &source, &encoders()).is_ok());

    let multichannel = probe("flac", json!(96000), json!(6));
    let copied = resolve(
        &request("flac", json!({"kind":"copy"})),
        &multichannel,
        &encoders(),
    )
    .unwrap();
    assert_eq!(copied.summary.sample_rate_hz, 96_000);
    assert_eq!(copied.summary.channels, 6);
}

#[test]
fn automatic_audio_plans_remain_byte_for_byte_unchanged() {
    use goop_converter::compat::decide;
    let cases = [
        (
            TargetFormat::Mp3,
            Some("aac"),
            vec!["-vn", "-c:a", "libmp3lame", "-q:a", "2"],
        ),
        (
            TargetFormat::M4a,
            Some("mp3"),
            vec!["-vn", "-c:a", "aac", "-b:a", "192k"],
        ),
        (
            TargetFormat::Aac,
            Some("mp3"),
            vec!["-vn", "-c:a", "aac", "-b:a", "192k"],
        ),
        (
            TargetFormat::Opus,
            Some("aac"),
            vec!["-vn", "-c:a", "libopus", "-b:a", "128k"],
        ),
        (
            TargetFormat::Ogg,
            Some("aac"),
            vec!["-vn", "-c:a", "libvorbis", "-q:a", "5"],
        ),
        (
            TargetFormat::ExtractAudioKeepCodec,
            Some("aac"),
            vec!["-vn", "-c:a", "copy"],
        ),
        (
            TargetFormat::Wav,
            Some("aac"),
            vec!["-vn", "-c:a", "pcm_s16le"],
        ),
        (TargetFormat::Flac, Some("aac"), vec!["-vn", "-c:a", "flac"]),
    ];
    for (target, codec, expected) in cases {
        assert_eq!(
            decide(target, None, codec, None, None, None).args,
            expected,
            "{target:?}"
        );
    }
}
