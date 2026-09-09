mod common;

use goop_converter::{
    backend::ConversionBackend, capabilities::inspect_source_with_encoders,
    encoders::DetectedEncoders, FfmpegBackend,
};
use goop_core::{
    AudioBitrate, AudioChannels, AudioConvertOptions, AudioSampleRate, JobId, TargetFormat,
    TrackConvertOptions,
};
use std::{path::Path, process::Command, sync::Arc};
use tokio_util::sync::CancellationToken;

fn copied_audio_payload(ffmpeg: &Path, path: &Path) -> Vec<u8> {
    let output = Command::new(ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-map", "0:a:0", "-c", "copy", "-f", "data", "pipe:1"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "failed to demux copied audio packets"
    );
    assert!(!output.stdout.is_empty(), "copied audio payload was empty");
    output.stdout
}

fn make_audio_source(ffmpeg: &Path, out: &Path, expression: &str) {
    let status = Command::new(ffmpeg)
        .args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            expression,
            "-c:a",
            "pcm_s16le",
        ])
        .arg(out)
        .status()
        .unwrap();
    assert!(status.success(), "failed to create semantic audio fixture");
}

fn decoded_f32(ffmpeg: &Path, path: &Path) -> Vec<f32> {
    let output = Command::new(ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(path)
        .args([
            "-map",
            "0:a:0",
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "failed to decode semantic audio output"
    );
    assert_eq!(output.stdout.len() % 4, 0);
    output
        .stdout
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect()
}

fn tone_magnitude(samples: &[f32], sample_rate_hz: f64, frequency_hz: f64) -> f64 {
    let (sine, cosine) =
        samples
            .iter()
            .enumerate()
            .fold((0.0, 0.0), |(sine, cosine), (index, sample)| {
                let phase = std::f64::consts::TAU * frequency_hz * index as f64 / sample_rate_hz;
                let sample = f64::from(*sample);
                (sine + sample * phase.sin(), cosine + sample * phase.cos())
            });
    sine.hypot(cosine) / samples.len() as f64
}

async fn selected_copy_request(
    resolver: &goop_sidecar::BinaryResolver,
    encoders: &DetectedEncoders,
    source: &Path,
    output: &Path,
) -> goop_core::ConvertRequest {
    let inspection = inspect_source_with_encoders(resolver, source, encoders)
        .await
        .unwrap();
    assert!(inspection.track_source_unavailable_reason.is_none());
    let binding = inspection.track_source.expect("source binding");
    let stream_index = binding
        .inventory
        .streams
        .iter()
        .find(|stream| stream.codec_type == "audio")
        .expect("audio track")
        .index;
    let mut request = common::request(source, output, TargetFormat::M4a, None);
    request.audio_options = Some(AudioConvertOptions::Copy);
    request.track_options = Some(TrackConvertOptions::Audio {
        source: binding,
        stream_index,
    });
    request
}

#[tokio::test]
#[ignore = "requires bundled ffmpeg and ffprobe sidecars"]
async fn explicit_copy_and_custom_encode_publish_verified_audio_only_outputs() {
    let temp = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(temp.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let source = temp.path().join("source.mp4");
    common::make_source(&ffmpeg, &source);
    let encoders = Arc::new(DetectedEncoders::from_names([
        "libmp3lame",
        "aac",
        "pcm_s16le",
        "flac",
    ]));
    let backend =
        FfmpegBackend::new(&resolver, Arc::new(common::SilentSink)).with_encoders(encoders, false);

    let mut copy = common::request(
        &source,
        &temp.path().join("copy.m4a"),
        TargetFormat::M4a,
        None,
    );
    copy.audio_options = Some(AudioConvertOptions::Copy);
    let copied = backend
        .convert(JobId::new(), &copy, CancellationToken::new())
        .await
        .unwrap();
    let copied_summary = copied.audio_execution.unwrap();
    assert!(copied_summary.copied);
    assert_eq!(
        common::stream_codecs(&resolver, std::path::Path::new(&copied.output_path), "a"),
        ["aac"]
    );
    assert!(
        common::stream_codecs(&resolver, std::path::Path::new(&copied.output_path), "v").is_empty()
    );
    assert_eq!(
        copied_audio_payload(&ffmpeg, &source),
        copied_audio_payload(&ffmpeg, Path::new(&copied.output_path)),
        "Copy must preserve the selected audio packet payload exactly"
    );

    let mut custom = common::request(
        &source,
        &temp.path().join("custom.wav"),
        TargetFormat::Wav,
        None,
    );
    custom.audio_options = Some(AudioConvertOptions::Encode {
        bitrate: None,
        channels: AudioChannels::Stereo,
        sample_rate: AudioSampleRate::Exact { hz: 48_000 },
    });
    let encoded = backend
        .convert(JobId::new(), &custom, CancellationToken::new())
        .await
        .unwrap();
    let summary = encoded.audio_execution.unwrap();
    assert!(!summary.copied);
    assert_eq!(summary.codec, "pcm_s16le");
    assert_eq!(summary.channels, 2);
    assert_eq!(summary.sample_rate_hz, 48_000);
}

#[tokio::test]
#[ignore = "requires bundled ffmpeg and ffprobe sidecars"]
async fn bundled_ffmpeg_covers_every_audio_target_bitrate_rate_and_channel_choice() {
    let temp = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(temp.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let source = temp.path().join("source.mp4");
    common::make_source(&ffmpeg, &source);
    let encoders = Arc::new(DetectedEncoders::from_names([
        "libmp3lame",
        "aac",
        "pcm_s16le",
        "flac",
    ]));
    let backend =
        FfmpegBackend::new(&resolver, Arc::new(common::SilentSink)).with_encoders(encoders, false);

    let cases: &[(TargetFormat, &str, &str, &[u32])] = &[
        (
            TargetFormat::Mp3,
            "mp3",
            "mp3",
            &[64, 96, 128, 160, 192, 256, 320],
        ),
        (
            TargetFormat::M4a,
            "m4a",
            "aac",
            &[64, 96, 128, 160, 192, 256],
        ),
        (
            TargetFormat::Aac,
            "aac",
            "aac",
            &[64, 96, 128, 160, 192, 256],
        ),
        (TargetFormat::Wav, "wav", "pcm_s16le", &[]),
        (TargetFormat::Flac, "flac", "flac", &[]),
    ];
    let channel_rates = [
        (AudioChannels::Mono, 1, 44_100),
        (AudioChannels::Mono, 1, 48_000),
        (AudioChannels::Stereo, 2, 44_100),
        (AudioChannels::Stereo, 2, 48_000),
    ];

    for (target, extension, codec, bitrates) in cases {
        let bitrate_cases: Vec<Option<u32>> = if bitrates.is_empty() {
            vec![None]
        } else {
            bitrates.iter().copied().map(Some).collect()
        };
        for bitrate in bitrate_cases {
            for (channels, expected_channels, sample_rate_hz) in channel_rates {
                let label = bitrate.map_or_else(|| "none".to_owned(), |value| value.to_string());
                let output = temp.path().join(format!(
                    "{extension}-{label}-{expected_channels}-{sample_rate_hz}.{extension}"
                ));
                let mut request = common::request(&source, &output, *target, None);
                request.audio_options = Some(AudioConvertOptions::Encode {
                    bitrate: bitrate.map(|kbps| AudioBitrate::Target { kbps }),
                    channels,
                    sample_rate: AudioSampleRate::Exact { hz: sample_rate_hz },
                });

                let converted = backend
                    .convert(JobId::new(), &request, CancellationToken::new())
                    .await
                    .unwrap_or_else(|error| panic!("{output:?}: {error}"));
                let summary = converted.audio_execution.expect("audio execution summary");
                assert_eq!(summary.codec, *codec, "{output:?}");
                assert_eq!(summary.channels, expected_channels, "{output:?}");
                assert_eq!(summary.sample_rate_hz, sample_rate_hz, "{output:?}");
                assert_eq!(
                    summary.requested,
                    AudioConvertOptions::Encode {
                        bitrate: bitrate.map(|kbps| AudioBitrate::Target { kbps }),
                        channels,
                        sample_rate: AudioSampleRate::Exact { hz: sample_rate_hz },
                    },
                    "{output:?}"
                );
            }
        }

        let preserve_output = temp.path().join(format!("preserve.{extension}"));
        let mut preserve = common::request(&source, &preserve_output, *target, None);
        preserve.audio_options = Some(AudioConvertOptions::Encode {
            bitrate: bitrates
                .contains(&192)
                .then_some(AudioBitrate::Target { kbps: 192 }),
            channels: AudioChannels::Preserve,
            sample_rate: AudioSampleRate::Preserve,
        });
        let converted = backend
            .convert(JobId::new(), &preserve, CancellationToken::new())
            .await
            .unwrap_or_else(|error| panic!("{preserve_output:?}: {error}"));
        let summary = converted.audio_execution.expect("audio execution summary");
        assert_eq!(summary.codec, *codec, "{preserve_output:?}");
        assert_eq!(summary.channels, 1, "{preserve_output:?}");
        assert_eq!(summary.sample_rate_hz, 44_100, "{preserve_output:?}");
    }
}

#[tokio::test]
#[ignore = "requires bundled ffmpeg and ffprobe sidecars"]
async fn bundled_ffmpeg_preserves_channel_and_resample_semantics() {
    let temp = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(temp.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let encoders = Arc::new(DetectedEncoders::from_names(["flac"]));
    let backend =
        FfmpegBackend::new(&resolver, Arc::new(common::SilentSink)).with_encoders(encoders, false);

    let mono = temp.path().join("mono.wav");
    make_audio_source(
        &ffmpeg,
        &mono,
        "sine=frequency=1000:sample_rate=48000:duration=0.5",
    );
    let stereo = temp.path().join("mono-to-stereo.flac");
    let mut duplicate = common::request(&mono, &stereo, TargetFormat::Flac, None);
    duplicate.audio_options = Some(AudioConvertOptions::Encode {
        bitrate: None,
        channels: AudioChannels::Stereo,
        sample_rate: AudioSampleRate::Preserve,
    });
    backend
        .convert(JobId::new(), &duplicate, CancellationToken::new())
        .await
        .unwrap();
    let stereo_samples = decoded_f32(&ffmpeg, &stereo);
    assert!(stereo_samples.len() > 20_000);
    assert!(stereo_samples
        .as_chunks::<2>()
        .0
        .iter()
        .all(|pair| (pair[0] - pair[1]).abs() < 1.0e-6));

    let anti_phase = temp.path().join("anti-phase.wav");
    make_audio_source(
        &ffmpeg,
        &anti_phase,
        "aevalsrc=0.25*sin(2*PI*440*t)|-0.25*sin(2*PI*440*t):s=48000:d=0.5",
    );
    let downmixed = temp.path().join("anti-phase-mono.flac");
    let mut downmix = common::request(&anti_phase, &downmixed, TargetFormat::Flac, None);
    downmix.audio_options = Some(AudioConvertOptions::Encode {
        bitrate: None,
        channels: AudioChannels::Mono,
        sample_rate: AudioSampleRate::Preserve,
    });
    backend
        .convert(JobId::new(), &downmix, CancellationToken::new())
        .await
        .unwrap();
    let mono_samples = decoded_f32(&ffmpeg, &downmixed);
    let rms = (mono_samples
        .iter()
        .map(|sample| f64::from(*sample) * f64::from(*sample))
        .sum::<f64>()
        / mono_samples.len() as f64)
        .sqrt();
    assert!(rms < 1.0e-5, "anti-phase downmix RMS was {rms}");

    let resampled = temp.path().join("resampled.flac");
    let mut resample = common::request(&mono, &resampled, TargetFormat::Flac, None);
    resample.audio_options = Some(AudioConvertOptions::Encode {
        bitrate: None,
        channels: AudioChannels::Mono,
        sample_rate: AudioSampleRate::Exact { hz: 44_100 },
    });
    backend
        .convert(JobId::new(), &resample, CancellationToken::new())
        .await
        .unwrap();
    let samples = decoded_f32(&ffmpeg, &resampled);
    let trim = 441usize.min(samples.len() / 4);
    let middle = &samples[trim..samples.len() - trim];
    let crossings = middle
        .windows(2)
        .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
        .count();
    let seconds = middle.len() as f64 / 44_100.0;
    let frequency = crossings as f64 / seconds;
    assert!(
        (frequency - 1_000.0).abs() < 5.0,
        "resampled tone was {frequency} Hz"
    );
    assert!((samples.len() as f64 / 44_100.0 - 0.5).abs() < 0.005);

    let dual_tone = temp.path().join("dual-tone-44100.wav");
    make_audio_source(
        &ffmpeg,
        &dual_tone,
        "aevalsrc=0.25*sin(2*PI*440*t)|0.25*sin(2*PI*880*t):s=44100:d=0.5",
    );
    let upsampled = temp.path().join("dual-tone-mono-48000.flac");
    let mut upsample = common::request(&dual_tone, &upsampled, TargetFormat::Flac, None);
    upsample.audio_options = Some(AudioConvertOptions::Encode {
        bitrate: None,
        channels: AudioChannels::Mono,
        sample_rate: AudioSampleRate::Exact { hz: 48_000 },
    });
    backend
        .convert(JobId::new(), &upsample, CancellationToken::new())
        .await
        .unwrap();
    let samples = decoded_f32(&ffmpeg, &upsampled);
    let trim = 480usize.min(samples.len() / 4);
    let middle = &samples[trim..samples.len() - trim];
    assert!(
        tone_magnitude(middle, 48_000.0, 440.0) > 0.03,
        "stereo-to-mono downmix lost the 440 Hz channel"
    );
    assert!(
        tone_magnitude(middle, 48_000.0, 880.0) > 0.03,
        "stereo-to-mono downmix lost the 880 Hz channel"
    );
    assert!((samples.len() as f64 / 48_000.0 - 0.5).abs() < 0.005);
}

#[cfg(debug_assertions)]
#[tokio::test]
#[ignore = "requires bundled ffmpeg and ffprobe sidecars"]
async fn source_change_before_publication_fails_without_a_destination() {
    let temp = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(temp.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let source = temp.path().join("source.mp4");
    common::make_source(&ffmpeg, &source);
    let output = temp.path().join("must-not-publish.wav");
    let changed_source = source.clone();
    let backend = FfmpegBackend::new(&resolver, Arc::new(common::SilentSink))
        .with_encoders(Arc::new(DetectedEncoders::from_names(["pcm_s16le"])), false)
        .with_before_publish_test_hook(Arc::new(move || {
            std::fs::write(&changed_source, b"changed after admission").unwrap();
        }));
    let mut request = common::request(&source, &output, TargetFormat::Wav, None);
    request.audio_options = Some(AudioConvertOptions::Encode {
        bitrate: None,
        channels: AudioChannels::Stereo,
        sample_rate: AudioSampleRate::Exact { hz: 48_000 },
    });

    let error = backend
        .convert(JobId::new(), &request, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error
        .user_message()
        .contains("source changed during conversion"));
    assert!(!output.exists());
}

#[cfg(debug_assertions)]
#[tokio::test]
#[ignore = "requires bundled ffmpeg and ffprobe sidecars"]
async fn selected_source_is_revalidated_immediately_before_execution() {
    let temp = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(temp.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let source = temp.path().join("source.mp4");
    let replacement = temp.path().join("replacement.mp4");
    common::make_source_sized(&ffmpeg, &source, 160, 120);
    common::make_source_sized(&ffmpeg, &replacement, 320, 240);
    let output = temp.path().join("must-not-run.m4a");
    let encoders = Arc::new(DetectedEncoders::from_names(["aac"]));
    let request = selected_copy_request(&resolver, &encoders, &source, &output).await;
    let changed_source = source.clone();
    let backend = FfmpegBackend::new(&resolver, Arc::new(common::SilentSink))
        .with_encoders(encoders, false)
        .with_before_run_test_hook(Arc::new(move || {
            std::fs::copy(&replacement, &changed_source).unwrap();
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
async fn selected_source_is_revalidated_immediately_before_publication() {
    let temp = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(temp.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let source = temp.path().join("source.mp4");
    let replacement = temp.path().join("replacement.mp4");
    common::make_source_sized(&ffmpeg, &source, 160, 120);
    common::make_source_sized(&ffmpeg, &replacement, 320, 240);
    let output = temp.path().join("must-not-publish.m4a");
    let encoders = Arc::new(DetectedEncoders::from_names(["aac"]));
    let request = selected_copy_request(&resolver, &encoders, &source, &output).await;
    let changed_source = source.clone();
    let backend = FfmpegBackend::new(&resolver, Arc::new(common::SilentSink))
        .with_encoders(encoders, false)
        .with_before_publish_test_hook(Arc::new(move || {
            std::fs::copy(&replacement, &changed_source).unwrap();
        }));

    let error = backend
        .convert(JobId::new(), &request, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.user_message().contains("reinspect"));
    assert!(!output.exists());
}
