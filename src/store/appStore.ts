import { create } from "zustand";
import type {
  Job,
  JobId,
  Preset,
  ProgressEvent,
  QueueEvent,
  Settings,
  SettingsPatch,
  UpdateInfo,
} from "@/types";
import { api } from "@/ipc/commands";
import { subscribeAll } from "@/ipc/events";
import type { UnlistenFn } from "@tauri-apps/api/event";

type ProgressEntry = {
  percent: number;
  eta_secs: number | null;
  speed_hr: string | null;
};

export type ToastVariant = "success" | "error" | "cancelled" | "info";

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  /** Optional detail message (shown under title, or expanded for errors). */
  detail?: string;
  /** Optional output path — if present, the toast gets a Reveal action. */
  outputPath?: string;
  /** When this toast should auto-dismiss (ms epoch). null = sticky. */
  dismissAt: number | null;
  createdAt: number;
}

export type UpdateDownloadState = {
  downloaded: number;
  total: number;
  active: boolean;
};

type AppStoreState = {
  settings: Settings | null;
  jobs: Job[];
  progressById: Record<string, ProgressEntry>;
  toasts: Toast[];
  /** Jobs finished while user was on a different page — clears on queue-focus. */
  unseenCompletions: number;
  presets: Preset[];
  updateInfo: UpdateInfo | null;
  updateDownload: UpdateDownloadState | null;
  loadAll: () => Promise<void>;
  applyProgress: (e: ProgressEvent) => void;
  applyQueue: (e: QueueEvent) => void;
  cancel: (id: JobId) => Promise<void>;
  enqueueToast: (t: Omit<Toast, "id" | "createdAt" | "dismissAt"> & { ttlMs?: number | null }) => string;
  dismissToast: (id: string) => void;
  incrementUnseen: () => void;
  clearUnseen: () => void;
  /**
   * Fills the boilerplate `null` fields on `SettingsPatch` so callers can
   * patch any subset of settings, and keeps the in-store `settings` fresh
   * with the Rust-side result.
   */
  patchSettings: (partial: Partial<Settings>) => Promise<void>;
  loadPresets: () => Promise<void>;
  savePreset: (p: Preset) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
  checkForUpdate: () => Promise<void>;
  dismissUpdate: (version: string) => Promise<void>;
  applyUpdateProgress: (downloaded: number, total: number) => void;
  startUpdateDownload: (url: string, total: number) => Promise<void>;
};

/**
 * Extract a stable string key from a JobId.
 *
 * ts-rs currently emits `JobId = string`, but the underlying Rust type is a
 * newtype wrapping a Uuid. Guard against the `{ 0: string }` shape just in
 * case the ts-rs layout changes.
 */
export function jobIdKey(id: JobId): string {
  if (typeof id === "string") return id;
  const maybeTuple = id as { readonly 0?: string } | null;
  if (maybeTuple && typeof maybeTuple[0] === "string") return maybeTuple[0];
  return String(id);
}

const DEFAULT_TOAST_TTL_MS = 5000;

