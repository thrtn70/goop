import { create } from "zustand";
import type {
  HistoryCounts,
  HistoryFilter,
  HistorySort,
  HistoryViewMode,
  Job,
  JobId,
  JobKind,
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

export interface HistoryState {
  search: string;
  kind: JobKind | null;
  sort: HistorySort;
  descending: boolean;
  viewMode: HistoryViewMode;
  jobs: Job[];
  counts: HistoryCounts | null;
  /** String keys for selected rows (from `jobIdKey`). Used for batch actions. */
  selectedIds: Set<string>;
  previewSelectedId: string | null;
}

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
  history: HistoryState;
  /** `job_id` (as a string key) -> filesystem path to cached thumbnail PNG. */
  thumbnailsById: Record<string, string>;
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
  /** Fetch the terminal-state job list + per-kind counts. */
  loadHistory: () => Promise<void>;
  setHistorySearch: (search: string) => void;
  setHistoryKind: (kind: JobKind | null) => void;
  setHistorySort: (sort: HistorySort, descending?: boolean) => void;
  toggleHistoryViewMode: () => Promise<void>;
  toggleHistorySelection: (jobId: JobId) => void;
  clearHistorySelection: () => void;
  setHistoryPreview: (jobId: JobId | null) => void;
  forgetJobs: (ids: JobId[]) => Promise<void>;
  trashJobs: (jobs: { id: JobId; path: string }[]) => Promise<void>;
  loadThumbnail: (jobId: JobId) => Promise<string | null>;
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
    history_view_mode: null,
  };
}

const emptyHistory: HistoryState = {
  search: "",
  kind: null,
  sort: "date",
  descending: true,
  viewMode: "list",
  jobs: [],
  counts: null,
  selectedIds: new Set(),
  previewSelectedId: null,
};

function currentFilter(h: HistoryState): HistoryFilter {
  return {
    search: h.search.trim() === "" ? null : h.search,
    kind: h.kind,
    sort: h.sort,
    descending: h.descending,
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
  history: emptyHistory,
  thumbnailsById: {},
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
  async loadHistory() {
    const { history } = get();
    const filter = currentFilter(history);
    const [jobs, counts] = await Promise.all([
      api.history.list(filter),
      api.history.counts(),
    ]);
    set((s) => ({
      history: {
        ...s.history,
        jobs,
        counts,
        // Prune any selections that point to rows no longer in the list.
        selectedIds: new Set(
          [...s.history.selectedIds].filter((id) =>
            jobs.some((j) => jobIdKey(j.id) === id),
          ),
        ),
      },
    }));
  },
  setHistorySearch(search) {
    set((s) => ({ history: { ...s.history, search } }));
    void get().loadHistory();
  },
  setHistoryKind(kind) {
    set((s) => ({ history: { ...s.history, kind } }));
    void get().loadHistory();
  },
  setHistorySort(sort, descending) {
    set((s) => ({
      history: {
        ...s.history,
        sort,
        descending:
          descending ?? (s.history.sort === sort ? !s.history.descending : true),
      },
    }));
    void get().loadHistory();
  },
  async toggleHistoryViewMode() {
    const s = get();
    const next = s.history.viewMode === "list" ? "grid" : "list";
    set({ history: { ...s.history, viewMode: next } });
    try {
      await get().patchSettings({ history_view_mode: next });
    } catch {
      /* persist failure is non-fatal — the toggle still works for this session */
    }
  },
  toggleHistorySelection(jobId) {
    const key = jobIdKey(jobId);
    set((s) => {
      const ids = new Set(s.history.selectedIds);
      if (ids.has(key)) ids.delete(key);
      else ids.add(key);
      return { history: { ...s.history, selectedIds: ids } };
    });
  },
  clearHistorySelection() {
    set((s) => ({ history: { ...s.history, selectedIds: new Set() } }));
  },
  setHistoryPreview(jobId) {
    set((s) => ({
      history: {
        ...s.history,
        previewSelectedId: jobId ? jobIdKey(jobId) : null,
      },
    }));
  },
  async forgetJobs(ids) {
    if (ids.length === 0) return;
    if (ids.length === 1) await api.job.forget(ids[0]);
    else await api.job.forgetMany(ids);
    // Drop cached thumbnails from the map so a future get doesn't serve the
    // deleted path (backend removed the PNG).
    set((s) => {
      const thumbs = { ...s.thumbnailsById };
      for (const id of ids) delete thumbs[jobIdKey(id)];
      return { thumbnailsById: thumbs };
    });
    await get().loadHistory();
  },
  async trashJobs(jobs) {
    for (const { path } of jobs) {
      try {
        await api.file.moveToTrash(path);
      } catch (e) {
        // Continue with the remaining jobs; surface the last error if every
        // path failed. The UI shows a toast on rejection.
        console.warn("trash failed for", path, e);
      }
    }
    await get().forgetJobs(jobs.map((j) => j.id));
  },
  async loadThumbnail(jobId) {
    const key = jobIdKey(jobId);
    const existing = get().thumbnailsById[key];
    if (existing) return existing;
    try {
      const path = await api.thumbnail.get(jobId);
      set((s) => ({ thumbnailsById: { ...s.thumbnailsById, [key]: path } }));
      return path;
    } catch {
      return null;
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
  // Hydrate history view mode from settings so a List/Grid toggle choice
  // survives app restarts (the setting is persisted backend-side).
  const bootSettings = useAppStore.getState().settings;
  if (bootSettings) {
    useAppStore.setState((s) => ({
      history: { ...s.history, viewMode: bootSettings.history_view_mode },
    }));
  }
  try {
    await useAppStore.getState().loadPresets();
  } catch {
    /* presets unavailable — chips will render empty until a reload */
  }
  try {
    await useAppStore.getState().loadHistory();
  } catch {
    /* history unavailable (Tauri mock or first-launch with fresh DB) */
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

  // When a job transitions (most commonly to a terminal state), the History
  // page's list view can go stale. Reload lazily — single SQL query, cheap.
  const refreshHistory = async (): Promise<void> => {
    try {
      await useAppStore.getState().loadHistory();
    } catch {
      /* transient */
    }
  };

  try {
    const unlisten = await subscribeAll({
      onProgress: (e) => useAppStore.getState().applyProgress(e),
      onQueue: (e) => {
        useAppStore.getState().applyQueue(e);
        void refresh();
        // Terminal transitions affect the History page; keep it in sync.
        const term = e.state;
        const isTerminal =
          typeof term === "string"
            ? term === "done" || term === "cancelled"
            : "error" in term;
        if (isTerminal) void refreshHistory();
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
