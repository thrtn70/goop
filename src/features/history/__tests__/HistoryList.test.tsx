import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HistoryList from "@/features/history/HistoryList";
import { api } from "@/ipc/commands";
import { useAppStore } from "@/store/appStore";
import type { Job, JobKind } from "@/types";

vi.mock("@/ipc/commands", () => ({
  api: {
    queue: {
      list: vi.fn().mockResolvedValue([]),
      completedSince: vi.fn().mockResolvedValue(0),
      reveal: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      reviewablePublicationIds: vi.fn().mockResolvedValue([]),
      reviewPublication: vi.fn(),
      recoverPublication: vi.fn().mockResolvedValue(undefined),
    },
    history: {
      list: vi.fn().mockResolvedValue([]),
      counts: vi.fn().mockResolvedValue({}),
    },
  },
}));

// Snapshot the pristine slice once so every test starts from the real
// defaults (sort, descending, viewMode, counts included), not from
// whatever the previous test left behind.
const initialHistory = useAppStore.getState().history;

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    kind: "extract" as JobKind,
    state: "done",
    payload: null,
    result: { output_path: "/tmp/clip.mp4", bytes: BigInt(2048), duration_ms: BigInt(10) },
    priority: 0,
    attempts: 0,
    created_at: BigInt(1),
    started_at: null,
    finished_at: BigInt(1),
    ...overrides,
  } as unknown as Job;
}

function renderList(jobs: Job[]) {
  useAppStore.setState((s) => ({ history: { ...s.history, jobs } }));
  return render(<HistoryList onPreview={() => {}} onQuickView={() => {}} />);
}

describe("HistoryList terminal-state badge", () => {
  beforeEach(() => {
    useAppStore.setState({
      history: { ...initialHistory, jobs: [], selectedIds: new Set<string>() },
    });
  });

  afterEach(cleanup);

  it("marks a failed job with the error badge", () => {
    renderList([makeJob({ id: "job-failed", state: { error: { message: "yt-dlp exited 1", detail: null } } })]);
    expect(screen.getByText("error")).toBeTruthy();
  });

  it("leaves a cancelled job unbadged", () => {
    renderList([makeJob({ id: "job-cancelled", state: "cancelled" })]);
    expect(screen.queryByText("error")).toBeNull();
  });

  it("leaves a completed job unbadged", () => {
    renderList([makeJob({ id: "job-done", state: "done" })]);
    expect(screen.queryByText("error")).toBeNull();
  });

  it("badges only the failed rows in a mixed list", () => {
    renderList([
      makeJob({ id: "job-done", state: "done" }),
      makeJob({ id: "job-failed", state: { error: { message: "boom", detail: null } } }),
      makeJob({ id: "job-cancelled", state: "cancelled" }),
    ]);
    expect(screen.getAllByText("error")).toHaveLength(1);
  });
});

