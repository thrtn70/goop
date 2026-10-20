import { describe, expect, it } from "vitest";
import {
  MAX_NATIVE_IMAGE_BYTES,
  MAX_NATIVE_IMAGE_PIXELS,
  UNAVAILABLE_MESSAGES,
  planPreview,
  type PreviewPlan,
  type PreviewUnavailableReason,
} from "@/features/player/previewPlan";
import type { ProbeResult } from "@/types";

const probe = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  duration_ms: BigInt(60_000),
  width: null,
  height: null,
  video_codec: null,
  audio_codec: null,
  file_size: BigInt(1_048_576),
  container: null,
  has_video: false,
  has_audio: false,
  source_kind: "video",
  color_space: null,
  image_format: null,
  has_subtitles: false,
  subtitle_codecs: [],
  audio_codecs: [],
  ...overrides,
});

const video = (video_codec: string | null, audio_codec: string | null = null) =>
  probe({ source_kind: "video", has_video: true, has_audio: audio_codec !== null, video_codec, audio_codec });
const audio = (audio_codec: string | null = "mp3") =>
  probe({ source_kind: "audio", has_audio: true, audio_codec });
const image = (width: number | null = 1920, height: number | null = 1080) =>
  probe({ source_kind: "image", width, height });

const HOME = "/Users/a";
const unavailable = (reason: PreviewUnavailableReason): PreviewPlan => ({ kind: "unavailable", reason });

