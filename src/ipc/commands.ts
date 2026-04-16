import { invoke } from "@tauri-apps/api/core";
import type {
  ConvertRequest,
  ExtractRequest,
  Job,
  JobId,
  ProbeResult,
  Settings,
  SettingsPatch,
  SidecarStatus,
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
  },
  settings: {
    get: () => invoke<Settings>("settings_get"),
    set: (patch: SettingsPatch) => invoke<Settings>("settings_set", { patch }),
  },
} as const;
