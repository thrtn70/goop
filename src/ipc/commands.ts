import { invoke } from "@tauri-apps/api/core";
import type {
  ConvertRequest,
  CropRect,
  ExtractRequest,
  HistoryCounts,
  HistoryFilter,
  IconPlatform,
  ImageDecoderStatus,
  ImageOcrOutput,
  ImageOperation,
  Job,
  JobId,
  LanguagePack,
  MetadataOperation,
  MetadataView,
  MetadataWriteItem,
  PageRange,
  PageRotation,
  PdfImageFormat,
  PdfMetadata,
  PdfOperation,
  PdfProbeResult,
  PdfQuality,
  Preset,
  ProbeResult,
  ResizeMode,
  RotationDegrees,
  Settings,
  SettingsPatch,
  SidecarStatus,
  UpdateInfo,
  UpdateStatus,
  UrlProbe,
  WatermarkSpec,
} from "@/types";

// The ts-rs-generated `CompressMode` declares `value: bigint` for
// `target_size_bytes` because u64 round-trips as bigint in JS. But Tauri
// serializes IPC payloads via JSON.stringify, which throws on bigint. The
// Rust side deserializes a plain JSON number into u64 fine, so the wire
// type uses number. Callers normalize at the boundary and `api.convert.fromFile`
// accepts the wire shape.
export type IpcCompressMode =
  | { kind: "quality"; value: number }
  | { kind: "lossless_reoptimize" }
  | { kind: "target_size_bytes"; value: number };

export type IpcConvertRequest = Omit<ConvertRequest, "compress_mode"> & {
  compress_mode: IpcCompressMode | null;
};

// `direct` is optional on the wire: the Rust `ExtractRequest` defaults it
// (`#[serde(default)]`), so a normal extract can omit it. A direct-file
// download sets `direct: true`. `cookies_from_browser` is carried by the
// base `Omit<>`.
export type IpcExtractRequest = Omit<ExtractRequest, "direct"> & {
  direct?: boolean;
};

/** Allowlisted targets for `update.openAboutLink` — keep in sync with the
 *  match arms in `src-tauri/src/commands/update.rs::open_about_link`. */
export type AboutLinkTarget =
  | "repo"
  | "issues"
  | "license"
  | "yt-dlp"
  | "gallery-dl"
  | "ffmpeg"
  | "ghostscript"
  | "tauri";

// Same bigint-at-boundary story as IpcCompressMode: Preset.created_at is i64
// in Rust (bigint in generated TS) but flows through JSON as a plain number.
export type IpcPreset = Omit<Preset, "created_at" | "compress_mode"> & {
  created_at: number;
  compress_mode: IpcCompressMode | null;
};

function presetToIpc(p: Preset): IpcPreset {
  return {
    ...p,
    created_at: Number(p.created_at),
    compress_mode:
      p.compress_mode === null
        ? null
        : p.compress_mode.kind === "target_size_bytes"
          ? { kind: "target_size_bytes", value: Number(p.compress_mode.value) }
          : p.compress_mode,
  };
}

// LanguagePack.size_bytes is u64 in Rust → bigint in the ts-rs-generated
// type, but Tauri serializes u64 as a plain JSON number on the wire, so
// the value the frontend receives is actually a JS number. Shim to a
// number-typed mirror at the IPC boundary so consumers can do arithmetic
// without dancing around BigInt vs Number coercion.
export type IpcLanguagePack = Omit<LanguagePack, "size_bytes"> & {
  size_bytes: number;
};

