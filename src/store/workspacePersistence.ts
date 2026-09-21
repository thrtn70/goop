import { validateVideoOptions, videoDraftSlots } from "@/features/convert/videoOptions";
import { validateAudioOptions } from "@/features/convert/audioOptions";
import { validateImageAlphaPolicy } from "@/features/convert/imageAlphaPolicy";
import { parsePresetBundle, PRESET_BUNDLE_VERSION } from "@/features/presets/io";
import {
  getResponsivenessRecorder,
  type CausalOwner,
  type ResponsivenessRecorder,
} from "@/performance/responsiveness";
import type { TrackConvertOptions, TrackDispositionFacts, TrackIdentity, TrackInventory, TrackPresetPolicy, TrackSourceBinding, TrackStreamPolicy, TrackTextFact } from "@/types";

export type DraftEntries = Record<string, { value: unknown }>;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
export const DRAFT_STORAGE_KEY = "goop.workspace-drafts.v1";
const MAX_BYTES = 512 * 1024;
const TOOLS = new Set(["extract", "convert", "compress", "image", "metadata", "recognize"]);
const SLOTS = new Set<string>([...videoDraftSlots,"ImageOptionsPanel.qualityDraft", "ImageOptionsPanel.widthDraft", "ImageOptionsPanel.heightDraft", "ImageOptionsPanel.appliedQuality", "ImageOptionsPanel.appliedWidth", "ImageOptionsPanel.appliedHeight", "AudioBatchEditor.album", "AudioBatchEditor.albumArtist", "AudioBatchEditor.artist", "AudioBatchEditor.backup", "AudioBatchEditor.comment", "AudioBatchEditor.composer", "AudioBatchEditor.cover", "AudioBatchEditor.disc", "AudioBatchEditor.genre", "AudioBatchEditor.titles", "AudioBatchEditor.tracks", "AudioBatchEditor.year", "AudioTagForm.album", "AudioTagForm.albumArtist", "AudioTagForm.artist", "AudioTagForm.backup", "AudioTagForm.comment", "AudioTagForm.composer", "AudioTagForm.cover", "AudioTagForm.disc", "AudioTagForm.genre", "AudioTagForm.title", "AudioTagForm.track", "AudioTagForm.year", "CompressActionBar.overrideDir", "CompressControls.appliedMode", "CompressControls.sizeInput", "CompressControls.sizeUnit", "CompressPage.files", "CompressPage.pdfs", "CompressPage.selectedId", "ConvertActionBar.overrideDir", "ConvertPage.files", "ConvertPage.pdfs", "ConvertPage.selectedId", "CropEditor.aspect", "CropEditor.crop", "CropEditor.zoom", "GifOptionsPanel.appliedEnd", "GifOptionsPanel.appliedStart", "GifOptionsPanel.endDraft", "GifOptionsPanel.startDraft", "ImageAppIconFlow.selected", "ImageCropFlow.rect", "ImageOcrFlow.images", "ImageOcrFlow.lang", "ImageOcrFlow.outputKind", "ImagePage.files", "ImagePage.op", "ImageRecompressFlow.quality", "ImageResizeFlow.height", "ImageResizeFlow.mode", "ImageResizeFlow.scale", "ImageResizeFlow.width", "ImageRotateFlow.degrees", "ImageWatermarkFlow.opacity", "ImageWatermarkFlow.position", "ImageWatermarkFlow.text", "ImagesToPdfFlow.images", "MetadataPage.files", "PdfDeleteFlow.pages", "PdfExtractFlow.ranges", "PdfFlow.op", "PdfFlow.quality", "PdfFlow.ranges", "PdfInsertBlankFlow.draft", "PdfInsertBlankFlow.positions", "PdfMetadataForm.author", "PdfMetadataForm.keywords", "PdfMetadataForm.subject", "PdfMetadataForm.title", "PdfOcrFlow.lang", "PdfReorderFlow.pages", "PdfRotateFlow.pages", "PdfSplitEditor.input", "PdfToImagesFlow.dpi", "PdfToImagesFlow.format", "ProbeCard.audioOnly", "ProbeCard.selected", "RecognizePage.input", "RecognizePage.lang", "RecognizePage.outputKind", "TopBar.url", "UrlHero.lastUrl"]);
SLOTS.add("AudioOptionsPanel.savedCustom");
SLOTS.add("AudioOptionsPanel.bitrateDraft");
SLOTS.add("AudioOptionsPanel.appliedBitrate");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.length <= 4096);
const textBytes = (value: string) => new TextEncoder().encode(value).length;
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

