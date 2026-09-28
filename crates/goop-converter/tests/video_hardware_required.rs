#![cfg(all(target_os = "macos", target_arch = "aarch64"))]

use goop_converter::ConversionBackend;
use goop_core::*;
use std::{path::Path, process::Command, sync::Arc};
use tokio_util::sync::CancellationToken;

mod common;

fn make_hardware_track_source(ffmpeg: &Path, root: &Path, output: &Path, target: TargetFormat) {
    let unmarked = root.join(format!("hardware-unmarked.{}", target.extension()));
    let subtitle = root.join("english.srt");
    std::fs::write(
        &subtitle,
        "1\n00:00:00,000 --> 00:00:01,500\nHardware required\n",
    )
    .unwrap();
    let subtitle_encoder = if matches!(target, TargetFormat::Mp4 | TargetFormat::Mov) {
        "mov_text"
    } else {
        "subrip"
    };
    let first_audio_encoder = if target == TargetFormat::Mkv {
        "pcm_s16le"
    } else {
        "aac"
    };
    let status = Command::new(ffmpeg)
        .args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=320x180:r=24:d=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=2",
            "-i",
        ])
        .arg(&subtitle)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-map",
            "2:a:0",
            "-map",
            "3:s:0",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a:0",
            first_audio_encoder,
            "-c:a:1",
            "aac",
            "-c:s",
            subtitle_encoder,
            "-disposition:a:0",
            "default",
            "-disposition:a:1",
            "0",
            "-disposition:s:0",
            "forced",
        ])
        .arg(&unmarked)
        .status()
        .unwrap();
    assert!(status.success(), "failed to create hardware track source");
    let marked = Command::new(ffmpeg)
        .args(["-y", "-v", "error", "-display_rotation", "90", "-i"])
        .arg(&unmarked)
        .args(["-map", "0", "-c", "copy"])
        .arg(output)
        .status()
        .unwrap();
    assert!(
        marked.success(),
        "failed to mark hardware track source rotation"
    );
}

fn hardware_request(
    target: TargetFormat,
    input: &Path,
    output: &Path,
    source: TrackSourceBinding,
    aac_index: u32,
) -> ConvertRequest {
    ConvertRequest {
        input_path: input.to_string_lossy().into_owned(),
        output_path: output.to_string_lossy().into_owned(),
        target,
        quality_preset: None,
        resolution_cap: None,
        gif_options: None,
        compress_mode: None,
        batch_id: None,
        metadata_policy: None,
        image_color_policy: None,
        image_alpha_policy: None,
        subtitle: None,
        image_options: None,
        audio_options: None,
        video_options: Some(VideoConvertOptions::HardwareEncode {
            codec: VideoHardwareCodec::H264,
            hardware_policy: VideoHardwarePolicy::Required,
            rate_control: VideoHardwareRateControl::AverageBitrate { kbps: 5000 },
            resize: Some(VideoResize::FitWithin {
                width: 160,
                height: 100,
            }),
            frame_rate: Some(VideoFrameRate::Constant {
                numerator: 30_000,
                denominator: 1_001,
            }),
        }),
        track_options: Some(TrackConvertOptions::Video {
            source,
            audio: TrackStreamPolicy::Choose {
                stream_indices: vec![aac_index],
            },
            subtitles: TrackStreamPolicy::KeepAll,
        }),
    }
}

#[tokio::test]
#[ignore = "requires the real bundled FFmpeg and a usable VideoToolbox hardware session"]
async fn bundled_hardware_required_covers_container_transform_fps_and_tracks_without_surrogate() {
    let temp = tempfile::tempdir().unwrap();
    let resolver = common::bundled_resolver(temp.path());
    let ffmpeg = common::ffmpeg_path(&resolver);
    let detected = goop_converter::detect_encoders(&resolver).await;
    assert!(detected.supports_h264_videotoolbox_required());

    for target in [TargetFormat::Mp4, TargetFormat::Mov, TargetFormat::Mkv] {
        let source = temp
            .path()
            .join(format!("hardware-source.{}", target.extension()));
        make_hardware_track_source(&ffmpeg, temp.path(), &source, target);
        let inspection = goop_converter::capabilities::inspect_source_with_encoders(
            &resolver, &source, &detected,
        )
        .await
        .unwrap();
        assert_eq!(
            inspection
                .probe
                .video_details
                .as_ref()
                .and_then(|details| details
                    .streams
                    .iter()
                    .find(|stream| stream.codec_type == "video"))
                .and_then(|video| video.rotation_degrees),
            Some(90),
            "hardware fixture must carry the expected source display rotation"
        );
        let binding = inspection.track_source.unwrap();
        let aac_index = binding
            .inventory
            .streams
            .iter()
            .find(|stream| {
                stream.codec_type == "audio"
                    && stream.codec_name
                        == TrackTextFact::Value {
                            value: "aac".into(),
                        }
            })
            .unwrap()
            .index;
        let output = temp
            .path()
            .join(format!("hardware-output.{}", target.extension()));
        let request = hardware_request(target, &source, &output, binding, aac_index);
        let backend = goop_converter::FfmpegBackend::new(&resolver, Arc::new(common::SilentSink))
            .with_encoders(Arc::new(detected.clone()), false);
        let result = goop_converter::backend::ConversionBackend::convert(
            &backend,
            JobId::new(),
            &request,
            CancellationToken::new(),
        )
        .await
        .unwrap_or_else(|error| panic!("{target:?}: {error}"));
        assert!(matches!(
            result.video_attempt,
            Some(VideoAttempt::Encode {
                encoder: VideoEncoder::H264Videotoolbox,
                encode_attempt_ordinal: 1,
                selection_context: VideoSelectionContext::ExplicitHardwareRequired,
                fallback: None,
            })
        ));
        let facts = goop_converter::FfmpegBackend::probe(&resolver, &output)
            .await
            .unwrap();
        assert_eq!((facts.width, facts.height), (Some(56), Some(100)));
        assert_eq!(common::stream_codecs(&resolver, &output, "a"), ["aac"]);
        assert_eq!(common::stream_codecs(&resolver, &output, "s").len(), 1);
    }
}
