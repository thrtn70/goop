/**
 * Phase K: preset import/export. JSON file format with a top-level
 * version field so future preset shape changes can be migrated without
 * breaking older files. Built-in presets are excluded from export
 * because they're recreated on first launch and shouldn't be shipped
 * across machines.
 */

import type { CompressMode, GifOptions, ImageColorPolicy, ImageConvertOptions, VideoConvertOptions, MetadataPolicy, SubtitleOptions, Preset, QualityPreset, ResolutionCap, TargetFormat, TrackPresetPolicy } from "@/types";

import { cloneImageOptions, validateImageOptions } from "@/features/convert/imageOptions";

import { cloneVideoOptions, validateVideoRequest } from "@/features/convert/videoOptions";
import { cloneAudioOptions, validateAudioRequest, type AudioConvertOptions } from "@/features/convert/audioOptions";

/** Current bundle schema version. Bump when the shape changes. */
export const PRESET_BUNDLE_VERSION = 9 as const;

// An exhaustive record makes new generated target variants a type error
// until imports support them, so exports cannot silently outgrow imports.
const ALL_TARGETS = {
  mp4: true,
  mkv: true,
  webm: true,
  gif: true,
  avi: true,
  mov: true,
  mp3: true,
  m4a: true,
  opus: true,
  wav: true,
  flac: true,
  ogg: true,
  aac: true,
  extract_audio_keep_codec: true,
  srt: true,
  vtt: true,
  png: true,
  jpeg: true,
  webp: true,
  bmp: true,
  tiff: true,
  avif: true,
  jpeg_xl: true,
} satisfies Record<TargetFormat, true>;

const ALL_QUALITY = [
  "original",
  "fast",
  "balanced",
  "small",
] as const satisfies readonly QualityPreset[];

const ALL_RESOLUTION = [
  "original",
  "r1080p",
  "r720p",
  "r480p",
] as const satisfies readonly ResolutionCap[];

const VALID_TARGETS: ReadonlySet<string> = new Set(Object.keys(ALL_TARGETS));
const VALID_QUALITY: ReadonlySet<QualityPreset> = new Set(ALL_QUALITY);
const VALID_RESOLUTION: ReadonlySet<ResolutionCap> = new Set(ALL_RESOLUTION);

/**
 * On-wire shape of `compress_mode`. The runtime `CompressMode` type
 * uses `bigint` for `target_size_bytes`, but JSON cannot serialize
 * bigints. The bundle stores the same value as a JSON number; the
 * parser converts back to bigint on import. Number is fine for any
 * realistic file size — `Number.MAX_SAFE_INTEGER` is ~9 PB.
 */
type WireCompressMode =
  | { kind: "lossless_reoptimize" }
  | { kind: "quality"; value: number }
  | { kind: "target_size_bytes"; value: number };

/** Wire shape of a single preset entry inside the bundle. */
interface PresetEntry {
  name: string;
  target: TargetFormat;
  quality_preset: QualityPreset | null;
  resolution_cap: ResolutionCap | null;
  compress_mode: CompressMode | null;
  metadata_policy: MetadataPolicy | null;
  image_color_policy: ImageColorPolicy | null;
  gif_options: GifOptions | null;
  subtitle: SubtitleOptions | null;
  image_options: ImageConvertOptions | null;
  video_options: VideoConvertOptions | null;
  audio_options: AudioConvertOptions | null;
  track_policy: TrackPresetPolicy | null;
}

function compressModeForWire(m: CompressMode | null): WireCompressMode | null {
  if (m === null) return null;
  if (m.kind === "target_size_bytes") {
    return { kind: "target_size_bytes", value: Number(m.value) };
  }
  return m;
}

/** Generate a new UUID with a fallback for environments without crypto.randomUUID. */
export function newPresetId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

interface PresetBundleWire {
  version: typeof PRESET_BUNDLE_VERSION;
  exported_at: string;
  presets: Array<{
    name: string;
    target: TargetFormat;
    quality_preset: QualityPreset | null;
    resolution_cap: ResolutionCap | null;
    compress_mode: WireCompressMode | null;
    metadata_policy: MetadataPolicy | null;
    image_color_policy: ImageColorPolicy | null;
    gif_options: GifOptions | null;
    subtitle: SubtitleOptions | null;
    image_options: ImageConvertOptions | null;
    video_options: VideoConvertOptions | null;
    audio_options: AudioConvertOptions | null;
    track_policy: TrackPresetPolicy | null;
  }>;
}

