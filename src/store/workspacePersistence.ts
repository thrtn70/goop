import { parsePresetBundle } from "@/features/presets/io";

export type DraftEntries = Record<string, { value: unknown }>;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
export const DRAFT_STORAGE_KEY = "goop.workspace-drafts.v1";
const MAX_BYTES = 512 * 1024;
const TOOLS = new Set(["extract", "convert", "compress", "image", "metadata", "recognize"]);
const SLOTS = new Set<string>(["AudioBatchEditor.album", "AudioBatchEditor.albumArtist", "AudioBatchEditor.artist", "AudioBatchEditor.backup", "AudioBatchEditor.comment", "AudioBatchEditor.composer", "AudioBatchEditor.cover", "AudioBatchEditor.disc", "AudioBatchEditor.genre", "AudioBatchEditor.titles", "AudioBatchEditor.tracks", "AudioBatchEditor.year", "AudioTagForm.album", "AudioTagForm.albumArtist", "AudioTagForm.artist", "AudioTagForm.backup", "AudioTagForm.comment", "AudioTagForm.composer", "AudioTagForm.cover", "AudioTagForm.disc", "AudioTagForm.genre", "AudioTagForm.title", "AudioTagForm.track", "AudioTagForm.year", "CompressActionBar.overrideDir", "CompressControls.appliedMode", "CompressControls.sizeInput", "CompressControls.sizeUnit", "CompressPage.files", "CompressPage.pdfs", "CompressPage.selectedId", "ConvertActionBar.overrideDir", "ConvertPage.files", "ConvertPage.pdfs", "ConvertPage.selectedId", "CropEditor.aspect", "CropEditor.crop", "CropEditor.zoom", "GifOptionsPanel.appliedEnd", "GifOptionsPanel.appliedStart", "GifOptionsPanel.endDraft", "GifOptionsPanel.startDraft", "ImageAppIconFlow.selected", "ImageCropFlow.rect", "ImageOcrFlow.images", "ImageOcrFlow.lang", "ImageOcrFlow.outputKind", "ImagePage.files", "ImagePage.op", "ImageRecompressFlow.quality", "ImageResizeFlow.height", "ImageResizeFlow.mode", "ImageResizeFlow.scale", "ImageResizeFlow.width", "ImageRotateFlow.degrees", "ImageWatermarkFlow.opacity", "ImageWatermarkFlow.position", "ImageWatermarkFlow.text", "ImagesToPdfFlow.images", "MetadataPage.files", "PdfDeleteFlow.pages", "PdfExtractFlow.ranges", "PdfFlow.op", "PdfFlow.quality", "PdfFlow.ranges", "PdfInsertBlankFlow.draft", "PdfInsertBlankFlow.positions", "PdfMetadataForm.author", "PdfMetadataForm.keywords", "PdfMetadataForm.subject", "PdfMetadataForm.title", "PdfOcrFlow.lang", "PdfReorderFlow.pages", "PdfRotateFlow.pages", "PdfSplitEditor.input", "PdfToImagesFlow.dpi", "PdfToImagesFlow.format", "ProbeCard.audioOnly", "ProbeCard.selected", "RecognizePage.input", "RecognizePage.lang", "RecognizePage.outputKind", "TopBar.url", "UrlHero.lastUrl"]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.length <= 4096);

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
      parsePresetBundle(JSON.stringify({version:1, presets:[{name:"Draft", target:file.target,
        quality_preset:file.qualityPreset, resolution_cap:file.resolutionCap,
        compress_mode:compress ? file.mode : null, gif_options:file.gifOptions,
        metadata_policy:file.metadataPolicy, subtitle:file.subtitle}]}));
      return !compress || file.mode != null;
    } catch { return false; }
  });
}

function validSlot(slot: string, value: unknown): boolean {
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

export function encodeDraftEntries(entries: DraftEntries): string {
  const raw = JSON.stringify({version:1, entries}, (_key, value: unknown) => {
    if (typeof value === "bigint") {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error("Draft number is too large");
      return number;
    }
    if (value instanceof Set) return {set:[...value]};
    return value;
  });
  if (raw.length > MAX_BYTES || new TextEncoder().encode(raw).length > MAX_BYTES || Object.keys(entries).length > 500) throw new Error("Draft storage limit reached");
  return raw;
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
      const value = slot === "ImageAppIconFlow.selected" ? new Set((entry.value as {set:string[]}).set) : entry.value;
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
export function saveDraftEntries(storage: Storage, entries: DraftEntries): boolean {
  try { storage.setItem(DRAFT_STORAGE_KEY, encodeDraftEntries(entries)); return true; } catch { return false; }
}
