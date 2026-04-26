/**
 * Phase K: preset import/export. JSON file format with a top-level
 * version field so future preset shape changes can be migrated without
 * breaking older files. Built-in presets are excluded from export
 * because they're recreated on first launch and shouldn't be shipped
 * across machines.
 */

import type { CompressMode, Preset, QualityPreset, ResolutionCap, TargetFormat } from "@/types";

/** Current bundle schema version. Bump when the shape changes. */
export const PRESET_BUNDLE_VERSION = 1 as const;

// `satisfies readonly T[]` makes TypeScript fail compilation if the
// generated ts-rs union (in shared/types/) ever gains a new variant
// that isn't listed here — preventing silent "unrecognised value"
// rejections of freshly-exported bundles.
const ALL_TARGETS = [
  "mp4",
  "mkv",
  "webm",
  "gif",
  "avi",
  "mov",
  "mp3",
  "m4a",
  "opus",
  "wav",
  "flac",
  "ogg",
  "aac",
  "extract_audio_keep_codec",
  "png",
  "jpeg",
  "webp",
  "bmp",
] as const satisfies readonly TargetFormat[];

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

const VALID_TARGETS: ReadonlySet<TargetFormat> = new Set(ALL_TARGETS);
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
    })),
  };
  return JSON.stringify(bundle, null, 2);
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

function validateCompressMode(v: unknown): CompressMode | null {
  if (v === null || v === undefined) return null;
  if (!isObject(v)) {
    throw new PresetParseError("compress_mode must be an object or null");
  }
  if (v.kind === "lossless_reoptimize") {
    return { kind: "lossless_reoptimize" };
  }
  if (v.kind === "quality" && typeof v.value === "number") {
    return { kind: "quality", value: v.value };
  }
  if (v.kind === "target_size_bytes" && typeof v.value === "number") {
    // Bundle stores number; the IPC boundary converts back to bigint.
    return {
      kind: "target_size_bytes",
      value: BigInt(v.value),
    } as CompressMode;
  }
  throw new PresetParseError(`unsupported compress_mode kind: ${String(v.kind)}`);
}

function validateEntry(v: unknown, index: number): PresetEntry {
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
  return {
    name: v.name.trim(),
    target: v.target as TargetFormat,
    quality_preset: (v.quality_preset as QualityPreset | null | undefined) ?? null,
    resolution_cap: (v.resolution_cap as ResolutionCap | null | undefined) ?? null,
    compress_mode: validateCompressMode(v.compress_mode),
  };
}

/**
 * Parse a JSON string into a bundle of preset entries. Throws
 * `PresetParseError` for malformed JSON, unknown versions, or invalid
 * field shapes. Validation is shallow but covers the user-visible
 * error cases — bad version, empty file, junk payload.
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
  if (parsed.version !== PRESET_BUNDLE_VERSION) {
    throw new PresetParseError(
      `unsupported bundle version: ${String(parsed.version)} (expected ${PRESET_BUNDLE_VERSION})`,
    );
  }
  if (!Array.isArray(parsed.presets)) {
    throw new PresetParseError("file is missing the `presets` array");
  }
  return parsed.presets.map((entry, idx) => validateEntry(entry, idx));
}

/**
 * Convert parsed bundle entries into fresh `Preset` records ready for
 * `api.preset.save` (which handles the wire conversion to IPC shape).
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
      compress_mode: entry.compress_mode,
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
