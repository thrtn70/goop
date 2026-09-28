import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HistoryGrid from "@/features/history/HistoryGrid";
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

describe("HistoryGrid verified publication review", () => {
  const uncertain = makeFailed({
    id: "job-reviewable",
    kind: "convert" as JobKind,
    state: {
      error: {
        message: "output publication is uncertain",
        detail: null,
      },
    },
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
    renderGrid([
      uncertain,
      makeFailed({ id: "job-text-only", kind: "convert" as JobKind, state: uncertain.state }),
    ]);

    expect(await screen.findByRole("button", { name: /job-reviewable/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /job-text-only/i })).toBeNull();
  });

  it("keeps the card action and Review as sibling interactive controls", async () => {
    vi.mocked(api.queue.reviewablePublicationIds).mockResolvedValue([uncertain.id]);
    const { container } = renderGrid([uncertain]);

    expect(await screen.findByRole("button", { name: /job-reviewable/i })).toBeTruthy();
    expect(container.querySelector("button [role='button']")).toBeNull();
  });

  it("serializes assessments so two rows cannot race the dialog or focus target", async () => {
    const user = userEvent.setup();
    const second = makeFailed({
      ...uncertain,
      id: "job-reviewable-two",
      payload: { url: "https://example.com/two" },
    } as Partial<Job>);
    let resolveReview!: (status: {
      kind: "observed_matching_output";
      snapshot: string;
      output_name: string;
      bytes: number;
    }) => void;
    vi.mocked(api.queue.reviewablePublicationIds).mockResolvedValue([
      uncertain.id,
      second.id,
    ]);
    vi.mocked(api.queue.reviewPublication).mockImplementation(
      () => new Promise((resolve) => { resolveReview = resolve; }),
    );
    renderGrid([uncertain, second]);

    await user.click(await screen.findByRole("button", { name: /job-reviewable\)/i }));
    const secondReview = screen.getByRole("button", { name: /job-reviewable-two/i });
    expect(secondReview.getAttribute("aria-disabled")).toBe("true");
    await user.click(secondReview);
    expect(api.queue.reviewPublication).toHaveBeenCalledTimes(1);
    expect(api.queue.reviewPublication).toHaveBeenCalledWith(uncertain.id);

    resolveReview({
      kind: "observed_matching_output",
      snapshot: "first-snapshot",
      output_name: "first.mp4",
      bytes: 2048,
    });
    expect((await screen.findByRole("dialog")).textContent).toContain("first.mp4");
  });

  it("assesses on click and requires point-in-time confirmation without Reveal", async () => {
    const user = userEvent.setup();
    vi.mocked(api.queue.reviewablePublicationIds).mockResolvedValue([uncertain.id]);
    vi.mocked(api.queue.reviewPublication).mockResolvedValue({
      kind: "observed_matching_output",
      snapshot: "grid-snapshot",
      output_name: "clip.mp4",
      bytes: 2048,
    });
    renderGrid([
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

    await user.click(await screen.findByRole("button", { name: /review uncertain publication/i }));

    expect(api.queue.reviewPublication).toHaveBeenCalledWith(uncertain.id);
    const dialog = await screen.findByRole("dialog", { name: /recover completed output/i });
    expect(dialog.textContent).toMatch(/observed at the destination during this check/i);
    expect(dialog.textContent).toMatch(/does not guarantee/i);
    expect(api.queue.recoverPublication).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /show .* in folder/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("recovers only after confirmation, refreshes History and Queue, and restores focus", async () => {
    const user = userEvent.setup();
    vi.mocked(api.queue.reviewablePublicationIds)
      .mockResolvedValueOnce([uncertain.id])
      .mockResolvedValueOnce([]);
    vi.mocked(api.queue.reviewPublication).mockResolvedValue({
      kind: "observed_matching_output",
      snapshot: "grid-snapshot",
      output_name: "clip.mp4",
      bytes: 2048,
    });
    vi.mocked(api.history.list).mockResolvedValue([makeJob({ id: "job-recovered" })]);
    renderGrid([uncertain]);

    await user.click(await screen.findByRole("button", { name: /review uncertain publication/i }));
    await user.click(await screen.findByRole("button", { name: "Recover completed output" }));

    await waitFor(() => {
      expect(api.queue.recoverPublication).toHaveBeenCalledWith(uncertain.id, "grid-snapshot");
      expect(api.history.list).toHaveBeenCalledTimes(1);
      expect(api.history.counts).toHaveBeenCalledTimes(1);
      expect(api.queue.list).toHaveBeenCalledTimes(1);
      expect(api.queue.completedSince).toHaveBeenCalledTimes(1);
      expect(api.queue.reviewablePublicationIds).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "History results" }));
  });

  it.each([
    ["unproven", "The destination no longer matches."],
    ["unsupported", "This journal version cannot be reviewed."],
    ["stale", "The job changed while it was checked."],
  ] as const)("keeps a %s assessment unresolved with its reason", async (kind, reason) => {
    const user = userEvent.setup();
    vi.mocked(api.queue.reviewablePublicationIds).mockResolvedValue([uncertain.id]);
    vi.mocked(api.queue.reviewPublication).mockResolvedValue({ kind, reason });
    renderGrid([uncertain]);

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
    renderGrid([uncertain]);

    await user.click(await screen.findByRole("button", { name: /review uncertain publication/i }));
    await user.click(await screen.findByRole("button", { name: "Recover completed output" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/The output changed\. Review it again\./i);
    expect(screen.getByRole("dialog", { name: /recover completed output/i })).toBeTruthy();
    expect(api.history.list).not.toHaveBeenCalled();
    expect(api.queue.list).not.toHaveBeenCalled();
  });

  it("supports keyboard review, traps focus, and restores the Review action on Escape", async () => {
    const onPreview = vi.fn();
    const onQuickView = vi.fn();
    const user = userEvent.setup();
    vi.mocked(api.queue.reviewablePublicationIds).mockResolvedValue([uncertain.id]);
    vi.mocked(api.queue.reviewPublication).mockResolvedValue({
      kind: "observed_matching_output",
      snapshot: "grid-snapshot",
      output_name: "clip.mp4",
      bytes: 2048,
    });
    useAppStore.setState((s) => ({ history: { ...s.history, jobs: [uncertain] } }));
    render(<HistoryGrid onPreview={onPreview} onQuickView={onQuickView} />);

    const review = await screen.findByRole("button", { name: /review uncertain publication/i });
    review.focus();
    await user.keyboard("{Enter}");
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    const recover = screen.getByRole("button", { name: "Recover completed output" });
    expect(onPreview).not.toHaveBeenCalled();
    expect(onQuickView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(cancel);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(recover);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(review);
  });

  it("refreshes structured eligibility when grid jobs change in place", async () => {
    vi.mocked(api.queue.reviewablePublicationIds)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([uncertain.id]);
    renderGrid([makeJob({ id: "job-done" })]);
    await waitFor(() => expect(api.queue.reviewablePublicationIds).toHaveBeenCalledTimes(1));

    act(() => {
      useAppStore.setState((s) => ({ history: { ...s.history, jobs: [uncertain] } }));
    });

    expect(await screen.findByRole("button", { name: /review uncertain publication/i })).toBeTruthy();
    expect(api.queue.reviewablePublicationIds).toHaveBeenCalledTimes(2);
  });
});