export const api = {
  convert: {
    probe: (path: string) => invoke<ProbeResult>("convert_probe", { path }),
    fromFile: (req: IpcConvertRequest) =>
      invoke<JobId>("convert_from_file", { req }),
  },
  extract: {
    probe: (url: string) => invoke<UrlProbe>("extract_probe", { url }),
    fromUrl: (req: IpcExtractRequest) => invoke<JobId>("extract_from_url", { req }),
  },
  queue: {
    list: () => invoke<Job[]>("queue_list"),
    cancel: (jobId: JobId) => invoke<void>("queue_cancel", { jobId }),
    cancelMany: (jobIds: JobId[]) => invoke<number>("queue_cancel_many", { jobIds }),
    pause: (jobId: JobId) => invoke<void>("queue_pause", { jobId }),
    resume: (jobId: JobId) => invoke<void>("queue_resume", { jobId }),
    reorder: (orderedIds: JobId[]) => invoke<number>("queue_reorder", { orderedIds }),
    moveToTop: (jobId: JobId) => invoke<number>("queue_move_to_top", { jobId }),
    clearCompleted: () => invoke<number>("queue_clear_completed"),
    completedSince: (sinceMs: number) =>
      invoke<number>("queue_completed_since", { sinceMs }),
    reveal: (path: string) => invoke<void>("queue_reveal", { path }),
  },
  sidecar: {
    status: () => invoke<SidecarStatus>("sidecar_status"),
    updateYtDlp: () => invoke<UpdateStatus>("sidecar_update_yt_dlp"),
    updateGalleryDl: () => invoke<UpdateStatus>("sidecar_update_gallery_dl"),
    ytDlpVersion: () => invoke<string>("sidecar_yt_dlp_version"),
    galleryDlVersion: () => invoke<string>("sidecar_gallery_dl_version"),
    ffmpegVersion: () => invoke<string>("sidecar_ffmpeg_version"),
    ghostscriptVersion: () => invoke<string>("sidecar_ghostscript_version"),
    mutoolVersion: () => invoke<string>("sidecar_mutool_version"),
    tesseractVersion: () => invoke<string>("sidecar_tesseract_version"),
    // tessdata* return IpcLanguagePack to expose size_bytes as `number`
    // (the wire reality) rather than the bigint the ts-rs-generated
    // LanguagePack claims. See IpcLanguagePack comment above.
    tessdataInstalled: () =>
      invoke<IpcLanguagePack[]>("sidecar_tessdata_installed"),
    tessdataAvailable: () =>
      invoke<IpcLanguagePack[]>("sidecar_tessdata_available"),
    tessdataDownload: (code: string) =>
      invoke<UpdateStatus>("sidecar_tessdata_download", { code }),
    tessdataRemove: (code: string) =>
      invoke<void>("sidecar_tessdata_remove", { code }),
  },
  settings: {
    get: () => invoke<Settings>("settings_get"),
    set: (patch: SettingsPatch) => invoke<Settings>("settings_set", { patch }),
  },
  preset: {
    list: () => invoke<Preset[]>("preset_list"),
    save: (preset: Preset) =>
      invoke<Preset>("preset_save", { preset: presetToIpc(preset) }),
    delete: (id: string) => invoke<void>("preset_delete", { id }),
  },
  update: {
    check: () => invoke<UpdateInfo | null>("check_for_update"),
    download: (url: string) => invoke<void>("download_update", { url }),
    openReleasesPage: () => invoke<void>("open_releases_page"),
    openAboutLink: (target: AboutLinkTarget) =>
      invoke<void>("open_about_link", { target }),
  },
  pdf: {
    probe: (path: string) => invoke<PdfProbeResult>("pdf_probe", { path }),
    run: (op: PdfOperation) => invoke<JobId>("pdf_run", { op }),
    pageThumbs: (path: string) => invoke<string[]>("pdf_page_thumbs", { path }),
    // Read-only preview of a completed Recognize job's output. Returns
    // the .txt contents directly, or the extracted text layer of a
    // searchable PDF. Capped server-side. See commands/pdf.rs.
    recognizePeekText: (path: string) =>
      invoke<string>("recognize_peek_text", { path }),
  },
  image: {
    run: (op: ImageOperation) => invoke<JobId>("image_run", { op }),
    decoders: () => invoke<ImageDecoderStatus>("image_decoders"),
  },
  metadata: {
    // Synchronous-feeling read of one or more files' metadata (no job
    // queued). Never rejects per file — a failed read comes back as a
    // MetadataView carrying an `Error` raw tag. See commands/metadata.rs.
    read: (paths: string[]) =>
      invoke<MetadataView[]>("metadata_read", { paths }),
    // Enqueue a batch metadata write as a single JobKind::Metadata job.
    run: (op: MetadataOperation) => invoke<JobId>("metadata_run", { op }),
  },
  history: {
    list: (filter: HistoryFilter) => invoke<Job[]>("history_list", { filter }),
    counts: () => invoke<HistoryCounts>("history_counts"),
  },
  thumbnail: {
    get: (jobId: JobId) => invoke<string>("thumbnail_get", { jobId }),
  },
  file: {
    moveToTrash: (path: string) => invoke<void>("file_move_to_trash", { path }),
  },
  job: {
    forget: (jobId: JobId) => invoke<void>("job_forget", { jobId }),
    forgetMany: (ids: JobId[]) => invoke<number>("job_forget_many", { ids }),
  },
} as const;

// Helper: build a merge PdfOperation. Convenience for the frontend since
// PdfOperation is a discriminated union and inline construction is wordy.
export function pdfMerge(inputs: string[], outputPath: string): PdfOperation {
  return { kind: "merge", inputs, output_path: outputPath };
}

export function pdfSplit(
  input: string,
  ranges: PageRange[],
  outputDir: string,
): PdfOperation {
  return { kind: "split", input, ranges, output_dir: outputDir };
}