function trackTextFact(value: unknown): TrackTextFact {
  if (!object(value) || typeof value.kind !== "string") throw new Error("invalid track text fact");
  if (value.kind === "missing" || value.kind === "malformed") {
    if (!exactKeys(value, ["kind"])) throw new Error("invalid track text fact fields");
    return { kind: value.kind };
  }
  if (value.kind === "value" && exactKeys(value, ["kind", "value"]) && typeof value.value === "string" && textBytes(value.value) <= 512) {
    return { kind: "value", value: value.value };
  }
  throw new Error("invalid track text fact");
}

function trackDisposition(value: unknown): TrackDispositionFacts {
  if (!object(value) || !exactKeys(value, ["default", "forced", "attached_pic", "other", "malformed"]) ||
    ![value.default, value.forced, value.attached_pic].every(item => item === null || typeof item === "boolean") ||
    typeof value.malformed !== "boolean" || !object(value.other)) throw new Error("invalid track disposition");
  const other: Array<[string, boolean]> = [];
  for (const [name, enabled] of Object.entries(value.other)) {
    if (textBytes(name) > 512 || typeof enabled !== "boolean") throw new Error("invalid track disposition fact");
    other.push([name, enabled]);
  }
  return {
    default: value.default as boolean | null,
    forced: value.forced as boolean | null,
    attached_pic: value.attached_pic as boolean | null,
    other: Object.fromEntries(other),
    malformed: value.malformed,
  };
}

function trackIdentity(value: unknown): TrackIdentity {
  if (!object(value) || !exactKeys(value, ["index", "codec_type", "codec_name", "container_stream_id", "language", "title", "disposition"]) ||
    !Number.isInteger(value.index) || Number(value.index) < 0 || Number(value.index) > 0xffff_ffff ||
    typeof value.codec_type !== "string" || textBytes(value.codec_type) > 512) throw new Error("invalid track identity");
  return {
    index: Number(value.index),
    codec_type: value.codec_type,
    codec_name: trackTextFact(value.codec_name),
    container_stream_id: trackTextFact(value.container_stream_id),
    language: trackTextFact(value.language),
    title: trackTextFact(value.title),
    disposition: trackDisposition(value.disposition),
  };
}

function trackInventory(value: unknown): TrackInventory {
  if (!object(value) || !exactKeys(value, ["version", "streams"]) || value.version !== 1 || !Array.isArray(value.streams) || value.streams.length > 128) throw new Error("invalid track inventory");
  const streams = value.streams.map(trackIdentity);
  if (streams.some((stream, index) => index > 0 && streams[index - 1].index >= stream.index)) throw new Error("track indices must be unique and ordered");
  return { version: 1, streams };
}

function canonicalU64(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  try { return BigInt(value) <= 0xffff_ffff_ffff_ffffn; } catch { return false; }
}

function trackSource(value: unknown): TrackSourceBinding {
  if (!object(value) || !exactKeys(value, ["version", "canonical_path", "size_bytes", "modified_unix_ns", "inventory"]) ||
    value.version !== 1 || typeof value.canonical_path !== "string" || !canonicalU64(value.size_bytes) || !canonicalU64(value.modified_unix_ns)) throw new Error("invalid track source binding");
  const source: TrackSourceBinding = {
    version: 1,
    canonical_path: value.canonical_path,
    size_bytes: value.size_bytes,
    modified_unix_ns: value.modified_unix_ns,
    inventory: trackInventory(value.inventory),
  };
  if (new TextEncoder().encode(JSON.stringify(source)).length > 64 * 1024) throw new Error("track source binding is too large");
  return source;
}

