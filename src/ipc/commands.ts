import { invoke } from "@tauri-apps/api/core";
import type {
  ConvertRequest,
  ExtractRequest,
  Job,
  JobId,
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
} as const;
