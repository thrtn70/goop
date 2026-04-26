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
import { getVersion } from "@tauri-apps/api/app";

type ProgressEntry = {
  percent: number;
  eta_secs: number | null;
  speed_hr: string | null;
  /** Active encoder name when known (e.g. `h264_videotoolbox`). */
  encoder: string | null;
};

type AppProgressEvent = ProgressEvent & {
  encoder?: string | null;
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

export interface AppVersionInfo {
  goop: string;
  ytDlp: string | null;
  ffmpeg: string | null;
  os: string;
}

/**
 * Session-only UI state that doesn't belong in persisted Settings.
 * Resets on app restart by design (per product decision for v0.1.9).
 */
export interface UiState {
  /** When true, QueueSidebar renders a narrow tab instead of the full panel. */
  queueCollapsed: boolean;
  /** Currently-selected queued job IDs for batch operations. */
  queueSelectedIds: Set<string>;
  /** Count of jobs that finished today. Refreshed when the queue changes. */
  doneToday: number;
}

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
  /** Phase H: command palette open state. Toggled by Cmd+K. */
  paletteOpen: boolean;
  /**
   * Phase H: counter that increments each time Cmd+N fires. Pages with a URL
   * input (TopBar) watch this and call `inputRef.current?.focus()` when it
   * changes. Counter (vs boolean) avoids consume/clear races.
   */
  pendingFocusUrlInput: number;
  /**
   * Phase H: counter that increments each time Cmd+O fires. Convert and
   * Compress pages watch this and trigger their file picker when it changes.
   */
  pendingFilePicker: number;
  /** `job_id` (as a string key) -> filesystem path to cached thumbnail PNG. */
  thumbnailsById: Record<string, string>;
  /**
   * Cached app + sidecar versions. Populated once per app launch via
   * `loadVersions()` so Settings → About renders instantly on navigation
   * instead of spawning `yt-dlp --version` / `ffmpeg -version` each mount.
   */
  versions: AppVersionInfo | null;
  ui: UiState;
  loadAll: () => Promise<void>;
  applyProgress: (e: AppProgressEvent) => void;
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
  /**
   * Fetch Goop + sidecar versions and cache them. Idempotent — subsequent
   * calls return the existing cached value without re-spawning binaries.
   * Pass `force: true` to bypass the cache (e.g. after a sidecar update).
   */
  loadVersions: (force?: boolean) => Promise<AppVersionInfo>;
  /** Toggle the QueueSidebar's collapsed state. Session-only; does not persist. */
  toggleQueueCollapsed: () => void;
  toggleQueueSelection: (jobId: JobId) => void;
  clearQueueSelection: () => void;
  reorderQueue: (orderedIds: JobId[]) => Promise<void>;
  cancelSelectedQueue: () => Promise<void>;
  refreshDoneToday: () => Promise<void>;
  loadThumbnail: (jobId: JobId) => Promise<string | null>;
  /**
   * Drop the cached thumbnail path for a job from the in-memory map.
   * Call when an `<img>` load fails — the disk file was likely LRU-evicted
   * since the path was cached, so the next `loadThumbnail` must hit IPC to
   * regenerate.
   */
  invalidateThumbnail: (jobId: JobId) => void;
  /** Phase H: open or close the command palette. */
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  /** Phase H: ask the URL input to focus. Called by the Cmd+N hotkey. */
  requestFocusUrlInput: () => void;
  /** Phase H: ask the active page (Convert/Compress) to open its file picker. */
  requestFilePicker: () => void;
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
    queue_sidebar_width: null,
    hw_acceleration_enabled: null,
    cookies_from_browser: null,
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

function detectOs(): string {
  if (typeof navigator === "undefined") return "-";
  const ua = navigator.userAgent;
  if (/Mac OS X/.test(ua)) {
    const m = ua.match(/Mac OS X ([0-9_]+)/);
    const ver = m?.[1]?.replace(/_/g, ".") ?? "";
    return ver ? `macOS ${ver}` : "macOS";
  }
  if (/Windows NT/.test(ua)) {
    const m = ua.match(/Windows NT ([0-9.]+)/);
    return m?.[1] ? `Windows ${m[1]}` : "Windows";
  }
  return navigator.platform || "-";
}

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
  versions: null,
  ui: { queueCollapsed: false, queueSelectedIds: new Set(), doneToday: 0 },
  paletteOpen: false,
  pendingFocusUrlInput: 0,
  pendingFilePicker: 0,
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
          encoder: e.encoder ?? null,
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
    const trashedIds: JobId[] = [];
    let failed = 0;
    for (const { id, path } of jobs) {
      try {
        await api.file.moveToTrash(path);
        trashedIds.push(id);
      } catch {
        failed += 1;
      }
    }
    await get().forgetJobs(trashedIds);
    if (failed > 0) {
      throw new Error(`Could not move ${failed} item${failed === 1 ? "" : "s"} to Trash.`);
    }
  },
  toggleQueueCollapsed() {
    set((s) => ({ ui: { ...s.ui, queueCollapsed: !s.ui.queueCollapsed } }));
  },
  toggleQueueSelection(jobId) {
    const key = jobIdKey(jobId);
    set((s) => {
      const next = new Set(s.ui.queueSelectedIds);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ui: { ...s.ui, queueSelectedIds: next } };
    });
  },
  clearQueueSelection() {
    set((s) => ({ ui: { ...s.ui, queueSelectedIds: new Set() } }));
  },
  async reorderQueue(orderedIds) {
    if (orderedIds.length === 0) return;
    await api.queue.reorder(orderedIds);
    const jobs = await api.queue.list();
    set({ jobs });
  },
  async cancelSelectedQueue() {
    const selected = get().ui.queueSelectedIds;
    if (selected.size === 0) return;
    const ids = get()
      .jobs.filter((j) => selected.has(jobIdKey(j.id)))
      .map((j) => j.id);
    if (ids.length === 0) return;
    await api.queue.cancelMany(ids);
    set((s) => ({ ui: { ...s.ui, queueSelectedIds: new Set() } }));
  },
  async refreshDoneToday() {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    try {
      const count = await api.queue.completedSince(midnight.getTime());
      set((s) => ({ ui: { ...s.ui, doneToday: count } }));
    } catch {
      /* opportunistic */
    }
  },
  async loadVersions(force) {
    if (!force) {
      const cached = get().versions;
      if (cached) return cached;
    }
    const [goop, ytDlp, ffmpeg] = await Promise.all([
      getVersion().catch(() => "-"),
      api.sidecar.ytDlpVersion().catch(() => null),
      api.sidecar.ffmpegVersion().catch(() => null),
    ]);
    const info: AppVersionInfo = { goop, ytDlp, ffmpeg, os: detectOs() };
    set({ versions: info });
    return info;
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
  invalidateThumbnail(jobId) {
    const key = jobIdKey(jobId);
    set((s) => {
      if (!(key in s.thumbnailsById)) return s;
      const thumbs = { ...s.thumbnailsById };
      delete thumbs[key];
      return { thumbnailsById: thumbs };
    });
  },
  setPaletteOpen(open) {
    set({ paletteOpen: open });
  },
  togglePalette() {
    set((s) => ({ paletteOpen: !s.paletteOpen }));
  },
  requestFocusUrlInput() {
    set((s) => ({ pendingFocusUrlInput: s.pendingFocusUrlInput + 1 }));
  },
  requestFilePicker() {
    set((s) => ({ pendingFilePicker: s.pendingFilePicker + 1 }));
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
  // Warm the version cache in the background so Settings → About renders
  // instantly when the user navigates there. Sidecar version spawns are
  // ~100-400ms each; doing it during boot hides the latency.
  void useAppStore
    .getState()
    .loadVersions()
    .catch(() => {
      /* versions are opportunistic; About will show placeholders */
    });
  void useAppStore.getState().refreshDoneToday();
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
        if (isTerminal) {
          void refreshHistory();
          void useAppStore.getState().refreshDoneToday();
        }
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