export function validateTrackOptions(value: unknown): TrackConvertOptions | null {
  if (value == null) return null;
  if (!object(value) || typeof value.kind !== "string") throw new Error("invalid track options");
  if (value.kind === "video") {
    if (!exactKeys(value, ["kind", "source", "audio", "subtitles"])) throw new Error("invalid video track options");
    const source = trackSource(value.source);
    const ordinaryVideos = source.inventory.streams.filter(stream => stream.codec_type === "video" && stream.disposition.attached_pic !== true);
    if (ordinaryVideos.length !== 1) throw new Error("video track options require exactly one ordinary video stream");
    const policy = (candidate: unknown, family: "audio" | "subtitle"): TrackStreamPolicy => {
      if (!object(candidate) || typeof candidate.kind !== "string") throw new Error("invalid video track policy");
      if (candidate.kind === "keep_all" || candidate.kind === "none") {
        if (!exactKeys(candidate, ["kind"])) throw new Error("invalid video track policy fields");
        return { kind: candidate.kind };
      }
      if (candidate.kind !== "choose" || !exactKeys(candidate, ["kind", "stream_indices"]) || !Array.isArray(candidate.stream_indices) || candidate.stream_indices.length === 0 ||
        candidate.stream_indices.some(index => !Number.isInteger(index) || Number(index) < 0 || Number(index) > 0xffff_ffff)) throw new Error("invalid video track choice");
      const indices = candidate.stream_indices.map(Number);
      if (new Set(indices).size !== indices.length) throw new Error("duplicate video track choice");
      const selected = source.inventory.streams.filter(stream => stream.codec_type === family && indices.includes(stream.index)).map(stream => stream.index);
      if (selected.length !== indices.length || selected.some((index, position) => index !== indices[position])) throw new Error("video track choice must name its family in source order");
      return { kind: "choose", stream_indices: indices };
    };
    return { kind: "video", source, audio: policy(value.audio, "audio"), subtitles: policy(value.subtitles, "subtitle") };
  }
  if (!exactKeys(value, ["kind", "source", "stream_index"]) || value.kind !== "audio" ||
    !Number.isInteger(value.stream_index) || Number(value.stream_index) < 0 || Number(value.stream_index) > 0xffff_ffff) throw new Error("invalid track options");
  const source = trackSource(value.source);
  const selected = source.inventory.streams.find(stream => stream.index === value.stream_index);
  if (!selected || selected.codec_type !== "audio") throw new Error("selected track is not an audio stream in the source inventory");
  return { kind: "audio", source, stream_index: Number(value.stream_index) };
}

function validateVideoTrackPolicyDraft(value: unknown): void {
  if (value == null) return;
  if (!object(value) || !exactKeys(value, ["source", "audio", "subtitles"])) throw new Error("invalid video track policy draft");
  const withKind = { kind: "video", source: value.source, audio: value.audio, subtitles: value.subtitles };
  const allowEmpty = (candidate: unknown) => object(candidate) && exactKeys(candidate, ["kind", "stream_indices"]) && candidate.kind === "choose" && Array.isArray(candidate.stream_indices) && candidate.stream_indices.length === 0;
  if (allowEmpty(value.audio) || allowEmpty(value.subtitles)) {
    const replacement = (candidate: unknown) => allowEmpty(candidate) ? { kind: "none" } : candidate;
    validateTrackOptions({ ...withKind, audio: replacement(value.audio), subtitles: replacement(value.subtitles) });
  } else {
    validateTrackOptions(withKind);
  }
}

export function cloneTrackOptions(value: TrackConvertOptions | null | undefined): TrackConvertOptions | null {
  return validateTrackOptions(value);
}

function validateTrackPolicy(value: unknown): TrackPresetPolicy | null {
  if (value == null) return null;
  if (!object(value) || typeof value.kind !== "string") throw new Error("invalid pending track policy");
  if (value.kind === "audio") {
    if (!exactKeys(value, ["kind", "selection"]) || !object(value.selection) || !exactKeys(value.selection, ["kind"]) || value.selection.kind !== "choose_per_file") throw new Error("invalid pending audio policy");
    return { kind: "audio", selection: { kind: "choose_per_file" } };
  }
  if (value.kind !== "video" || !exactKeys(value, ["kind", "audio", "subtitles"])) throw new Error("invalid pending video policy");
  const stream = (candidate: unknown) => {
    if (!object(candidate) || !exactKeys(candidate, ["kind"]) || !["keep_all", "choose_per_file", "none"].includes(String(candidate.kind))) throw new Error("invalid pending video stream policy");
    return { kind: candidate.kind as "keep_all" | "choose_per_file" | "none" };
  };
  return { kind: "video", audio: stream(value.audio), subtitles: stream(value.subtitles) };
}

function bounded(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (value == null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 65536;
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => bounded(item, depth + 1));
  if (!object(value)) return false;
  return Object.keys(value).length <= 1000 && Object.entries(value).every(([key, item]) => !["__proto__", "prototype", "constructor"].includes(key) && bounded(item, depth + 1));
}

