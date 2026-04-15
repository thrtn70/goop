import { invoke } from "@tauri-apps/api/core";
import type {
  ExtractRequest,
  Job,
  JobId,
  Settings,
  SettingsPatch,
  SidecarStatus,
  UpdateStatus,
  UrlProbe,
} from "@/types";

export const api = {
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
