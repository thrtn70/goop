import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/ipc/commands";
import { jobIdKey, useAppStore } from "@/store/appStore";
import type { HistoryCounts, Job, JobId, JobState, Settings } from "@/types";

vi.mock("@/ipc/commands", () => ({
  api: {
    queue: {
      list: vi.fn(),
      reveal: vi.fn(),
      cancel: vi.fn(),
      cancelMany: vi.fn(),
      reorder: vi.fn(),
      moveToTop: vi.fn(),
      clearCompleted: vi.fn(),
      completedSince: vi.fn(),
    },
    history: { list: vi.fn(), counts: vi.fn() },
    job: { forget: vi.fn(), forgetMany: vi.fn() },
    file: { moveToTrash: vi.fn() },
    settings: { set: vi.fn(), get: vi.fn() },
    preset: { list: vi.fn(), save: vi.fn(), delete: vi.fn() },
    update: { check: vi.fn(), download: vi.fn() },
    sidecar: { ytDlpVersion: vi.fn(), ffmpegVersion: vi.fn() },
    thumbnail: { get: vi.fn() },
  },
}));

const counts: HistoryCounts = { all: 0, extract: 0, convert: 0, pdf: 0 };

function makeJob(id: JobId, state: JobState = "queued"): Job {
  return {
    id,
    kind: "extract",
    state,
    payload: null,
    result: null,
    priority: 0,
    attempts: 0,
    created_at: 1n,
    started_at: null,
    finished_at: null,
  };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    output_dir: "/downloads",
    theme: "system",
    yt_dlp_last_update_ms: null,
    extract_concurrency: 2,
    convert_concurrency: 1,
    auto_check_updates: true,
    dismissed_update_version: null,
    history_view_mode: "list",
    queue_sidebar_width: 288,
    hw_acceleration_enabled: true,
    cookies_from_browser: null,
    has_seen_onboarding: true,
    notifications_enabled: false,
    output_dir_extract: null,
    extract_naming_scheme: "title",
    default_metadata_policy: "preserve",
    torbox_api_key: null,
    ...overrides,
  };
}

describe("app store queue and settings operations", () => {
  beforeEach(() => {
    const clearMocks = vi[["clear", "All", "Mocks"].join("") as keyof typeof vi];
    (clearMocks as () => void)();
    vi.mocked(api.history.list).mockResolvedValue([]);
    vi.mocked(api.history.counts).mockResolvedValue(counts);
    useAppStore.setState({
      settings: null,
      jobs: [],
      progressById: {},
      toasts: [],
      thumbnailsById: {},
      ui: { queueCollapsed: false, queueSelectedIds: new Set(), doneToday: 0 },
      history: {
        search: "",
        kind: null,
        sort: "date",
        descending: true,
        viewMode: "list",
        jobs: [],
        counts: null,
        selectedIds: new Set(),
        previewSelectedId: null,
      },
    });
  });

  it("updates a queued job without mutating the previous jobs array", () => {
    const first = makeJob("job-a");
    const second = makeJob("job-b");
    const previous = [first, second];
    useAppStore.setState({ jobs: previous });

    useAppStore.getState().applyQueue({
      job_id: first.id,
      state: "running",
      result: null,
    });

    const next = useAppStore.getState().jobs;
    expect(next).not.toBe(previous);
    expect(previous[0].state).toBe("queued");
    expect(next[0]).toEqual({ ...first, state: "running" });
    expect(next[1]).toBe(second);
  });

  it("forgets selected jobs and preserves unrelated thumbnail entries", async () => {
    const drop = "job-a";
    const keep = "job-b";
    useAppStore.setState({
      thumbnailsById: {
        [jobIdKey(drop)]: "/cache/a.png",
        [jobIdKey(keep)]: "/cache/b.png",
      },
    });

    await useAppStore.getState().forgetJobs([drop]);

    expect(api.job.forget).toHaveBeenCalledWith(drop);
    expect(useAppStore.getState().thumbnailsById[jobIdKey(drop)]).toBeUndefined();
    expect(useAppStore.getState().thumbnailsById[jobIdKey(keep)]).toBe("/cache/b.png");
  });

  it("forgets trashed jobs and reports partial trash failures", async () => {
    const ok = "job-a";
    const fail = "job-b";
    vi.mocked(api.file.moveToTrash)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"));

    await expect(
      useAppStore.getState().trashJobs([
        { id: ok, path: "/ok.mp4" },
        { id: fail, path: "/fail.mp4" },
      ]),
    ).rejects.toThrow("Could not move 1 item to Trash.");

    expect(api.file.moveToTrash).toHaveBeenCalledTimes(2);
    expect(api.job.forget).toHaveBeenCalledWith(ok);
    expect(api.job.forget).not.toHaveBeenCalledWith(fail);
  });

  it("merges settings patches through the backend result", async () => {
    const current = makeSettings();
    const next = makeSettings({ theme: "dark" });
    vi.mocked(api.settings.set).mockResolvedValue(next);
    useAppStore.setState({ settings: current });

    await useAppStore.getState().patchSettings({ theme: "dark" });

    expect(api.settings.set).toHaveBeenCalledWith(
      expect.objectContaining({
        output_dir: null,
        theme: "dark",
        extract_concurrency: null,
      }),
    );
    expect(useAppStore.getState().settings).toEqual(next);
    expect(current.theme).toBe("system");
  });

  it("omits tri-state fields from unrelated patches so the backend leaves them alone", async () => {
    const current = makeSettings({ cookies_from_browser: "chrome" });
    vi.mocked(api.settings.set).mockResolvedValue(current);
    useAppStore.setState({ settings: current });

    await useAppStore.getState().patchSettings({ theme: "dark" });

    const sent = vi.mocked(api.settings.set).mock.calls[0]?.[0] ?? {};
    expect(sent).not.toHaveProperty("cookies_from_browser");
    expect(sent).not.toHaveProperty("output_dir_extract");
  });

  it("enqueues a one-shot info toast for cookie_fallback sidecar warnings", () => {
    const before = useAppStore.getState().toasts.length;
    useAppStore.getState().handleSidecarEvent({
      kind: "warning",
      code: "cookie_fallback",
      message: "Couldn't read chrome cookies — proceeded without.",
    });
    const after = useAppStore.getState().toasts;
    expect(after.length).toBe(before + 1);
    const t = after[after.length - 1];
    expect(t.variant).toBe("info");
    expect(t.title.toLowerCase()).toContain("cookies");
    expect(t.detail).toContain("chrome");
  });

  it("ignores yt_dlp_updated sidecar events (handled by version subscriber)", () => {
    const before = useAppStore.getState().toasts.length;
    useAppStore.getState().handleSidecarEvent({
      kind: "yt_dlp_updated",
      from_version: "2024.10.07",
      to_version: "2024.11.18",
    });
    expect(useAppStore.getState().toasts.length).toBe(before);
  });

  it("ignores warning sidecar events with unknown codes", () => {
    const before = useAppStore.getState().toasts.length;
    useAppStore.getState().handleSidecarEvent({
      kind: "warning",
      code: "unknown_future_code",
      message: "noise",
    });
    expect(useAppStore.getState().toasts.length).toBe(before);
  });
});