function validFiles(value: unknown, compress: boolean): boolean {
  if (!Array.isArray(value)) return false;
  return value.every(file => {
    if (!object(file) || typeof file.path !== "string" || !file.path || typeof file.sourceDir !== "string" || (file.id != null && typeof file.id !== "string") || (file.revision != null && (!Number.isSafeInteger(file.revision) || Number(file.revision) < 0))) return false;
    try {
      parsePresetBundle(JSON.stringify({version:PRESET_BUNDLE_VERSION, presets:[{name:"Draft", target:file.target,
        quality_preset:file.qualityPreset, resolution_cap:file.resolutionCap,
        compress_mode:compress ? file.mode : null, gif_options:file.gifOptions,
        metadata_policy:file.metadataPolicy, image_color_policy:file.imageColorPolicy,
        image_alpha_policy:null,
        subtitle:file.subtitle, image_options:file.imageOptions}]}));
      // Drafts retain hidden Automatic quality and temporarily incompatible targets.
      // Validate explicit shape independently; submission performs strict admission.
      validateImageAlphaPolicy(file.imageAlphaPolicy);
      validateAudioOptions(file.audioOptions);
      validateVideoOptions(file.videoOptions);
      validateTrackOptions(file.trackOptions);
      validateTrackPolicy(file.pendingTrackPolicy);
      validateVideoTrackPolicyDraft(file.videoTrackPolicyDraft);
      if (file.videoTrackOptionsEnabled !== undefined && typeof file.videoTrackOptionsEnabled !== "boolean") throw new Error("invalid video track opt-in marker");
      return !compress || file.mode != null;
    } catch { return false; }
  });
}

function validSlot(slot: string, value: unknown): boolean {
  if (slot === "AudioOptionsPanel.savedCustom") {
    try { const options = validateAudioOptions(value); return options === null || options.kind === "encode"; } catch { return false; }
  }
  if (slot === "VideoOptionsPanel.savedCustom") {
    try { const options = validateVideoOptions(value); return options === null || options.kind === "encode"; } catch { return false; }
  }
  if (slot === "ConvertPage.files") return validFiles(value, false);
  if (slot === "CompressPage.files") return validFiles(value, true);
  if (["ImagePage.files", "MetadataPage.files", "ConvertPage.pdfs", "CompressPage.pdfs", "ImagesToPdfFlow.images", "ImageOcrFlow.images"].includes(slot)) return strings(value);
  if (slot === "ImageAppIconFlow.selected") return object(value) && strings(value.set) && value.set.every(platform => ["macos", "windows", "web"].includes(platform));
  if (slot.endsWith(".pages")) return Array.isArray(value) && value.every(page => object(page) && Number.isSafeInteger(page.originalPage) && typeof page.deleted === "boolean" && typeof page.rotation === "number" && [0,90,180,270].includes(page.rotation));
  if (slot.endsWith(".ranges")) return Array.isArray(value) && value.every(range => object(range) && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && Number(range.start) >= 1 && Number(range.end) >= Number(range.start));
  if (slot === "PdfInsertBlankFlow.positions") return Array.isArray(value) && value.every(position => Number.isSafeInteger(position) && position >= 0);
  if (slot.endsWith(".cover")) return object(value) && ["keep", "remove", "replace"].includes(String(value.kind)) && (value.kind !== "replace" || typeof value.source_path === "string");
  if (["AudioBatchEditor.titles", "AudioBatchEditor.tracks"].includes(slot)) return object(value) && Object.values(value).every(item => typeof item === "string");
  if (slot === "CropEditor.crop" || slot === "ImageCropFlow.rect") {
    if (slot === "ImageCropFlow.rect" && value === null) return true;
    return object(value) && (slot === "CropEditor.crop" ? ["x", "y"] : ["x", "y", "width", "height"]).every(field => typeof value[field] === "number" && Number.isFinite(value[field]));
  }
  if (["ProbeCard.audioOnly", "AudioBatchEditor.backup", "AudioTagForm.backup"].includes(slot)) return typeof value === "boolean";
  if (["CropEditor.zoom", "ImageRecompressFlow.quality", "ImageResizeFlow.height", "ImageResizeFlow.scale", "ImageResizeFlow.width", "ImageWatermarkFlow.opacity", "PdfToImagesFlow.dpi"].includes(slot)) return typeof value === "number" && Number.isFinite(value);
  if (["ConvertPage.selectedId", "CompressPage.selectedId", "ConvertActionBar.overrideDir", "CompressActionBar.overrideDir", "ProbeCard.selected", "RecognizePage.input", "UrlHero.lastUrl"].includes(slot)) return value === null || typeof value === "string";
  return typeof value === "string";
}

function normalizeSlotValue(slot: string, value: unknown): unknown {
  if (!["ConvertPage.files", "CompressPage.files"].includes(slot) || !Array.isArray(value)) return value;
  return value.map((file) => {
    if (!object(file)) return file;
    const imageTarget = ["png", "jpeg", "webp", "bmp", "tiff", "avif", "jpeg_xl"].includes(String(file.target));
    const normalized = {
      ...file,
      ...(imageTarget && file.metadataPolicy == null ? { metadataPolicy: "preserve" } : {}),
      ...(imageTarget && file.imageColorPolicy == null ? { imageColorPolicy: "preserve" } : {}),
    };
    if (slot !== "CompressPage.files" || !object(file.mode) || file.mode.kind !== "target_size_bytes") {
      return normalized;
    }
    return {
      ...normalized,
      mode: { kind: "target_size_bytes", value: BigInt(file.mode.value as number) },
    };
  });
}

