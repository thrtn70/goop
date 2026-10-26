import type { CompressMode, QualityPreset, TargetFormat } from "@/types";
import type { FileEntry } from "@/features/convert/ConvertActionBar";
import { targetLabel } from "@/features/convert/TargetPicker";
import { isAudioTarget } from "@/features/convert/audioOptions";
import { formatBytes } from "@/features/compress/sizeMath";
import type { BatchKind, KindCounts } from "./batchScope";
import type { BatchState } from "./batchStamp";

export type ConvertLineEntry = Pick<FileEntry, "target" | "imageOptions" | "videoOptions" | "audioOptions" | "gifOptions" | "metadataPolicy" | "imageColorPolicy" | "qualityPreset">;
/** Settings the row's own checks reject for its current target; the line leaves them out. */
export type InvalidSettings = Partial<Record<"image" | "color" | "metadata", boolean>>;

export const WAIT_FOR_INSPECTION = "Wait for every file to finish inspecting.";
export const FIX_SELECTED_FIRST = "Fix this file's settings first.";
export const USE_BATCH_SETTINGS = "Use batch settings";

/** A row line names the format and at most this many facts; metadata goes last, so it drops first. */
const MAX_FACTS = 3;
const VIDEO_TARGETS: ReadonlySet<TargetFormat> = new Set(["mp4", "mkv", "webm", "mov", "avi"]);
const QUALITY_PRESET_NAMES: Record<QualityPreset, string> = { original: "Original quality", fast: "Fast", balanced: "Balanced", small: "Small" };
const GIF_SIZE_NAMES = { small: "Small", medium: "Medium", large: "Large" } as const;
const KINDS = ["image", "video", "audio", "subtitle", "unknown"] as const;
const NOUNS: Record<(typeof KINDS)[number], readonly [string, string]> = {
  image: ["image", "images"],
  video: ["video", "videos"],
  audio: ["audio file", "audio files"],
  subtitle: ["subtitle file", "subtitle files"],
  unknown: ["file", "files"],
};

const codecName = (codec: string) => codec === "hevc" ? "HEVC" : "H.264";
const counted = (n: number, kind: (typeof KINDS)[number]) => `${n} ${NOUNS[kind][n === 1 ? 0 : 1]}`;
const joinList = (items: readonly string[]) => items.length < 2
  ? items[0] ?? ""
  : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
const keptClause = (total: number) => `kept ${total === 1 ? "its" : "their"} settings.`;
const line = (target: TargetFormat, facts: readonly string[]) => [`→ ${targetLabel(target)}`, ...facts.slice(0, MAX_FACTS)].join(" · ");

function imageFacts(entry: ConvertLineEntry, invalid: InvalidSettings): string[] {
  const options = invalid.image ? null : entry.imageOptions;
  const facts = options
    ? [`Quality ${options.jpeg_quality}`, ...(options.resize.kind === "fit_within" ? [`Fit ${options.resize.width} × ${options.resize.height}`] : [])]
    : [];
  return !invalid.color && entry.imageColorPolicy === "convert_to_srgb" ? [...facts, "sRGB"] : facts;
}

function videoFacts(entry: ConvertLineEntry): string[] {
  const options = entry.videoOptions;
  if (!options) {
    if (!VIDEO_TARGETS.has(entry.target)) return [];
    return [entry.qualityPreset ? QUALITY_PRESET_NAMES[entry.qualityPreset] : "Automatic settings"];
  }
  if (options.kind === "copy") return ["Copy video"];
  if (options.kind === "hardware_encode") return [codecName(options.codec), "Hardware", `${options.rate_control.kbps} kbps`];
  const rate = options.rate_control.kind === "constant_quality"
    ? `CRF ${options.rate_control.crf}`
    : `${options.rate_control.kbps} kbps`;
  return [`${codecName(options.codec)} ${rate}`];
}