function newToastId(): string {
  // Crypto-safe enough for UI keys; falls back if `crypto` is unavailable (tests).
  try {
    return crypto.randomUUID();
  } catch {
    return `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function emptyPatch(): SettingsPatch {
  return {
    output_dir: null,
    theme: null,
    yt_dlp_last_update_ms: null,
    extract_concurrency: null,
    convert_concurrency: null,
    auto_check_updates: null,
    dismissed_update_version: null,
  };
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  settings: null,
  jobs: [],
  progressById: {},
  toasts: [],
  unseenCompletions: 0,
  presets: [],
  updateInfo: null,
  updateDownload: null,
  async loadAll() {
    const [settings, jobs] = await Promise.all([api.settings.get(), api.queue.list()]);
    set({ settings, jobs });
  },
  applyProgress(e) {
    const key = jobIdKey(e.job_id);
    set((s) => ({
      progressById: {
        ...s.progressById,
        [key]: {
          percent: e.percent,
          eta_secs: e.eta_secs != null ? Number(e.eta_secs) : null,
          speed_hr: e.speed_hr ?? null,
        },
      },
    }));
  },
  applyQueue(e) {
    set((s) => {
      const targetKey = jobIdKey(e.job_id);
      const idx = s.jobs.findIndex((j) => jobIdKey(j.id) === targetKey);
      if (idx < 0) return {};
      const next = [...s.jobs];
      next[idx] = { ...next[idx], state: e.state, result: e.result ?? next[idx].result };
      return { jobs: next };
    });
  },
  async cancel(id) {
    await api.queue.cancel(id);
  },
  enqueueToast(t) {
    const id = newToastId();
    const now = Date.now();
    const ttl = t.ttlMs === undefined ? DEFAULT_TOAST_TTL_MS : t.ttlMs;
    const dismissAt = ttl === null ? null : now + ttl;
    const toast: Toast = {
      id,
      variant: t.variant,
      title: t.title,
      detail: t.detail,
      outputPath: t.outputPath,
      dismissAt,
      createdAt: now,
    };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    return id;
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  incrementUnseen() {
    set((s) => ({ unseenCompletions: s.unseenCompletions + 1 }));
  },
  clearUnseen() {
    set({ unseenCompletions: 0 });
  },
  async patchSettings(partial) {
    const patch: SettingsPatch = { ...emptyPatch(), ...partial } as SettingsPatch;
    const next = await api.settings.set(patch);
    set({ settings: next });
  },
  async loadPresets() {
    const presets = await api.preset.list();
    set({ presets });
  },
  async savePreset(p) {
    const saved = await api.preset.save(p);
    set((s) => {
      const idx = s.presets.findIndex((x) => x.id === saved.id);
      if (idx < 0) return { presets: [...s.presets, saved] };
      const next = [...s.presets];
      next[idx] = saved;
      return { presets: next };
    });
  },
  async deletePreset(id) {
    await api.preset.delete(id);
    set((s) => ({ presets: s.presets.filter((p) => p.id !== id) }));
  },
  async checkForUpdate() {
    const info = await api.update.check();
    set({ updateInfo: info });
  },
  async dismissUpdate(version) {
    await get().patchSettings({ dismissed_update_version: version });
  },
  applyUpdateProgress(downloaded, total) {
    set({ updateDownload: { downloaded, total, active: true } });
  },
  async startUpdateDownload(url, total) {
    set({ updateDownload: { downloaded: 0, total, active: true } });
    try {
      await api.update.download(url);
      set({ updateDownload: { downloaded: total, total, active: false } });
    } catch (e) {
      set({ updateDownload: null });
      throw e;
    }
  },
}));

/**
 * Wire up Tauri event subscriptions. Call once at app boot.
 *
 * If Tauri isn't available (e.g. SSR, unit tests, preview outside the shell),
 * errors are swallowed so the UI keeps working with empty state.
 */
export async function bootstrapStoreSubscriptions(): Promise<UnlistenFn> {
  try {
    await useAppStore.getState().loadAll();
  } catch {
    /* Tauri not available or backend not ready — continue with empty state. */
  }
  try {
    await useAppStore.getState().loadPresets();
  } catch {
    /* presets unavailable — chips will render empty until a reload */
  }
  try {
    const settings = useAppStore.getState().settings;
    if (settings?.auto_check_updates) {
      await useAppStore.getState().checkForUpdate();
    }
  } catch {
    /* update check is opportunistic; offline is fine */
  }

  const refresh = async (): Promise<void> => {
    try {
      const jobs = await api.queue.list();
      useAppStore.setState({ jobs });
    } catch {
      /* ignore transient errors */
    }
  };

  try {
    const unlisten = await subscribeAll({
      onProgress: (e) => useAppStore.getState().applyProgress(e),
      onQueue: (e) => {
        useAppStore.getState().applyQueue(e);
        void refresh();
      },
      onSidecar: () => {
        /* reserved for future sidecar-driven UI state */
      },
      onUpdateProgress: (e) =>
        useAppStore.getState().applyUpdateProgress(Number(e.downloaded), Number(e.total)),
    });
    return unlisten;
  } catch {
    /* Tauri event bus unavailable — return a no-op unlisten. */
    return () => {};
  }
}