describe("HistoryList failure message and retry", () => {
  beforeEach(() => {
    useAppStore.setState({
      history: { ...initialHistory, jobs: [], selectedIds: new Set<string>() },
    });
    vi.mocked(api.queue.retry).mockClear();
    vi.mocked(api.queue.retry).mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("says why a row failed instead of only badging it", () => {
    // The badge alone sent people back to the queue — which they had
    // already cleared — to find out what happened.
    renderList([
      makeJob({
        id: "job-failed",
        state: { error: { message: "The site blocked the request.", detail: null } },
      }),
    ]);
    expect(screen.getByText("The site blocked the request.")).toBeTruthy();
  });

  it("explains an interrupted row the same way the queue does", () => {
    // Boot reconcile writes "interrupted" for anything running when the
    // app died, and History is where those rows are actually read.
    renderList([
      makeJob({ id: "job-interrupted", state: { error: { message: "interrupted", detail: null } } }),
    ]);
    expect(screen.getByText(/Goop closed while this ran/)).toBeTruthy();
    expect(screen.queryByText("interrupted")).toBeNull();
  });

  it("offers Retry on a failed download and dispatches it", async () => {
    const user = userEvent.setup();
    renderList([
      makeJob({ id: "job-failed", kind: "extract", state: { error: { message: "boom", detail: null } } }),
    ]);
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(api.queue.retry).toHaveBeenCalledWith("job-failed");
  });

  it("does not let the retry click open the preview underneath it", async () => {
    // The whole row is a click target for preview. Without
    // `stopPropagation` the retry also opens a preview of a job that
    // produced no file.
    const onPreview = vi.fn();
    const user = userEvent.setup();
    useAppStore.setState((s) => ({
      history: {
        ...s.history,
        jobs: [
          makeJob({
            id: "job-failed",
            kind: "extract",
            state: { error: { message: "boom", detail: null } },
          }),
        ],
      },
    }));
    render(<HistoryList onPreview={onPreview} onQuickView={() => {}} />);
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("keeps Retry off non-download kinds", () => {
    // Matches the queue: conversion failures are deterministic, so a
    // Retry button there just fails again. The backend command is
    // kind-generic, so this gate is the UI's alone.
    renderList([
      makeJob({ id: "job-failed", kind: "convert" as JobKind, state: { error: { message: "boom", detail: null } } }),
    ]);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("keeps Retry off rows that did not fail", () => {
    renderList([makeJob({ id: "job-done", kind: "extract", state: "done" })]);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});

describe("HistoryList verified publication review", () => {
  const uncertain = makeJob({
    id: "job-reviewable",
    kind: "convert" as JobKind,
    state: {
      error: {
        message: "output publication is uncertain",
        detail: null,
      },
    },
    result: null,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.queue.list).mockReset().mockResolvedValue([]);
    vi.mocked(api.queue.completedSince).mockReset().mockResolvedValue(1);
    vi.mocked(api.queue.reviewablePublicationIds).mockReset().mockResolvedValue([]);
    vi.mocked(api.queue.reviewPublication).mockReset();
    vi.mocked(api.queue.recoverPublication).mockReset().mockResolvedValue(undefined);
    vi.mocked(api.history.list).mockReset().mockResolvedValue([]);
    vi.mocked(api.history.counts).mockReset().mockResolvedValue({
      all: 0,
      extract: 0,
      convert: 0,
      pdf: 0,
    });
    useAppStore.setState({
      jobs: [],
      toasts: [],
      history: { ...initialHistory, jobs: [], selectedIds: new Set<string>() },
    });
  });

  afterEach(cleanup);

  it("shows Review only for IDs returned by the structured eligibility query", async () => {
    vi.mocked(api.queue.reviewablePublicationIds).mockResolvedValue([uncertain.id]);
    renderList([
      uncertain,
      makeJob({
        id: "job-text-only",
        kind: "convert" as JobKind,
        state: uncertain.state,
        result: null,
      }),
    ]);

    expect(await screen.findByRole("button", { name: /job-reviewable/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /job-text-only/i })).toBeNull();
  });

  it("keeps Retry hidden whenever structured eligibility marks a row reviewable", async () => {
    const retryable = makeJob({
      id: "job-reviewable-download",
      kind: "extract" as JobKind,
      state: { error: { message: "download failed", detail: null } },
      result: null,
    });
    vi.mocked(api.queue.reviewablePublicationIds).mockResolvedValue([retryable.id]);
    renderList([retryable]);

    expect(await screen.findByRole("button", { name: /job-reviewable-download/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("assesses on click and requires confirmation with point-in-time wording", async () => {
    const user = userEvent.setup();
    vi.mocked(api.queue.reviewablePublicationIds).mockResolvedValue([uncertain.id]);
    vi.mocked(api.queue.reviewPublication).mockResolvedValue({
      kind: "observed_matching_output",
      snapshot: "opaque-snapshot",
      output_name: "clip.mp4",
      bytes: 2048,
    });
    renderList([uncertain]);

    await user.click(await screen.findByRole("button", { name: /review uncertain publication/i }));

    expect(api.queue.reviewPublication).toHaveBeenCalledWith(uncertain.id);
    const dialog = await screen.findByRole("dialog", { name: /recover completed output/i });
    expect(dialog.querySelector(".enter-up")).toBeNull();
    expect(dialog.textContent).toMatch(/observed at the destination during this check/i);
    expect(dialog.textContent).toMatch(/does not guarantee/i);
    expect(screen.getByText("clip.mp4")).toBeTruthy();
    expect(api.queue.recoverPublication).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /show .* in folder/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("does not reveal a stale result path before a reviewable row is recovered", async () => {
    vi.mocked(api.queue.reviewablePublicationIds).mockResolvedValue([uncertain.id]);
    renderList([
      makeJob({
        ...uncertain,
        result: {
          output_path: "/tmp/unconfirmed.mp4",
          bytes: BigInt(2048),
          duration_ms: BigInt(10),
          result_kind: "file",
          file_count: 1,
        },
      }),
    ]);

    expect(await screen.findByRole("button", { name: /review uncertain publication/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /show .* in folder/i })).toBeNull();
  });

  it("refreshes structured eligibility when History jobs change in place", async () => {
    vi.mocked(api.queue.reviewablePublicationIds)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([uncertain.id]);
    renderList([makeJob({ id: "job-done" })]);
    await waitFor(() => expect(api.queue.reviewablePublicationIds).toHaveBeenCalledTimes(1));

    act(() => {
      useAppStore.setState((s) => ({
        history: { ...s.history, jobs: [uncertain] },
      }));
    });

    expect(await screen.findByRole("button", { name: /review uncertain publication/i })).toBeTruthy();
    expect(api.queue.reviewablePublicationIds).toHaveBeenCalledTimes(2);
  });

  it("recovers only after confirmation, then refreshes History and Queue", async () => {
    const user = userEvent.setup();
    vi.mocked(api.queue.reviewablePublicationIds)
      .mockResolvedValueOnce([uncertain.id])
      .mockResolvedValueOnce([]);
    vi.mocked(api.queue.reviewPublication).mockResolvedValue({
      kind: "observed_matching_output",
      snapshot: "opaque-snapshot",
      output_name: "clip.mp4",
      bytes: 2048,
    });
    vi.mocked(api.history.list).mockResolvedValue([makeJob({ id: "job-recovered" })]);
    renderList([uncertain]);

    await user.click(await screen.findByRole("button", { name: /review uncertain publication/i }));
    await user.click(await screen.findByRole("button", { name: "Recover completed output" }));

    await waitFor(() => {
      expect(api.queue.recoverPublication).toHaveBeenCalledWith(uncertain.id, "opaque-snapshot");
      expect(api.history.list).toHaveBeenCalledTimes(1);
      expect(api.history.counts).toHaveBeenCalledTimes(1);
      expect(api.queue.list).toHaveBeenCalledTimes(1);
      expect(api.queue.completedSince).toHaveBeenCalledTimes(1);
      expect(api.queue.reviewablePublicationIds).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("table", { name: "History results" }));
  });

  it.each([
    ["unproven", "The destination no longer matches."],
    ["unsupported", "This journal version cannot be reviewed."],
    ["stale", "The job changed while it was checked."],
  ] as const)("keeps a %s assessment unresolved with its reason", async (kind, reason) => {
    const user = userEvent.setup();
    vi.mocked(api.queue.reviewablePublicationIds).mockResolvedValue([uncertain.id]);
    vi.mocked(api.queue.reviewPublication).mockResolvedValue({ kind, reason });
    renderList([uncertain]);

    await user.click(await screen.findByRole("button", { name: /review uncertain publication/i }));

    expect((await screen.findByRole("status")).textContent).toContain(reason);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.queue.recoverPublication).not.toHaveBeenCalled();
  });

  it("keeps the confirmation open and reports a failed recovery", async () => {
    const user = userEvent.setup();
    vi.mocked(api.queue.reviewablePublicationIds).mockResolvedValue([uncertain.id]);
    vi.mocked(api.queue.reviewPublication).mockResolvedValue({
      kind: "observed_matching_output",
      snapshot: "expired-snapshot",
      output_name: "clip.mp4",
      bytes: 2048,
    });
    vi.mocked(api.queue.recoverPublication).mockRejectedValue({
      code: "stale",
      message: "The output changed. Review it again.",
    });
    renderList([uncertain]);

    await user.click(await screen.findByRole("button", { name: /review uncertain publication/i }));
    await user.click(await screen.findByRole("button", { name: "Recover completed output" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/The output changed\. Review it again\./i);
    expect(screen.getByRole("dialog", { name: /recover completed output/i })).toBeTruthy();
    expect(api.history.list).not.toHaveBeenCalled();
    expect(api.queue.list).not.toHaveBeenCalled();
  });

  it("supports keyboard review without opening the row preview", async () => {
    const onPreview = vi.fn();
    const user = userEvent.setup();
    vi.mocked(api.queue.reviewablePublicationIds).mockResolvedValue([uncertain.id]);
    vi.mocked(api.queue.reviewPublication).mockResolvedValue({
      kind: "unproven",
      reason: "The destination could not be proven.",
    });
    useAppStore.setState((s) => ({
      history: { ...s.history, jobs: [uncertain] },
    }));
    render(<HistoryList onPreview={onPreview} onQuickView={() => {}} />);

    const review = await screen.findByRole("button", { name: /review uncertain publication/i });
    review.focus();
    await user.keyboard("{Enter}");

    expect(api.queue.reviewPublication).toHaveBeenCalledWith(uncertain.id);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("traps dialog focus and restores it to the Review action on Escape", async () => {
    const user = userEvent.setup();
    vi.mocked(api.queue.reviewablePublicationIds).mockResolvedValue([uncertain.id]);
    vi.mocked(api.queue.reviewPublication).mockResolvedValue({
      kind: "observed_matching_output",
      snapshot: "opaque-snapshot",
      output_name: "clip.mp4",
      bytes: 2048,
    });
    renderList([uncertain]);

    const review = await screen.findByRole("button", { name: /review uncertain publication/i });
    await user.click(review);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    const recover = screen.getByRole("button", { name: "Recover completed output" });
    expect(document.activeElement).toBe(cancel);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(recover);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(review);
  });
});