function audioFacts(entry: ConvertLineEntry): string[] {
  const options = entry.audioOptions;
  if (!options) return isAudioTarget(entry.target) ? ["Automatic settings"] : [];
  if (options.kind === "copy") return ["Copy audio"];
  return [
    ...(options.bitrate ? [`${options.bitrate.kbps} kbps`] : []),
    ...(options.channels.kind === "mono" ? ["Mono"] : options.channels.kind === "stereo" ? ["Stereo"] : []),
    ...(options.sample_rate.kind === "exact" ? [`${options.sample_rate.hz / 1000} kHz`] : []),
  ];
}

function metadataFacts(entry: ConvertLineEntry): string[] {
  if (entry.metadataPolicy === "remove_personal") return ["No personal data"];
  if (entry.metadataPolicy === "strip_all") return ["No metadata"];
  return [];
}

/** What a Convert row will send, in words. Never predicts an output size. */
export function convertSettingsLine(entry: ConvertLineEntry, invalid: InvalidSettings = {}): string {
  return line(entry.target, [
    ...imageFacts(entry, invalid),
    ...videoFacts(entry),
    ...audioFacts(entry),
    ...(entry.gifOptions ? [GIF_SIZE_NAMES[entry.gifOptions.size_preset]] : []),
    ...(invalid.metadata ? [] : metadataFacts(entry)),
  ]);
}

export function compressSettingsLine(entry: { target: TargetFormat; mode: CompressMode }): string {
  const { mode } = entry;
  const fact = mode.kind === "quality"
    ? `Quality ${mode.value}`
    : mode.kind === "target_size_bytes"
      ? `Target ${formatBytes(Number(mode.value))}`
      : "Lossless";
  return line(entry.target, [fact]);
}

export function outputBreakdown(entries: readonly { target: TargetFormat }[]): string {
  const counts = new Map<TargetFormat, number>();
  for (const { target } of entries) counts.set(target, (counts.get(target) ?? 0) + 1);
  // Array.prototype.sort is stable, so ties keep first-appearance order.
  return [...counts].sort((a, b) => b[1] - a[1]).map(([target, n]) => `${n} → ${targetLabel(target)}`).join(" · ");
}

export function applyButtonLabel(kind: BatchKind, scopeSize: number, listSize: number, pending: boolean): string | null {
  if (pending) return "Apply to matching files";
  if (scopeSize < 2) return null;
  return scopeSize === listSize ? `Apply to all ${scopeSize}` : `Apply to ${counted(scopeSize, kind)}`;
}

export function applyTooltip(sourceName: string, kind: BatchKind, all: boolean): string {
  return `Copy ${sourceName}'s settings to every ${all ? "file" : NOUNS[kind][0]} in the list`;
}

export function applyOutcome(applied: number, kind: BatchKind, kept: KindCounts): string {
  const keptTotal = KINDS.reduce((sum, k) => sum + kept[k], 0);
  if (keptTotal === 0) return `Applied to all ${applied} files.`;
  return `Applied to ${counted(applied, kind)}. ${keptTotal} other ${keptTotal === 1 ? "file" : "files"} ${keptClause(keptTotal)}`;
}

export function presetOutcome(presetName: string, applied: KindCounts, kept: KindCounts): string {
  const appliedKinds = KINDS.filter(k => applied[k] > 0);
  const appliedTotal = appliedKinds.reduce((sum, k) => sum + applied[k], 0);
  const target = appliedKinds.length === 1
    ? counted(applied[appliedKinds[0]], appliedKinds[0])
    : `${appliedTotal} files (${appliedKinds.map(k => counted(applied[k], k)).join(", ")})`;
  const keptKinds = KINDS.filter(k => kept[k] > 0);
  if (keptKinds.length === 0) return `Applied ${presetName} to ${target}.`;
  const keptTotal = keptKinds.reduce((sum, k) => sum + kept[k], 0);
  return `Applied ${presetName} to ${target}. ${joinList(keptKinds.map(k => counted(kept[k], k)))} ${keptClause(keptTotal)}`;
}

export function noPresetTarget(target: TargetFormat): string {
  return `None of these files can become ${targetLabel(target)}.`;
}

export function inspectorBatchStatus(state: BatchState, label: string): string | null {
  if (state === "batch") return `Batch settings from ${label}.`;
  if (state === "edited") return "Changed for this file.";
  return null;
}
