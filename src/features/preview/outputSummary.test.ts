import { expect, it } from "vitest";
import { outputSummary } from "./outputSummary";
import type { JobResult } from "@/types";
const result = (fields: object) => ({bytes:100n,source_bytes:200n,...fields}) as JobResult;
it("reports actual savings, growth, and missing facts without invented savings", () => {
  expect(outputSummary(result({}))).toContain("50% smaller");
  expect(outputSummary(result({bytes:300n}))).toContain("50% larger");
  expect(outputSummary(result({source_bytes:null}))).toBeNull();
});
it("never presents a historical oversized output as meeting its target", () => {
  expect(outputSummary(result({target_bytes:80n}))).toContain("Target missed");
  expect(outputSummary(result({target_bytes:100n}))).toContain("Target met");
});
it("uses actual per-stream execution facts and labels legacy video only with known job context", () => {
  const execution = {requested:{kind:"encode",codec:"hevc",rate_control:{kind:"average_bitrate",kbps:5000},speed:"slow",processor:"software"},encoder:"libx265",video_codec:"hevc",video_stream_index:0,audio_stream_index:1,audio_codec:"aac",audio_copied:false,width:854,height:480,notices:["Color tags are unspecified"]};
  const summary = outputSummary(result({video_execution:execution,reencoded:false}));
  expect(summary).toContain("libx265"); expect(summary).toContain("5000 kbps"); expect(summary).toContain("Slow"); expect(summary).toContain("AAC 192 kbps"); expect(summary).toContain("854 × 480"); expect(summary).not.toContain("Stream copied");
  expect(outputSummary(result({}),{kind:"convert",payload:{target:"mp4"}})).toContain("Detailed video configuration unavailable");
  expect(outputSummary(result({}),{kind:"convert",payload:{target:"jpeg"}})).not.toContain("video configuration");
});
it("keeps processing facts without byte measurements and never infers per-stream Copy from a legacy flag", () => {
  const legacy = outputSummary(result({bytes:null,reencoded:false}),{kind:"convert",payload:{target:"mp4"}});
  expect(legacy).toContain("Detailed video configuration unavailable");
  expect(legacy).not.toContain("Stream copied");
  const image = outputSummary(result({reencoded:false}),{kind:"convert",payload:{target:"jpeg"}});
  expect(image).not.toContain("Stream copied");
  expect(image).not.toContain("video configuration");
});
it("reports requested and resolved dimensions and exact timing without classifying cadence", () => {
  const execution = {
    requested:{kind:"encode",codec:"h264",rate_control:{kind:"constant_quality",crf:23},speed:"medium",processor:"software",resize:{kind:"fit_within",width:1280,height:721},frame_rate:{kind:"constant",numerator:24000,denominator:1001}},
    encoder:"libx264",video_codec:"h264",video_stream_index:0,audio_stream_index:null,audio_codec:null,audio_copied:false,width:1280,height:720,
    requested_resize:{kind:"fit_within",width:1280,height:721},requested_frame_rate:{kind:"constant",numerator:24000,denominator:1001},
    source_average_frame_rate:{kind:"exact",numerator:30000,denominator:1001},source_base_frame_rate:{kind:"exact",numerator:30,denominator:1},source_time_base:{kind:"exact",numerator:1,denominator:90000},
    resolved_constant_frame_rate:{kind:"exact",numerator:24000,denominator:1001},notices:[],
  };
  const summary = outputSummary(result({video_execution:execution}));
  expect(summary).toContain("Fit within 1280 × 721 px");
  expect(summary).toContain("resolved 1280 × 720 px upright");
  expect(summary).toContain("Reported average 30000/1001 fps");
  expect(summary).toContain("base 30/1 fps");
  expect(summary).toContain("time base 1/90000");
  expect(summary).toContain("Constant 23.976 fps");
  expect(summary).toContain("resolved 24000/1001 fps");
  expect(summary).toContain("frames may be duplicated or dropped");
  expect(summary).not.toMatch(/\b(?:CFR|VFR|constant source|variable source)\b/);
});
it("labels absent legacy timing as Previous automatic timing instead of Preserve", () => {
  const execution = {requested:{kind:"encode",codec:"h264",rate_control:{kind:"constant_quality",crf:23},speed:"medium",processor:"software"},encoder:"libx264",video_codec:"h264",video_stream_index:0,audio_copied:false,width:1920,height:1080,notices:[]};
  const summary = outputSummary(result({video_execution:execution}));
  expect(summary).toContain("Previous automatic timing");
  expect(summary).not.toContain("Preserve source timing");
});

