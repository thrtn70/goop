import { create } from "zustand";
import type { Job, JobId, ProgressEvent, QueueEvent, Settings } from "@/types";
import { api } from "@/ipc/commands";
import { subscribeAll } from "@/ipc/events";
import type { UnlistenFn } from "@tauri-apps/api/event";

type ProgressEntry = {
  percent: number;
  eta_secs: number | null;
  speed_hr: string | null;
};

type AppStoreState = {
  settings: Settings | null;
  jobs: Job[];
  progressById: Record<string, ProgressEntry>;
  loadAll: () => Promise<void>;
  applyProgress: (e: ProgressEvent) => void;
  applyQueue: (e: QueueEvent) => void;
  cancel: (id: JobId) => Promise<void>;
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

export const useAppStore = create<AppStoreState>((set) => ({
  settings: null,
  jobs: [],
  progressById: {},
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
    });
    return unlisten;
  } catch {
    /* Tauri event bus unavailable — return a no-op unlisten. */
    return () => {};
  }
}
