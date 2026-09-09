mod common;

use goop_converter::{
    backend::ConversionBackend, capabilities::inspect_source_with_encoders,
    encoders::DetectedEncoders, FfmpegBackend,
};
use goop_core::{
    AudioChannels, AudioConvertOptions, AudioSampleRate, JobId, TargetFormat, TrackConvertOptions,
};
use serde::Deserialize;
use std::{collections::BTreeMap, fs::OpenOptions, io::Write, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Deserialize)]
struct ProbedStreams {
    streams: Vec<ProbedStream>,
}

#[derive(Debug, Deserialize)]
struct ProbedStream {
    index: u32,
    codec_type: String,
    codec_name: Option<String>,
    #[serde(default)]
    tags: BTreeMap<String, String>,
    #[serde(default)]
    disposition: BTreeMap<String, i64>,
}

fn encoders() -> Arc<DetectedEncoders> {
    Arc::new(DetectedEncoders::from_names([
        "aac",
        "flac",
        "libmp3lame",
        "pcm_s16le",
    ]))
}

fn selected_request(
    source: &Path,
    output: &Path,
    target: TargetFormat,
    binding: goop_core::TrackSourceBinding,
    stream_index: u32,
    audio_options: AudioConvertOptions,
) -> goop_core::ConvertRequest {
    let mut request = common::request(source, output, target, None);
    request.audio_options = Some(audio_options);
    request.track_options = Some(TrackConvertOptions::Audio {
        source: binding,
        stream_index,
    });
    request
}

fn assert_selected_tone(samples: &[f32], selected_hz: f64, rejected_hz: f64) {
    let selected = common::tone_magnitude(samples, 48_000.0, selected_hz);
    let rejected = common::tone_magnitude(samples, 48_000.0, rejected_hz);
    assert!(
        selected > 0.03,
        "selected {selected_hz} Hz magnitude was {selected}"
    );
    assert!(
        selected > rejected * 8.0,
        "selected {selected_hz} Hz magnitude {selected} did not dominate {rejected_hz} Hz magnitude {rejected}"
    );
}

fn append_mutation(path: &Path) {
    OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(b"source-mutated")
        .unwrap();
}