describe("planPreview", () => {
  it.each<[string, string, ProbeResult, string | null, PreviewPlan]>([
    // video: base MIME by extension plus codec tags
    ["hevc/aac in .MOV", "/Users/a/x.MOV", video("hevc", "aac"), HOME,
      { kind: "video", mime: 'video/quicktime; codecs="hvc1, mp4a.40.2"' }],
    ["h264 with no audio", "/Users/a/x.mp4", video("h264"), HOME,
      { kind: "video", mime: 'video/mp4; codecs="avc1"' }],
    ["h264/mp3 in .m4v", "/Users/a/x.m4v", video("h264", "mp3"), HOME,
      { kind: "video", mime: 'video/mp4; codecs="avc1, mp4a.6B"' }],
    ["vp9/opus in .webm", "/Users/a/x.webm", video("vp9", "opus"), HOME,
      { kind: "video", mime: 'video/webm; codecs="vp09, opus"' }],
    ["av1/eac3 in .mp4", "/Users/a/x.mp4", video("av1", "eac3"), HOME,
      { kind: "video", mime: 'video/mp4; codecs="av01, ec-3"' }],
    ["video name is irrelevant to the plan", "/Users/a/my clip #1 %.mp4", video("h264"), HOME,
      { kind: "video", mime: 'video/mp4; codecs="avc1"' }],
    ["unsupported container", "/Users/a/x.mkv", video("h264"), HOME,
      { kind: "unavailable", reason: "format" }],
    ["unmapped video codec", "/Users/a/x.mp4", video("mpeg4"), HOME,
      { kind: "unavailable", reason: "format" }],
    ["unmapped audio codec", "/Users/a/x.mp4", video("h264", "dts"), HOME,
      { kind: "unavailable", reason: "format" }],
    ["no extension", "/Users/a/clip", video("h264"), HOME,
      { kind: "unavailable", reason: "format" }],
    ["dot in a folder name is not an extension", "/Users/a/v1.2/clip", video("h264"), HOME,
      { kind: "unavailable", reason: "format" }],
    ["inherited object keys are not extensions", "/Users/a/x.constructor", video("h264"), HOME,
      { kind: "unavailable", reason: "format" }],

    // home folder check
    ["outside home", "/Volumes/Ext/x.mp4", video("h264"), HOME,
      { kind: "unavailable", reason: "outside-home" }],
    ["sibling folder sharing a prefix", "/Users/ab/x.mp4", video("h264"), HOME,
      { kind: "unavailable", reason: "outside-home" }],
    ["home with a trailing slash", "/Users/a/x.mp4", video("h264"), "/Users/a/",
      { kind: "video", mime: 'video/mp4; codecs="avc1"' }],
    ["Windows path and drive letter case", "C:\\Users\\A\\x.mp4", video("h264"), "c:\\users\\a",
      { kind: "video", mime: 'video/mp4; codecs="avc1"' }],
    ["Windows path outside home", "D:\\x.mp4", video("h264"), "c:\\users\\a",
      { kind: "unavailable", reason: "outside-home" }],
    ["POSIX paths stay case-sensitive", "/users/a/x.mp4", video("h264"), HOME,
      { kind: "unavailable", reason: "outside-home" }],
    ["home unknown skips the check", "/Users/a/x.mp4", video("h264"), null,
      { kind: "video", mime: 'video/mp4; codecs="avc1"' }],
    ["an empty home admits nothing", "/Users/a/x.mp4", video("h264"), "",
      { kind: "unavailable", reason: "outside-home" }],
    ["a home that is only slashes admits nothing", "/Users/a/x.mp4", video("h264"), "/",
      { kind: "unavailable", reason: "outside-home" }],
    ["a parent-directory step out of home", "/Users/a/../b/x.mp4", video("h264"), HOME,
      { kind: "unavailable", reason: "outside-home" }],
    ["a Windows parent-directory step out of home", "C:\\Users\\A\\..\\B\\x.mp4", video("h264"), "c:\\users\\a",
      { kind: "unavailable", reason: "outside-home" }],
    ["two dots inside a file name are not a step", "/Users/a/a..b.mp4", video("h264"), HOME,
      { kind: "video", mime: 'video/mp4; codecs="avc1"' }],
    ["outside home beats pdf", "/Volumes/Ext/d.pdf", probe({ source_kind: "pdf" }), HOME,
      { kind: "unavailable", reason: "outside-home" }],

    // images
    ["48 MP HEIC is allowed", "/Users/a/p.HEIC", image(8064, 6048), HOME, { kind: "image" }],
    ["60 MP photo is too large", "/Users/a/p.jpg", image(10_000, 6_000), HOME,
      { kind: "unavailable", reason: "too-large" }],
    ["unknown dimensions are allowed", "/Users/a/p.png", image(null, null), HOME, { kind: "image" }],
    ["one unknown dimension is allowed", "/Users/a/p.png", image(100_000, null), HOME, { kind: "image" }],
    ["RAW photo", "/Users/a/p.dng", image(), HOME, { kind: "unavailable", reason: "format" }],
    ["ico", "/Users/a/p.ico", image(), HOME, { kind: "unavailable", reason: "format" }],
    ["unsupported beats too large", "/Users/a/p.dng", image(10_000, 6_000), HOME,
      { kind: "unavailable", reason: "format" }],

    // audio
    ["flac", "/Users/a/s.flac", audio("flac"), HOME, { kind: "audio", mime: "audio/flac" }],
    ["mp3", "/Users/a/s.MP3", audio("mp3"), HOME, { kind: "audio", mime: "audio/mpeg" }],
    ["opus in ogg", "/Users/a/s.ogg", audio("opus"), HOME, { kind: "audio", mime: "audio/ogg" }],
    ["unsupported audio container", "/Users/a/s.wma", audio("wmav2"), HOME,
      { kind: "unavailable", reason: "format" }],
    ["video-kind without video plays as audio", "/Users/a/v.mp4",
      probe({ source_kind: "video", has_video: false, has_audio: true, audio_codec: "aac" }), HOME,
      { kind: "audio", mime: "audio/mp4" }],
    ["video-kind without video in an unsupported container", "/Users/a/v.mkv",
      probe({ source_kind: "video", has_video: false, has_audio: true, audio_codec: "aac" }), HOME,
      { kind: "unavailable", reason: "format" }],

    // embedded cover art is reported as a video stream, so tagged audio arrives as video-kind
    ["mp3 with cover art", "/Users/a/s.mp3", video("mjpeg", "mp3"), HOME,
      { kind: "audio", mime: "audio/mpeg" }],
    ["flac with cover art", "/Users/a/s.flac", video("png", "flac"), HOME,
      { kind: "audio", mime: "audio/flac" }],
    ["m4a with cover art", "/Users/a/s.m4a", video("mjpeg", "aac"), HOME,
      { kind: "audio", mime: "audio/mp4" }],
    ["cover art in a container neither table knows", "/Users/a/x.mkv", video("mjpeg", "aac"), HOME,
      { kind: "unavailable", reason: "format" }],
    ["audio extension with a video stream and no audio", "/Users/a/s.mp3", video("mjpeg"), HOME,
      { kind: "unavailable", reason: "format" }],
    ["video extensions keep the video branch", "/Users/a/x.mp4", video("mjpeg", "aac"), HOME,
      { kind: "unavailable", reason: "format" }],

    // nothing to show
    ["pdf", "/Users/a/d.pdf", probe({ source_kind: "pdf" }), HOME, { kind: "none" }],
    ["subtitle", "/Users/a/s.srt", probe({ source_kind: "subtitle" }), HOME, { kind: "none" }],
  ])("%s", (_name, path, source, home, expected) => {
    expect(planPreview(path, source, home)).toEqual(expected);
  });

  it("allows exactly the pixel cap and rejects one pixel more", () => {
    expect(planPreview("/Users/a/p.png", image(MAX_NATIVE_IMAGE_PIXELS, 1), HOME)).toEqual({ kind: "image" });
    expect(planPreview("/Users/a/p.png", image(MAX_NATIVE_IMAGE_PIXELS + 1, 1), HOME)).toEqual(
      unavailable("too-large"),
    );
  });

  it("allows exactly the byte cap and rejects one byte more, whatever the pixel count", () => {
    const sized = (bytes: number) => probe({ source_kind: "image", width: 1, height: 1, file_size: BigInt(bytes) });
    expect(planPreview("/Users/a/p.png", sized(MAX_NATIVE_IMAGE_BYTES), HOME)).toEqual({ kind: "image" });
    expect(planPreview("/Users/a/p.png", sized(MAX_NATIVE_IMAGE_BYTES + 1), HOME)).toEqual(unavailable("too-large"));
  });

  it("reads a file size that arrives as a plain JSON number", () => {
    // ts-rs types it as bigint, but the IPC layer hands over a number.
    const size = (MAX_NATIVE_IMAGE_BYTES + 1) as unknown as bigint;
    const tiff = probe({ source_kind: "image", width: 1, height: 1, file_size: size });
    expect(planPreview("/Users/a/layers.tif", tiff, HOME)).toEqual(unavailable("too-large"));
  });

  it("leaves video and audio sizes alone, since they stream", () => {
    const huge = BigInt(MAX_NATIVE_IMAGE_BYTES) * BigInt(8);
    expect(planPreview("/Users/a/x.mp4", { ...video("h264"), file_size: huge }, HOME)).toEqual({
      kind: "video",
      mime: 'video/mp4; codecs="avc1"',
    });
    expect(planPreview("/Users/a/s.flac", { ...audio("flac"), file_size: huge }, HOME)).toEqual({
      kind: "audio",
      mime: "audio/flac",
    });
  });
});

describe("UNAVAILABLE_MESSAGES", () => {
  it("carries the five fixed strings", () => {
    expect(UNAVAILABLE_MESSAGES).toEqual({
      "outside-home": "Files outside your home folder can't be previewed yet.",
      format: "This format can't be previewed here yet.",
      "too-large": "This photo is too large to preview here yet.",
      "probe-failed": "Goop couldn't read this file, so there's no preview.",
      playback: "This file couldn't be played here.",
    });
  });
});