it("reports explicit audio copy and custom facts including omission notices", () => {
  const copied = outputSummary(result({audio_execution:{
    requested:{kind:"copy"},encoder:null,codec:"aac",audio_stream_index:1,copied:true,
    sample_rate_hz:48000,channels:2,channel_layout:"stereo",sample_format:"fltp",
    bit_depth:null,reported_bitrate_kbps:192,notices:["Non-audio streams and artwork are not included"],
  }}));
  expect(copied).toContain("Audio copied (AAC)");
  expect(copied).toContain("48 kHz");
  expect(copied).toContain("2 channels (stereo)");
  expect(copied).toContain("Reported 192 kbps");
  expect(copied).toContain("Non-audio streams and artwork are not included");

  const encoded = outputSummary(result({audio_execution:{
    requested:{kind:"encode",bitrate:null,channels:{kind:"mono"},sample_rate:{kind:"exact",hz:44100}},
    encoder:"flac",codec:"flac",audio_stream_index:0,copied:false,sample_rate_hz:44100,
    channels:1,channel_layout:"mono",sample_format:"s16",bit_depth:16,
    reported_bitrate_kbps:null,notices:[],
  }}));
  expect(encoded).toContain("Audio encoded (FLAC · flac)");
  expect(encoded).toContain("44.1 kHz");
  expect(encoded).toContain("1 channel (mono)");
  expect(encoded).toContain("Sample format s16");
  expect(encoded).toContain("16-bit");
  expect(encoded).not.toContain("Target");
});

it("combines the chosen source track and deliberate omissions with audio processing", () => {
  const selected = {
    index: 4,
    codec_type: "audio",
    codec_name: { kind: "value" as const, value: "aac" },
    container_stream_id: { kind: "missing" as const },
    language: { kind: "value" as const, value: "eng" },
    title: { kind: "value" as const, value: "Commentary" },
    disposition: { default: false, forced: false, attached_pic: false, other: {}, malformed: false },
  };
  const binding = {
    version: 1,
    canonical_path: "/movie.mkv",
    size_bytes: "100",
    modified_unix_ns: "200",
    inventory: { version: 1, streams: [selected] },
  };
  const summary = outputSummary(result({
    track_execution: {
      requested: { kind: "audio", source: binding, stream_index: 4 },
      selected,
      dropped_audio: [{ ...selected, index: 5 }],
      dropped_other: [{ ...selected, index: 0, codec_type: "video" }],
      output_stream_index: 0,
      notices: [],
    },
    audio_execution: {
      requested: { kind: "copy" }, encoder: null, codec: "aac", audio_stream_index: 0,
      copied: true, sample_rate_hz: 48_000, channels: 2, channel_layout: "stereo",
      sample_format: null, bit_depth: null, reported_bitrate_kbps: null, notices: [],
    },
  }));
  expect(summary).toContain("Track 4");
  expect(summary).toContain("English");
  expect(summary).toContain("Commentary");
  expect(summary).toContain("1 additional audio stream omitted");
  expect(summary).toContain("1 non-audio stream omitted");
  expect(summary).toContain("Audio copied (AAC)");
});

it("normalizes only track language while preserving a title that resembles a language code", () => {
  const selected = {
    index: 2,
    codec_type: "audio",
    codec_name: { kind: "value" as const, value: "aac" },
    container_stream_id: { kind: "missing" as const },
    language: { kind: "value" as const, value: "eng" },
    title: { kind: "value" as const, value: "de" },
    disposition: { default: false, forced: false, attached_pic: false, other: {}, malformed: false },
  };
  const binding = {
    version: 1,
    canonical_path: "/movie.mkv",
    size_bytes: "100",
    modified_unix_ns: "200",
    inventory: { version: 1, streams: [selected] },
  };
  const summary = outputSummary(result({
    track_execution: {
      requested: { kind: "audio", source: binding, stream_index: 2 },
      selected,
      dropped_audio: [],
      dropped_other: [],
      output_stream_index: 0,
      notices: [],
    },
  }));
  expect(summary).toContain("English");
  expect(summary).toContain("de");
  expect(summary).not.toContain("German");
});
