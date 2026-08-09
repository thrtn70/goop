import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import HistoryList from "@/features/history/HistoryList";
import { useAppStore } from "@/store/appStore";
import type { Job, JobKind } from "@/types";

vi.mock("@/ipc/commands", () => ({
  api: {
    queue: { reveal: vi.fn().mockResolvedValue(undefined) },
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
    renderList([makeJob({ id: "job-failed", state: { error: { message: "yt-dlp exited 1" } } })]);
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
      makeJob({ id: "job-failed", state: { error: { message: "boom" } } }),
      makeJob({ id: "job-cancelled", state: "cancelled" }),
    ]);
    expect(screen.getAllByText("error")).toHaveLength(1);
  });
});
