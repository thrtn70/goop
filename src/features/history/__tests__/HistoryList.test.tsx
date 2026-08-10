import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HistoryList from "@/features/history/HistoryList";
import { api } from "@/ipc/commands";
import { useAppStore } from "@/store/appStore";
import type { Job, JobKind } from "@/types";

vi.mock("@/ipc/commands", () => ({
  api: {
    queue: {
      reveal: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
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
