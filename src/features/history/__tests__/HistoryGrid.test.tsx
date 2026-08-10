import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HistoryGrid from "@/features/history/HistoryGrid";
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

// Cards observe themselves to lazy-load thumbnails; jsdom has no
// IntersectionObserver. A no-op stub leaves every card un-intersected, which
// is the state these tests care about — no thumbnail IPC, just the metadata.
class IntersectionObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    IntersectionObserverStub;
});

// Snapshot the pristine slice once so every test starts from the real
// defaults rather than whatever the previous test left behind.
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

/** A failed job produced no file, so it has no result row to speak of. */
function makeFailed(overrides: Partial<Job> = {}): Job {
  return makeJob({
    id: "job-failed",
    result: null,
    state: { error: { message: "boom", detail: null } },
    ...overrides,
  } as Partial<Job>);
}

function renderGrid(jobs: Job[]) {
  useAppStore.setState((s) => ({ history: { ...s.history, jobs } }));
  return render(<HistoryGrid onPreview={() => {}} onQuickView={() => {}} />);
}

describe("HistoryGrid failure message and retry", () => {
  beforeEach(() => {
    useAppStore.setState({
      history: { ...initialHistory, jobs: [], selectedIds: new Set<string>() },
    });
    vi.mocked(api.queue.retry).mockClear();
    vi.mocked(api.queue.retry).mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("says why a card failed", () => {
    // Grid mode is persisted, so a user whose History is set to grid saw
    // failed jobs as though nothing had gone wrong at all.
    renderGrid([
      makeFailed({ state: { error: { message: "The site blocked the request.", detail: null } } }),
    ]);
    expect(screen.getByText("The site blocked the request.")).toBeTruthy();
  });

  it("explains an interrupted card the same way the list does", () => {
    renderGrid([makeFailed({ state: { error: { message: "interrupted", detail: null } } })]);
    expect(screen.getByText(/Goop closed while this ran/)).toBeTruthy();
    expect(screen.queryByText("interrupted")).toBeNull();
  });

  it("says nothing about failure on a card that succeeded", () => {
    renderGrid([makeJob({ id: "job-done", state: "done" })]);
    expect(screen.queryByText(/Goop closed while this ran/)).toBeNull();
  });

  it("offers Retry on a failed download and dispatches it", async () => {
    const user = userEvent.setup();
    renderGrid([makeFailed({ kind: "extract" as JobKind })]);
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(api.queue.retry).toHaveBeenCalledWith("job-failed");
  });

  it("does not let the retry click open the preview underneath it", async () => {
    // The whole card is a click target for preview. Without
    // `stopPropagation` the retry also opens a preview of a job that
    // produced no file.
    const onPreview = vi.fn();
    const user = userEvent.setup();
    useAppStore.setState((s) => ({
      history: { ...s.history, jobs: [makeFailed({ kind: "extract" as JobKind })] },
    }));
    render(<HistoryGrid onPreview={onPreview} onQuickView={() => {}} />);
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("dispatches Retry from the keyboard", async () => {
    // The affordance is a `span role="button"`, because the card itself is a
    // `<button>` and nesting real ones is invalid HTML. A span gets none of
    // the native Enter/Space handling for free, so the handler that supplies
    // it has to be pinned or it can be dropped without any test noticing.
    const user = userEvent.setup();
    renderGrid([makeFailed({ kind: "extract" as JobKind })]);
    screen.getByRole("button", { name: /retry/i }).focus();
    await user.keyboard("{Enter}");
    expect(api.queue.retry).toHaveBeenCalledWith("job-failed");
  });

  it("does not let a keyboard Retry reach the card underneath it", async () => {
    // Space on the card is Quick View. Without `stopPropagation` in the
    // keydown handler, retrying with the keyboard also opens one.
    const onQuickView = vi.fn();
    const user = userEvent.setup();
    useAppStore.setState((s) => ({
      history: { ...s.history, jobs: [makeFailed({ kind: "extract" as JobKind })] },
    }));
    render(<HistoryGrid onPreview={() => {}} onQuickView={onQuickView} />);
    screen.getByRole("button", { name: /retry/i }).focus();
    await user.keyboard(" ");
    expect(api.queue.retry).toHaveBeenCalledWith("job-failed");
    expect(onQuickView).not.toHaveBeenCalled();
  });

  it("badges a failure whose message is empty rather than showing nothing", () => {
    // `failureView` has nothing renderable to return here, and the badge is
    // all that stands between that and a card that looks like a success.
    // The History row keeps these two checks separate for the same reason.
    renderGrid([makeFailed({ state: { error: { message: "", detail: null } } })]);
    expect(screen.getByText("error")).toBeTruthy();
  });

  it("leaves a successful card unbadged", () => {
    renderGrid([makeJob({ id: "job-done", state: "done" })]);
    expect(screen.queryByText("error")).toBeNull();
  });

  it("keeps Retry off non-download kinds", () => {
    // Same gate as the list and the queue row: conversion failures are
    // deterministic, so a Retry there just fails again more slowly.
    renderGrid([makeFailed({ kind: "convert" as JobKind })]);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("keeps Retry off cards that did not fail", () => {
    renderGrid([makeJob({ id: "job-done", kind: "extract" as JobKind, state: "done" })]);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("names each Retry after its own card so several failures are distinguishable", () => {
    // Every failed card's filename is "—", so an unqualified label would
    // make all of these read as the same button.
    renderGrid([
      makeFailed({ id: "job-a", payload: { url: "https://example.com/one" } } as Partial<Job>),
      makeFailed({ id: "job-b", payload: { url: "https://example.com/two" } } as Partial<Job>),
    ]);
    const names = screen
      .getAllByRole("button", { name: /retry/i })
      .map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
  });
});
