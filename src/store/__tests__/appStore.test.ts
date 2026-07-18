import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/ipc/commands";
import { jobIdKey, useAppStore } from "@/store/appStore";
import type { HistoryCounts, Job, JobId, JobState, Settings, SidecarEvent } from "@/types";

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
    sidecar: {
      ytDlpVersion: vi.fn(),
      ffmpegVersion: vi.fn(),
      galleryDlVersion: vi.fn(),
      ghostscriptVersion: vi.fn(),
      mutoolVersion: vi.fn(),
    },
    thumbnail: { get: vi.fn() },
  },
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.2.1"),
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
    // loadVersions fans out over every sidecar at once. Each call is
    // individually .catch()-guarded, but a bare vi.fn() returns undefined and
    // .catch() on that throws synchronously, rejecting the whole batch.
    vi.mocked(api.sidecar.ytDlpVersion).mockResolvedValue("2024.10.07");
    vi.mocked(api.sidecar.galleryDlVersion).mockResolvedValue("1.32.4");
    vi.mocked(api.sidecar.ffmpegVersion).mockResolvedValue("n7.1");
    vi.mocked(api.sidecar.ghostscriptVersion).mockResolvedValue("10.04.0");
    vi.mocked(api.sidecar.mutoolVersion).mockResolvedValue("1.27.0");
    useAppStore.setState({
      settings: null,
      jobs: [],
      progressById: {},
      toasts: [],
      thumbnailsById: {},
      versions: null,
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

  it("enqueues an info toast for a cookie_fallback sidecar warning", () => {
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

  // Deduping cookie_fallback is the extractor's job (WarnOnceSink), scoped
  // to one dispatch attempt. A second event means a second attempt — a
  // resume or a manual retry — and the user should see it. Pins the
  // pass-through so a store-level dedupe can't be added without this
  // failing loudly.
  it("enqueues one toast per cookie_fallback event (dedupe is the backend's job)", () => {
    const before = useAppStore.getState().toasts.length;
    for (let i = 0; i < 2; i++) {
      useAppStore.getState().handleSidecarEvent({
        kind: "warning",
        code: "cookie_fallback",
        message: "Couldn't read chrome cookies — proceeded without.",
      });
    }
    expect(useAppStore.getState().toasts.length).toBe(before + 2);
  });

  it("force-refreshes the cached versions when yt-dlp reports an update", async () => {
    // A warm cache is the norm here: boot pre-loads versions so Settings →
    // About renders instantly. That makes `force` load-bearing — a plain
    // loadVersions() would return this stale value and never re-spawn.
    useAppStore.setState({
      versions: {
        goop: "0.2.1",
        ytDlp: "2024.10.07",
        galleryDl: null,
        ffmpeg: null,
        ghostscript: null,
        mutool: null,
        os: "darwin",
      },
    });
    vi.mocked(api.sidecar.ytDlpVersion).mockResolvedValue("2024.11.18");

    useAppStore.getState().handleSidecarEvent({
      kind: "yt_dlp_updated",
      from_version: "2024.10.07",
      to_version: "2024.11.18",
    });

    await vi.waitFor(() =>
      expect(useAppStore.getState().versions?.ytDlp).toBe("2024.11.18"),
    );
  });

  it("collapses overlapping version loads into a single fan-out", async () => {
    // A successful update fires a refresh from both the Settings button and
    // the yt_dlp_updated event. Each fan-out overwrites `versions` wholesale,
    // so racing them lets the slower batch's transient failure blank a
    // sidecar the faster one read fine.
    const [a, b] = await Promise.all([
      useAppStore.getState().loadVersions(true),
      useAppStore.getState().loadVersions(true),
    ]);

    expect(api.sidecar.ytDlpVersion).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("starts a fresh fan-out once the previous load settled", async () => {
    await useAppStore.getState().loadVersions(true);
    await useAppStore.getState().loadVersions(true);
    expect(api.sidecar.ytDlpVersion).toHaveBeenCalledTimes(2);
  });

  it("does not toast for yt_dlp_updated (Settings shows the result inline)", async () => {
    const before = useAppStore.getState().toasts.length;
    vi.mocked(api.sidecar.ytDlpVersion).mockResolvedValue("2024.11.18");

    useAppStore.getState().handleSidecarEvent({
      kind: "yt_dlp_updated",
      from_version: "2024.10.07",
      to_version: "2024.11.18",
    });

    await vi.waitFor(() => expect(api.sidecar.ytDlpVersion).toHaveBeenCalled());
    expect(useAppStore.getState().toasts.length).toBe(before);
  });

  it("ignores warning sidecar events with unknown codes", () => {
    const before = useAppStore.getState().toasts.length;
    // WarningCode makes this unrepresentable, but the event arrives over IPC as
    // unvalidated JSON, so a Rust side that gained a variant without regenerated
    // bindings could still deliver one. Cast past the type to cover that.
    useAppStore.getState().handleSidecarEvent({
      kind: "warning",
      code: "unknown_future_code",
      message: "noise",
    } as unknown as SidecarEvent);
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
