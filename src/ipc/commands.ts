import { invoke } from "@tauri-apps/api/core";
import type {
  ConvertRequest,
  ExtractRequest,
  HistoryCounts,
  HistoryFilter,
  Job,
  JobId,
  PageRange,
  PdfOperation,
  PdfProbeResult,
  PdfQuality,
  Preset,
  ProbeResult,
  Settings,
  SettingsPatch,
  SidecarStatus,
  UpdateInfo,
  UpdateStatus,
  UrlProbe,
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

export const api = {
  convert: {
    probe: (path: string) => invoke<ProbeResult>("convert_probe", { path }),
    fromFile: (req: IpcConvertRequest) =>
      invoke<JobId>("convert_from_file", { req }),
  },
  extract: {
    probe: (url: string) => invoke<UrlProbe>("extract_probe", { url }),
    fromUrl: (req: ExtractRequest) => invoke<JobId>("extract_from_url", { req }),
  },
  queue: {
    list: () => invoke<Job[]>("queue_list"),
    cancel: (jobId: JobId) => invoke<void>("queue_cancel", { jobId }),
    clearCompleted: () => invoke<number>("queue_clear_completed"),
    reveal: (path: string) => invoke<void>("queue_reveal", { path }),
  },
  sidecar: {
    status: () => invoke<SidecarStatus>("sidecar_status"),
    updateYtDlp: () => invoke<UpdateStatus>("sidecar_update_yt_dlp"),
    ytDlpVersion: () => invoke<string>("sidecar_yt_dlp_version"),
    ffmpegVersion: () => invoke<string>("sidecar_ffmpeg_version"),
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
  },
  pdf: {
    probe: (path: string) => invoke<PdfProbeResult>("pdf_probe", { path }),
    run: (op: PdfOperation) => invoke<JobId>("pdf_run", { op }),
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