/** Serialize the user's presets (excluding built-ins) into pretty JSON. */
export function serializePresets(presets: readonly Preset[]): string {
  const userPresets = presets.filter((p) => !p.is_builtin);
  const bundle: PresetBundleWire = {
    version: PRESET_BUNDLE_VERSION,
    exported_at: new Date().toISOString(),
    presets: userPresets.map((p) => ({
      name: p.name,
      target: p.target,
      quality_preset: p.quality_preset,
      resolution_cap: p.resolution_cap,
      compress_mode: compressModeForWire(p.compress_mode),
      metadata_policy: p.metadata_policy ?? null,
      image_color_policy: p.image_color_policy ?? null,
      gif_options: p.gif_options ?? null,
      subtitle: p.subtitle ?? null,
      image_options: cloneImageOptions(p.image_options),
      video_options: cloneVideoOptions(p.video_options),
      audio_options: cloneAudioOptions(p.audio_options),
      track_policy: cloneTrackPolicy(p.track_policy),
    })),
  };
  return JSON.stringify(bundle, (_key, value: unknown) => typeof value === "bigint" ? Number(value) : value, 2);
}

export class PresetParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetParseError";
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function cloneTrackPolicy(value: TrackPresetPolicy | null | undefined): TrackPresetPolicy | null {
  if (!value) return null;
  return value.kind === "audio"
    ? { kind: "audio", selection: { kind: "choose_per_file" } }
    : { kind: "video", audio: { kind: value.audio.kind }, subtitles: { kind: value.subtitles.kind } };
}

function validateTrackPolicy(value: unknown, version: number): TrackPresetPolicy | null {
  if (value == null) return null;
  if (!isObject(value) || typeof value.kind !== "string") throw new Error("track_policy is malformed");
  if (value.kind === "video") {
    if (version < 7 || !hasExactKeys(value, ["kind", "audio", "subtitles"])) throw new Error("track_policy video policy requires schema 7");
    const streamPolicy = (candidate: unknown) => {
      if (!isObject(candidate) || !hasExactKeys(candidate, ["kind"]) || !["keep_all", "choose_per_file", "none"].includes(String(candidate.kind))) {
        throw new Error("track_policy video stream policy is malformed");
      }
      return { kind: candidate.kind as "keep_all" | "choose_per_file" | "none" };
    };
    return { kind: "video", audio: streamPolicy(value.audio), subtitles: streamPolicy(value.subtitles) };
  }
  if (!hasExactKeys(value, ["kind", "selection"]) || value.kind !== "audio") {
    throw new Error("track_policy must be a portable audio or video policy");
  }
  const selection = value.selection;
  if (!isObject(selection) || !hasExactKeys(selection, ["kind"]) || selection.kind !== "choose_per_file") {
    throw new Error("track_policy must contain only Choose per file intent");
  }
  return { kind: "audio", selection: { kind: "choose_per_file" } };
}

function validateCompressMode(v: unknown): CompressMode | null {
  if (v === null || v === undefined) return null;
  if (!isObject(v)) {
    throw new PresetParseError("compress_mode must be an object or null");
  }
  if (v.kind === "lossless_reoptimize") {
    return { kind: "lossless_reoptimize" };
  }
  if (v.kind === "quality" && typeof v.value === "number" && Number.isInteger(v.value) && v.value >= 1 && v.value <= 100) {
    return { kind: "quality", value: v.value };
  }
  if (v.kind === "target_size_bytes" && typeof v.value === "number" && Number.isSafeInteger(v.value) && v.value > 0) {
    // Bundle stores number; the IPC boundary converts back to bigint.
    return {
      kind: "target_size_bytes",
      value: BigInt(v.value),
    } as CompressMode;
  }
  throw new PresetParseError(`unsupported compress_mode kind: ${String(v.kind)}`);
}