function encodeDraftEntriesWithSize(entries: DraftEntries): { raw: string; encodedBytes: number } {
  const raw = JSON.stringify({version:1, entries}, (_key, value: unknown) => {
    if (typeof value === "bigint") {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error("Draft number is too large");
      return number;
    }
    if (value instanceof Set) return {set:[...value]};
    return value;
  });
  const encodedBytes = new TextEncoder().encode(raw).length;
  if (raw.length > MAX_BYTES || encodedBytes > MAX_BYTES || Object.keys(entries).length > 500) throw new Error("Draft storage limit reached");
  return { raw, encodedBytes };
}

export function encodeDraftEntries(entries: DraftEntries): string {
  return encodeDraftEntriesWithSize(entries).raw;
}

export function decodeDraftEntries(raw: string): DraftEntries {
  try {
    if (raw.length > MAX_BYTES || new TextEncoder().encode(raw).length > MAX_BYTES) return {};
    const data: unknown = JSON.parse(raw);
    if (!object(data) || data.version !== 1 || !object(data.entries) || Object.keys(data.entries).length > 500) return {};
    const entries: DraftEntries = {};
    for (const [key, entry] of Object.entries(data.entries)) {
      let parts: unknown;
      try { parts = JSON.parse(key); } catch { continue; }
      if (!strings(parts) || parts.length < 2 || parts.length > 20 || !TOOLS.has(parts[0])) continue;
      const slot = parts[parts.length - 1];
      if (!SLOTS.has(slot) || !object(entry) || !bounded(entry.value) || !validSlot(slot, entry.value)) continue;
      const value = slot === "ImageAppIconFlow.selected"
        ? new Set((entry.value as {set:string[]}).set)
        : normalizeSlotValue(slot, entry.value);
      entries[key] = {value};
    }
    return entries;
  } catch { return {}; }
}

export function loadBrowserDraftEntries(): DraftEntries {
  try { return typeof window === "undefined" ? {} : loadDraftEntries(window.localStorage); } catch { return {}; }
}
export function loadDraftEntries(storage: Storage): DraftEntries {
  try { return decodeDraftEntries(storage.getItem(DRAFT_STORAGE_KEY) ?? ""); } catch { return {}; }
}

export type DraftPersistenceResult =
  | { ok: true; encoded_bytes: number }
  | { ok: false; phase: "encode" | "write" };

function closeFailedPersistence(
  recorder: ResponsivenessRecorder,
  owner: CausalOwner | null,
  spanId: number | null,
) {
  if (spanId !== null) recorder.cancelSpan(spanId);
  if (owner !== null) recorder.cancelSetup(owner);
}

/**
 * One authoritative persistence attempt:
 *
 * encode -> write -> structured outcome -> boolean compatibility wrapper
 *    |         |             |
 *    +---------+-------------+-- recorder evidence never changes the result
 */
export function persistDraftEntries(
  storage: Storage,
  entries: DraftEntries,
  recorder: ResponsivenessRecorder,
): DraftPersistenceResult {
  const owner = recorder.startSetup("workspace_drafts");
  const encodeSpan = owner === null ? null : recorder.startSpan({
    owner,
    kind: "draft_encode",
    subjectId: "workspace_drafts",
  });
  let encoded: { raw: string; encodedBytes: number };
  try {
    encoded = encodeDraftEntriesWithSize(entries);
  } catch {
    closeFailedPersistence(recorder, owner, encodeSpan);
    return { ok: false, phase: "encode" };
  }
  if (encodeSpan !== null) recorder.endSpan(encodeSpan);

  const writeSpan = owner === null ? null : recorder.startSpan({
    owner,
    kind: "storage_write",
    subjectId: "workspace_drafts",
  });
  try {
    storage.setItem(DRAFT_STORAGE_KEY, encoded.raw);
  } catch {
    closeFailedPersistence(recorder, owner, writeSpan);
    return { ok: false, phase: "write" };
  }
  if (writeSpan !== null) recorder.endSpan(writeSpan);
  if (owner !== null) recorder.settleSetup(owner);
  return { ok: true, encoded_bytes: encoded.encodedBytes };
}

export function saveDraftEntries(storage: Storage, entries: DraftEntries): boolean {
  return persistDraftEntries(storage, entries, getResponsivenessRecorder()).ok;
}