#[tokio::test]
#[ignore = "requires bundled ffmpeg and ffprobe sidecars"]
async fn bundled_ffmpeg_selects_exact_multitrack_tones_and_preserves_diagnostics() {
    let temp = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(temp.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let source = temp.path().join("diagnostic-tracks.mkv");
    common::make_diagnostic_track_source(&ffmpeg, &source);

    let independent: ProbedStreams =
        serde_json::from_value(common::probe_streams_json(&resolver, &source)).unwrap();
    assert_eq!(independent.streams.len(), 4);
    assert_eq!(
        independent
            .streams
            .iter()
            .map(|stream| stream.index)
            .collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
    let audio = independent
        .streams
        .iter()
        .filter(|stream| stream.codec_type == "audio")
        .collect::<Vec<_>>();
    assert_eq!(
        audio
            .iter()
            .map(|stream| stream.codec_name.as_deref())
            .collect::<Vec<_>>(),
        [Some("aac"), Some("aac"), Some("aac")]
    );
    assert_eq!(
        audio[0].tags.get("language").map(String::as_str),
        Some("eng")
    );
    assert_eq!(
        audio[1].tags.get("language").map(String::as_str),
        Some("eng")
    );
    assert_eq!(audio[2].tags.get("language"), None);
    assert_eq!(audio[0].tags.get("title").map(String::as_str), Some("Main"));
    assert_eq!(
        audio[1].tags.get("title").map(String::as_str),
        Some("Commentary")
    );
    assert_eq!(
        audio[2].tags.get("title").map(String::as_str),
        Some("No language")
    );
    assert_eq!(audio[0].disposition.get("default"), Some(&1));
    assert_eq!(audio[0].disposition.get("forced"), Some(&0));
    assert_eq!(audio[1].disposition.get("default"), Some(&0));
    assert_eq!(audio[1].disposition.get("forced"), Some(&1));
    assert_eq!(audio[2].disposition.get("default"), Some(&0));
    assert_eq!(audio[2].disposition.get("forced"), Some(&0));

    let detected = encoders();
    let inspection = inspect_source_with_encoders(&resolver, &source, &detected)
        .await
        .unwrap();
    let binding = inspection.track_source.expect("track source binding");
    assert_eq!(binding.inventory.streams.len(), 4);
    for index in [1, 2] {
        assert_eq!(
            binding.inventory.streams[index].language,
            goop_core::TrackTextFact::Value {
                value: "eng".into()
            }
        );
    }
    assert!(matches!(
        binding.inventory.streams[3].language,
        goop_core::TrackTextFact::Missing
    ));
    assert_eq!(
        binding.inventory.streams[1].title,
        goop_core::TrackTextFact::Value {
            value: "Main".into()
        }
    );
    assert_eq!(
        binding.inventory.streams[2].title,
        goop_core::TrackTextFact::Value {
            value: "Commentary".into()
        }
    );
    assert_eq!(
        binding.inventory.streams[3].title,
        goop_core::TrackTextFact::Value {
            value: "No language".into()
        }
    );
    assert_eq!(
        (
            binding.inventory.streams[1].disposition.default,
            binding.inventory.streams[1].disposition.forced,
            binding.inventory.streams[2].disposition.default,
            binding.inventory.streams[2].disposition.forced,
            binding.inventory.streams[3].disposition.default,
            binding.inventory.streams[3].disposition.forced,
        ),
        (
            Some(true),
            Some(false),
            Some(false),
            Some(true),
            Some(false),
            Some(false)
        )
    );

    let backend =
        FfmpegBackend::new(&resolver, Arc::new(common::SilentSink)).with_encoders(detected, false);
    for (stream_index, selected_hz, rejected_hz, target, options, extension, codec) in [
        (
            1,
            440.0,
            880.0,
            TargetFormat::M4a,
            AudioConvertOptions::Copy,
            "m4a",
            "aac",
        ),
        (
            2,
            880.0,
            440.0,
            TargetFormat::Flac,
            AudioConvertOptions::Encode {
                bitrate: None,
                channels: AudioChannels::Preserve,
                sample_rate: AudioSampleRate::Preserve,
            },
            "flac",
            "flac",
        ),
    ] {
        let output = temp
            .path()
            .join(format!("selected-{stream_index}.{extension}"));
        let request = selected_request(
            &source,
            &output,
            target,
            binding.clone(),
            stream_index,
            options,
        );
        let converted = backend
            .convert(JobId::new(), &request, CancellationToken::new())
            .await
            .unwrap();
        let summary = converted.track_execution.expect("track execution summary");
        assert_eq!(summary.selected.index, stream_index);
        assert_eq!(summary.output_stream_index, 0);
        assert_eq!(summary.dropped_audio.len(), 2);
        assert_eq!(summary.dropped_other.len(), 1);

        let output_probe: ProbedStreams =
            serde_json::from_value(common::probe_streams_json(&resolver, &output)).unwrap();
        assert_eq!(output_probe.streams.len(), 1);
        assert_eq!(output_probe.streams[0].index, 0);
        assert_eq!(output_probe.streams[0].codec_type, "audio");
        assert_eq!(output_probe.streams[0].codec_name.as_deref(), Some(codec));
        let samples = common::decoded_audio_f32(&resolver, &output, 48_000);
        assert_selected_tone(&samples, selected_hz, rejected_hz);
    }
}

#[tokio::test]
#[ignore = "requires bundled ffmpeg and ffprobe sidecars"]
async fn bundled_ffmpeg_exposes_mixed_copy_compatibility_without_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(temp.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let source = temp.path().join("mixed-copy.mkv");
    common::make_mixed_copy_track_source(&ffmpeg, &source);
    let independent: ProbedStreams =
        serde_json::from_value(common::probe_streams_json(&resolver, &source)).unwrap();
    assert_eq!(independent.streams.len(), 2);
    assert_eq!(
        independent
            .streams
            .iter()
            .map(|stream| (stream.index, stream.codec_name.as_deref()))
            .collect::<Vec<_>>(),
        [(0, Some("aac")), (1, Some("flac"))]
    );
    let detected = encoders();
    let inspection = inspect_source_with_encoders(&resolver, &source, &detected)
        .await
        .unwrap();
    let binding = inspection.track_source.expect("track source binding");
    let target = inspection
        .capabilities
        .targets
        .iter()
        .find(|target| target.target == TargetFormat::M4a)
        .unwrap();
    let choices = &target
        .track_settings
        .as_ref()
        .expect("track settings")
        .audio_choices;
    assert_eq!(choices.len(), 2);
    assert_eq!(choices[0].track.index, 0);
    assert_eq!(choices[1].track.index, 1);
    assert!(choices[0].copy.available);
    assert!(!choices[1].copy.available);
    assert!(choices[1].copy.reason.is_some());
    assert!(choices.iter().all(|choice| choice.encode.available));

    let backend =
        FfmpegBackend::new(&resolver, Arc::new(common::SilentSink)).with_encoders(detected, false);
    let refused_output = temp.path().join("must-not-fallback.m4a");
    let refused = selected_request(
        &source,
        &refused_output,
        TargetFormat::M4a,
        binding.clone(),
        1,
        AudioConvertOptions::Copy,
    );
    assert!(backend
        .convert(JobId::new(), &refused, CancellationToken::new())
        .await
        .is_err());
    assert!(!refused_output.exists());

    let encoded_output = temp.path().join("encoded-selection.m4a");
    let encoded = selected_request(
        &source,
        &encoded_output,
        TargetFormat::M4a,
        binding,
        1,
        AudioConvertOptions::Encode {
            bitrate: Some(goop_core::AudioBitrate::Target { kbps: 192 }),
            channels: AudioChannels::Preserve,
            sample_rate: AudioSampleRate::Preserve,
        },
    );
    let converted = backend
        .convert(JobId::new(), &encoded, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(converted.track_execution.unwrap().selected.index, 1);
    let output_probe: ProbedStreams =
        serde_json::from_value(common::probe_streams_json(&resolver, &encoded_output)).unwrap();
    assert_eq!(output_probe.streams.len(), 1);
    assert_eq!(output_probe.streams[0].index, 0);
    assert_eq!(output_probe.streams[0].codec_type, "audio");
    assert_eq!(output_probe.streams[0].codec_name.as_deref(), Some("aac"));
    assert_selected_tone(
        &common::decoded_audio_f32(&resolver, &encoded_output, 48_000),
        880.0,
        440.0,
    );
}

#[cfg(debug_assertions)]
#[tokio::test]
#[ignore = "requires bundled ffmpeg and ffprobe sidecars"]
async fn selected_multitrack_source_mutation_before_execution_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(temp.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let source = temp.path().join("before-run.mkv");
    let replacement = temp.path().join("replacement.mkv");
    common::make_diagnostic_track_source(&ffmpeg, &source);
    common::make_mixed_copy_track_source(&ffmpeg, &replacement);
    let detected = encoders();
    let binding = inspect_source_with_encoders(&resolver, &source, &detected)
        .await
        .unwrap()
        .track_source
        .unwrap();
    let output = temp.path().join("must-not-run.m4a");
    let request = selected_request(
        &source,
        &output,
        TargetFormat::M4a,
        binding,
        3,
        AudioConvertOptions::Copy,
    );
    let changed = source.clone();
    let replacement_source = replacement.clone();
    let backend = FfmpegBackend::new(&resolver, Arc::new(common::SilentSink))
        .with_encoders(detected, false)
        .with_before_run_test_hook(Arc::new(move || {
            std::fs::copy(&replacement_source, &changed).unwrap();
        }));

    let error = backend
        .convert(JobId::new(), &request, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.user_message().contains("reinspect"));
    assert!(!output.exists());
}

#[cfg(debug_assertions)]
#[tokio::test]
#[ignore = "requires bundled ffmpeg and ffprobe sidecars"]
async fn selected_multitrack_source_mutation_before_publication_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(temp.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let source = temp.path().join("before-publish.mkv");
    common::make_diagnostic_track_source(&ffmpeg, &source);
    let detected = encoders();
    let binding = inspect_source_with_encoders(&resolver, &source, &detected)
        .await
        .unwrap()
        .track_source
        .unwrap();
    let output = temp.path().join("must-not-publish.flac");
    let request = selected_request(
        &source,
        &output,
        TargetFormat::Flac,
        binding,
        2,
        AudioConvertOptions::Encode {
            bitrate: None,
            channels: AudioChannels::Preserve,
            sample_rate: AudioSampleRate::Preserve,
        },
    );
    let changed = source.clone();
    let backend = FfmpegBackend::new(&resolver, Arc::new(common::SilentSink))
        .with_encoders(detected, false)
        .with_before_publish_test_hook(Arc::new(move || append_mutation(&changed)));

    let error = backend
        .convert(JobId::new(), &request, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.user_message().contains("reinspect"));
    assert!(!output.exists());
}