function validateMetadata(value: unknown, version: number): MetadataPolicy | null {
  if (value == null) return null;
  if (value === "preserve" || value === "strip_all") return value;
  if (value === "remove_personal" && version >= 8) return value;
  throw new PresetParseError("metadata_policy is not recognized");
}
function validateImageColorPolicy(value: unknown, version: number): ImageColorPolicy | null {
  if (value == null) return null;
  if (version >= 9 && ["preserve", "convert_to_srgb", "assume_srgb"].includes(String(value))) {
    return value as ImageColorPolicy;
  }
  throw new PresetParseError("image_color_policy is not recognized");
}
function validateGif(value: unknown): GifOptions | null {
  if (value == null) return null;
  if (!isObject(value) || typeof value.size_preset !== "string" || !["small", "medium", "large"].includes(value.size_preset)) throw new PresetParseError("invalid gif_options");
  const start = value.trim_start_ms ?? null;
  const end = value.trim_end_ms ?? null;
  for (const trim of [start, end]) {
    if (trim !== null && (typeof trim !== "number" || !Number.isSafeInteger(trim) || trim < 0)) throw new PresetParseError("GIF trim must be nonnegative whole milliseconds");
  }
  if (end !== null && Number(end) <= Number(start ?? 0)) throw new PresetParseError("GIF end must follow start");
  return { size_preset: value.size_preset, trim_start_ms: start, trim_end_ms: end } as GifOptions;
}
function validateSubtitle(value: unknown): SubtitleOptions | null {
  if (value == null) return null;
  if (!isObject(value) || typeof value.source_path !== "string" || !value.source_path.trim() || typeof value.mode !== "string" || !["soft", "burn_in"].includes(value.mode)) throw new PresetParseError("invalid subtitle settings");
  return { source_path: value.source_path, mode: value.mode } as SubtitleOptions;
}

