import type { ProbeResult } from "@/types";

export type PreviewUnavailableReason = "outside-home" | "format" | "too-large" | "probe-failed" | "playback";
export type PlayablePlan = { kind: "image" } | { kind: "video"; mime: string } | { kind: "audio"; mime: string };
export type PreviewPlan = PlayablePlan | { kind: "none" } | { kind: "unavailable"; reason: PreviewUnavailableReason };

/** A 48 MP photo (8064x6048) is 48,771,072 pixels and must still preview. */
export const MAX_NATIVE_IMAGE_PIXELS = 50_000_000;

/**
 * A photo is read into memory whole (no ranged reads for images), and pixels alone don't bound that:
 * a layered TIFF under the pixel cap can still run to gigabytes.
 */
export const MAX_NATIVE_IMAGE_BYTES = 256 * 1024 * 1024;

export const UNAVAILABLE_MESSAGES: Record<PreviewUnavailableReason, string> = {
  "outside-home": "Files outside your home folder can't be previewed yet.",
  format: "This format can't be previewed here yet.",
  "too-large": "This photo is too large to preview here yet.",
  "probe-failed": "Goop couldn't read this file, so there's no preview.",
  playback: "This file couldn't be played here.",
};

// Maps, not object literals: a file named `x.constructor` must not find an inherited key.
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "bmp", "tif", "tiff", "jxl",
]);

const VIDEO_MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ["mp4", "video/mp4"],
  ["m4v", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
]);

const AUDIO_MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ["mp3", "audio/mpeg"],
  ["m4a", "audio/mp4"],
  ["aac", "audio/mp4"],
  ["mp4", "audio/mp4"],
  ["wav", "audio/wav"],
  ["flac", "audio/flac"],
  ["ogg", "audio/ogg"],
  ["oga", "audio/ogg"],
  ["opus", "audio/ogg"],
]);

/** RFC 6381 tags for the `codecs` parameter, keyed by the probe's codec name. */
const VIDEO_CODEC_TAGS: ReadonlyMap<string, string> = new Map([
  ["h264", "avc1"],
  ["hevc", "hvc1"],
  ["vp8", "vp8"],
  ["vp9", "vp09"],
  ["av1", "av01"],
]);

const AUDIO_CODEC_TAGS: ReadonlyMap<string, string> = new Map([
  ["aac", "mp4a.40.2"],
  ["mp3", "mp4a.6B"],
  ["alac", "alac"],
  ["ac3", "ac-3"],
  ["eac3", "ec-3"],
  ["opus", "opus"],
  ["vorbis", "vorbis"],
  ["flac", "flac"],
]);

const UNAVAILABLE_FORMAT: PreviewPlan = { kind: "unavailable", reason: "format" };

const normalizeSlashes = (value: string): string => value.replace(/\\/g, "/");

/** Lower-cased text after the last `.` of the file name; empty when the name has none. */
function extensionOf(path: string): string {
  const name = normalizeSlashes(path).split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** A UX pre-filter only: the asset protocol scope is the access control. Unsure answers say "outside". */
function isInsideHome(path: string, homeDir: string): boolean {
  const home = normalizeSlashes(homeDir).replace(/\/+$/, "");
  const target = normalizeSlashes(path);
  // An empty home would prefix every path, and a `..` step can climb out after the prefix matched.
  if (home === "" || target.split("/").includes("..")) return false;
  // Windows paths compare case-insensitively; POSIX ones stay exact.
  const fold = /^[A-Za-z]:/.test(home) ? (value: string) => value.toLowerCase() : (value: string) => value;
  const foldedHome = fold(home);
  const foldedTarget = fold(target);
  return foldedTarget === foldedHome || foldedTarget.startsWith(`${foldedHome}/`);
}

function planImage(path: string, probe: ProbeResult): PreviewPlan {
  if (!IMAGE_EXTENSIONS.has(extensionOf(path))) return UNAVAILABLE_FORMAT;
  // Typed bigint, but it crosses IPC as a JSON number; Number() takes either.
  if (Number(probe.file_size) > MAX_NATIVE_IMAGE_BYTES) return { kind: "unavailable", reason: "too-large" };
  const { width, height } = probe;
  if (width !== null && height !== null && width * height > MAX_NATIVE_IMAGE_PIXELS) {
    return { kind: "unavailable", reason: "too-large" };
  }
  return { kind: "image" };
}

function planVideo(path: string, probe: ProbeResult): PreviewPlan {
  const base = VIDEO_MIME_BY_EXTENSION.get(extensionOf(path));
  if (base === undefined) return UNAVAILABLE_FORMAT;

  const tags: string[] = [];
  for (const [codec, table] of [
    [probe.video_codec, VIDEO_CODEC_TAGS],
    [probe.audio_codec, AUDIO_CODEC_TAGS],
  ] as const) {
    if (codec === null) continue;
    const tag = table.get(codec);
    if (tag === undefined) return UNAVAILABLE_FORMAT;
    tags.push(tag);
  }
  return { kind: "video", mime: `${base}; codecs="${tags.join(", ")}"` };
}

function planAudio(path: string): PreviewPlan {
  const mime = AUDIO_MIME_BY_EXTENSION.get(extensionOf(path));
  return mime === undefined ? UNAVAILABLE_FORMAT : { kind: "audio", mime };
}

/**
 * Embedded cover art is reported as a video stream, so a tagged .mp3/.flac/.m4a arrives as video-kind.
 * It plays as audio when its extension is an audio one and not also a video one (.mp4 keeps the video branch).
 */
function isCoverArtAudio(path: string, probe: ProbeResult): boolean {
  const extension = extensionOf(path);
  return probe.has_audio && !VIDEO_MIME_BY_EXTENSION.has(extension) && AUDIO_MIME_BY_EXTENSION.has(extension);
}

/** homeDir null = home unknown: skip the home check and rely on the runtime error fallback. */
export function planPreview(path: string, probe: ProbeResult, homeDir: string | null): PreviewPlan {
  if (homeDir !== null && !isInsideHome(path, homeDir)) {
    return { kind: "unavailable", reason: "outside-home" };
  }

  switch (probe.source_kind) {
    case "pdf":
    case "subtitle":
      return { kind: "none" };
    case "image":
      return planImage(path, probe);
    case "audio":
      return planAudio(path);
    case "video":
      return probe.has_video && !isCoverArtAudio(path, probe) ? planVideo(path, probe) : planAudio(path);
  }
}