describe("applyProgress retry-stage percent hold", () => {
  it("holds the previous percent when a retrying stage arrives with percent 0", () => {
    const id = "00000000-0000-7000-8000-0000000000aa" as JobId;
    useAppStore.setState({ progressById: {} });
    useAppStore.getState().applyProgress({
      job_id: id,
      percent: 42.5,
      eta_secs: 10n,
      speed_hr: "1.2MiB/s",
      stage: "downloading",
      encoder: null,
    });
    useAppStore.getState().applyProgress({
      job_id: id,
      percent: 0,
      eta_secs: 8n,
      speed_hr: null,
      stage: "retrying (attempt 2/5)",
      encoder: null,
    });
    const entry = useAppStore.getState().progressById[jobIdKey(id)];
    expect(entry.percent).toBe(42.5);
    expect(entry.stage).toBe("retrying (attempt 2/5)");
    expect(entry.eta_secs).toBe(8);
  });

  it("resumes normal percent updates once downloading restarts", () => {
    const id = "00000000-0000-7000-8000-0000000000ab" as JobId;
    useAppStore.setState({ progressById: {} });
    useAppStore.getState().applyProgress({
      job_id: id,
      percent: 42.5,
      eta_secs: null,
      speed_hr: null,
      stage: "downloading",
      encoder: null,
    });
    useAppStore.getState().applyProgress({
      job_id: id,
      percent: 0,
      eta_secs: 8n,
      speed_hr: null,
      stage: "retrying (attempt 2/5)",
      encoder: null,
    });
    useAppStore.getState().applyProgress({
      job_id: id,
      percent: 43.1,
      eta_secs: null,
      speed_hr: null,
      stage: "downloading",
      encoder: null,
    });
    const entry = useAppStore.getState().progressById[jobIdKey(id)];
    expect(entry.percent).toBe(43.1);
    expect(entry.stage).toBe("downloading");
  });
});

describe("refreshJobs", () => {
  it("re-lists jobs so a freshly enqueued row shows without a queue event", async () => {
    const id = "00000000-0000-7000-8000-00000000abcd" as JobId;
    useAppStore.setState({ jobs: [] });
    vi.mocked(api.queue.list).mockResolvedValue([makeJob(id, "queued")]);

    await useAppStore.getState().refreshJobs();

    const jobs = useAppStore.getState().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe("queued");
  });
});