function validateEntry(v: unknown, index: number, version: number): PresetEntry {
  if (!isObject(v)) {
    throw new PresetParseError(`preset[${index}] must be an object`);
  }
  if (typeof v.name !== "string" || v.name.trim() === "") {
    throw new PresetParseError(`preset[${index}].name must be a non-empty string`);
  }
  if (typeof v.target !== "string" || !VALID_TARGETS.has(v.target as TargetFormat)) {
    throw new PresetParseError(
      `preset[${index}].target is missing or not a recognised TargetFormat`,
    );
  }
  if (
    v.quality_preset !== null &&
    v.quality_preset !== undefined &&
    !VALID_QUALITY.has(v.quality_preset as QualityPreset)
  ) {
    throw new PresetParseError(
      `preset[${index}].quality_preset is not a recognised QualityPreset`,
    );
  }
  if (
    v.resolution_cap !== null &&
    v.resolution_cap !== undefined &&
    !VALID_RESOLUTION.has(v.resolution_cap as ResolutionCap)
  ) {
    throw new PresetParseError(
      `preset[${index}].resolution_cap is not a recognised ResolutionCap`,
    );
  }
  let imageOptions: ImageConvertOptions | null;
  let videoOptions: VideoConvertOptions | null;
  let audioOptions: AudioConvertOptions | null;
  let trackPolicy: TrackPresetPolicy | null;
  const imageColorPolicy = validateImageColorPolicy(v.image_color_policy, version);
  try {
    if (version === 1 && v.image_options != null) {
      throw new Error("image_options is not allowed in schema 1");
    }
    imageOptions = validateImageOptions(v.image_options);
    if (version < 3 && v.video_options != null) throw new Error("video_options is not allowed before schema 3");
    let requestEntry = v;
    if (version === 3 && isObject(v.video_options)) {
      const legacyVideo = { ...v.video_options };
      for (const field of ["resize", "frame_rate"] as const) {
        if (Object.hasOwn(legacyVideo, field)) {
          if (legacyVideo[field] != null) throw new Error("resize and frame_rate are not allowed in schema 3 video_options");
          delete legacyVideo[field];
        }
      }
      requestEntry = { ...v, video_options: legacyVideo };
    }
    videoOptions = validateVideoRequest({ ...requestEntry, target: v.target as TargetFormat } as Parameters<typeof validateVideoRequest>[0]);
    if (version < 5 && v.audio_options != null) throw new Error("audio_options is not allowed before schema 5");
    audioOptions = validateAudioRequest({ ...requestEntry, target: v.target as TargetFormat });
    if (version < 6 && v.track_policy != null) throw new Error("track_policy is not allowed before schema 6");
    trackPolicy = validateTrackPolicy(v.track_policy, version);
    if (trackPolicy?.kind === "audio" && audioOptions === null) {
      throw new Error("track_policy requires Copy audio or Custom encode");
    }
    if (trackPolicy?.kind === "audio" && !["mp3", "m4a", "aac", "wav", "flac"].includes(String(v.target))) {
      throw new Error("track_policy requires MP3, M4A, AAC, WAV or FLAC output");
    }
    if (trackPolicy?.kind === "video" && (videoOptions === null || !["mp4", "mov", "mkv"].includes(String(v.target)))) {
      throw new Error("video track_policy requires explicit MP4, MOV or MKV video settings");
    }
    if (imageOptions !== null && v.compress_mode != null) {
      throw new Error("compression and image settings cannot be combined");
    }
    if (imageColorPolicy != null && imageColorPolicy !== "preserve") {
      if (!["jpeg", "png"].includes(String(v.target))) {
        throw new Error("explicit image color handling requires JPEG or PNG output");
      }
      if (v.compress_mode != null) {
        throw new Error("explicit image color handling is available in Convert only");
      }
      if ((v.quality_preset != null && v.quality_preset !== "original")
        || (v.resolution_cap != null && v.resolution_cap !== "original")) {
        throw new Error("explicit image color handling cannot be combined with quality or resolution presets");
      }
      if (v.gif_options != null || v.subtitle != null || videoOptions != null || audioOptions != null || trackPolicy != null) {
        throw new Error("explicit image color handling cannot be combined with media controls");
      }
    }
  } catch (error) {
    throw new PresetParseError(`Preset "${v.name.trim()}": ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    name: v.name.trim(),
    target: v.target as TargetFormat,
    quality_preset: (v.quality_preset as QualityPreset | null | undefined) ?? null,
    resolution_cap: (v.resolution_cap as ResolutionCap | null | undefined) ?? null,
    compress_mode: validateCompressMode(v.compress_mode),
    metadata_policy: validateMetadata(v.metadata_policy, version),
    image_color_policy: imageColorPolicy,
    gif_options: validateGif(v.gif_options),
    subtitle: validateSubtitle(v.subtitle),
    image_options: imageOptions,
    video_options: videoOptions,
    audio_options: audioOptions,
    track_policy: trackPolicy,
  };
}

/**
 * Parse a JSON string into a bundle of preset entries. Throws
 * `PresetParseError` for malformed JSON, unknown versions, or invalid
 * field shapes, including complete nested image settings.
 */
export function parsePresetBundle(raw: string): PresetEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new PresetParseError(
      `not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!isObject(parsed)) {
    throw new PresetParseError("file must contain a JSON object at the top level");
  }
  if (![1, 2, 3, 4, 5, 6, 7, 8, PRESET_BUNDLE_VERSION].includes(Number(parsed.version))) {
    throw new PresetParseError(
      `unsupported bundle version: ${String(parsed.version)} (expected 1 through ${PRESET_BUNDLE_VERSION})`,
    );
  }
  if (!Array.isArray(parsed.presets)) {
    throw new PresetParseError("file is missing the `presets` array");
  }
  const version = Number(parsed.version);
  return parsed.presets.map((entry, idx) => validateEntry(entry, idx, version));
}

/**
 * Convert parsed bundle entries into fresh `Preset` records ready for
 * `api.preset.import` (which handles the wire conversion to IPC shape).
 * Generates new IDs and timestamps; resolves name collisions by
 * appending " (imported)" so duplicates are visible and removable.
 */
export function entriesToPresets(
  entries: readonly PresetEntry[],
  existing: readonly Preset[],
): Preset[] {
  const usedNames = new Set(existing.map((p) => p.name));
  const out: Preset[] = [];
  for (const entry of entries) {
    const name = resolveName(entry.name, usedNames);
    usedNames.add(name);
    out.push({
      id: newPresetId(),
      name,
      target: entry.target,
      quality_preset: entry.quality_preset,
      resolution_cap: entry.resolution_cap,
      compress_mode: entry.compress_mode ? { ...entry.compress_mode } : null,
      metadata_policy: entry.metadata_policy,
      image_color_policy: entry.image_color_policy,
      gif_options: entry.gif_options ? { ...entry.gif_options } : null,
      subtitle: entry.subtitle ? { ...entry.subtitle } : null,
      image_options: cloneImageOptions(entry.image_options),
      video_options: cloneVideoOptions(entry.video_options),
      audio_options: cloneAudioOptions(entry.audio_options),
      track_policy: cloneTrackPolicy(entry.track_policy),
      is_builtin: false,
      // i64 in Rust ↔ bigint in TS; the IPC layer converts to a wire number.
      created_at: BigInt(Date.now()),
    });
  }
  return out;
}

/**
 * Resolve a name collision: first attempt appends " (imported)", then
 * " (imported 2)", " (imported 3)", and so on. The counter form keeps
 * names compact even when the user re-imports the same file repeatedly,
 * unlike compound " (imported) (imported)" growth.
 */
function resolveName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  let candidate = `${base} (imported)`;
  if (!used.has(candidate)) return candidate;
  for (let i = 2; i < 10_000; i += 1) {
    candidate = `${base} (imported ${i})`;
    if (!used.has(candidate)) return candidate;
  }
  // Fallback so we never loop forever on absurd inputs.
  return `${base} (imported ${Date.now()})`;
}