export function pdfCompress(
  input: string,
  outputPath: string,
  quality: PdfQuality,
): PdfOperation {
  return { kind: "compress", input, output_path: outputPath, quality };
}

export function pdfExtractPages(
  input: string,
  ranges: PageRange[],
  outputPath: string,
): PdfOperation {
  return { kind: "extract_pages", input, ranges, output_path: outputPath };
}

export function pdfRotate(
  input: string,
  rotations: PageRotation[],
  outputPath: string,
): PdfOperation {
  return { kind: "rotate", input, rotations, output_path: outputPath };
}

export function pdfReorder(
  input: string,
  order: number[],
  outputPath: string,
): PdfOperation {
  return { kind: "reorder", input, order, output_path: outputPath };
}

export function pdfDeletePages(
  input: string,
  pages: number[],
  outputPath: string,
): PdfOperation {
  return { kind: "delete_pages", input, pages, output_path: outputPath };
}

export function pdfInsertBlank(
  input: string,
  positions: number[],
  outputPath: string,
): PdfOperation {
  return { kind: "insert_blank", input, positions, output_path: outputPath };
}

export function pdfSetMetadata(
  input: string,
  metadata: PdfMetadata,
  outputPath: string,
): PdfOperation {
  return { kind: "set_metadata", input, metadata, output_path: outputPath };
}

export function pdfExtractText(input: string, outputPath: string): PdfOperation {
  return { kind: "extract_text", input, output_path: outputPath };
}

/** Build a batch metadata write op from per-file items. */
export function metadataWrite(
  items: MetadataWriteItem[],
  backup: boolean,
): MetadataOperation {
  return { kind: "write", items, backup };
}

export function pdfExtractImages(
  input: string,
  outputDir: string,
  format: PdfImageFormat,
  dpi: number,
): PdfOperation {
  return {
    kind: "extract_images",
    input,
    output_dir: outputDir,
    format,
    dpi,
  };
}

export function pdfImagesToPdf(
  inputs: string[],
  outputPath: string,
): PdfOperation {
  return { kind: "images_to_pdf", inputs, output_path: outputPath };
}

export function pdfOcr(
  input: string,
  outputPath: string,
  lang: string,
): PdfOperation {
  return { kind: "pdf_ocr", input, output_path: outputPath, lang };
}

export function pdfImageOcr(
  inputs: string[],
  outputPath: string,
  outputKind: ImageOcrOutput,
  lang: string,
): PdfOperation {
  return {
    kind: "image_ocr",
    inputs,
    output_path: outputPath,
    output_kind: outputKind,
    lang,
  };
}

// Smart "Recognize text" (v0.2.7). The backend auto-detects whether the
// input is a text-layer PDF (fast mutool extraction) or a scanned PDF /
// image (tesseract OCR) and routes accordingly. `outputKind` selects
// `.txt` vs searchable PDF exactly like `pdfImageOcr`.
export function pdfRecognizeText(
  input: string,
  outputPath: string,
  outputKind: ImageOcrOutput,
  lang: string,
): PdfOperation {
  return {
    kind: "recognize_text",
    input,
    output_path: outputPath,
    output_kind: outputKind,
    lang,
  };
}

// ImageOperation builders. Same pattern as the PdfOperation builders above:
// the discriminator/field names lock onto the Rust serde tag layout
// (`#[serde(tag = "kind", rename_all = "snake_case")]`) in
// crates/goop-core/src/image.rs. Wire-canary tests in commands.test.ts.

export function imageRotate(
  input: string,
  degrees: RotationDegrees,
  outputPath: string,
): ImageOperation {
  return { kind: "rotate", input, degrees, output_path: outputPath };
}

export function imageResize(
  input: string,
  width: number,
  height: number,
  mode: ResizeMode,
  outputPath: string,
): ImageOperation {
  return {
    kind: "resize",
    input,
    width,
    height,
    mode,
    output_path: outputPath,
  };
}

export function imageCrop(
  input: string,
  rect: CropRect,
  outputPath: string,
): ImageOperation {
  return { kind: "crop", input, rect, output_path: outputPath };
}

export function imageWatermark(
  input: string,
  spec: WatermarkSpec,
  outputPath: string,
): ImageOperation {
  return { kind: "watermark", input, spec, output_path: outputPath };
}

export function imageRecompress(
  inputs: string[],
  outputDir: string,
  quality: number,
): ImageOperation {
  return { kind: "recompress", inputs, output_dir: outputDir, quality };
}

export function imageAppIcon(
  input: string,
  outputDir: string,
  platforms: IconPlatform[],
): ImageOperation {
  return {
    kind: "app_icon",
    input,
    output_dir: outputDir,
    platforms,
  };
}
