import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useToastTriggers } from "@/hooks/useToastTriggers";
import { useAppStore } from "@/store/appStore";
import type { Job, JobState } from "@/types";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(false),
  sendNotification: vi.fn(),
}));

function Probe() {
  useToastTriggers();
  return null;
}

function makeJob(state: JobState, overrides: Partial<Job> = {}): Job {
  return {
    id: "00000000-0000-7000-8000-000000000001",
    kind: "extract",
    state,
    payload: { url: "https://example.com/video" },
    result: null,
    priority: 0,
    attempts: 0,
    created_at: BigInt(1_700_000_000_000),
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

/** One batch member, identified by index so each gets its own row. */
function batchJob(n: number, state: JobState, url: string): Job {
  return makeJob(state, {
    id: `00000000-0000-7000-8000-00000000000${n}` as Job["id"],
    payload: { url, batch_id: "batch-1" },
  });
}

function setJobs(state: JobState): void {
  act(() => {
    useAppStore.setState({ jobs: [makeJob(state)] });
  });
}

function errorToastCount(): number {
  return useAppStore.getState().toasts.filter((t) => t.variant === "error").length;
}

beforeEach(() => {
  useAppStore.setState({ jobs: [], toasts: [] });
});

afterEach(() => {
  cleanup();
});

describe("useToastTriggers across retry transitions", () => {
  it("re-toasts when a retried job fails again", () => {
    render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    );

    setJobs({ error: { message: "connection reset", detail: null } });
    expect(errorToastCount()).toBe(1);

    // Manual retry: the job leaves its terminal state...
    setJobs("queued");
    setJobs("running");
    expect(errorToastCount()).toBe(1);

    // ...and the second failure must toast again.
    setJobs({ error: { message: "connection reset again", detail: null } });
    expect(errorToastCount()).toBe(2);
  });

  it("does not double-toast while a job stays failed", () => {
    render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    );

    setJobs({ error: { message: "boom", detail: null } });
    // Unrelated store churn re-publishes the same terminal state.
    setJobs({ error: { message: "boom", detail: null } });
    expect(errorToastCount()).toBe(1);
  });
});

describe("useToastTriggers individual failure detail", () => {
  it("explains a single failure the same way its row does", () => {
    // Extract jobs are never batched, so this is THE toast for a failed
    // download — and it was the one surface still reading the raw state
    // while the queue row beside it showed the explanation.
    render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    );
    setJobs("running");
    setJobs({ error: { message: "interrupted", detail: null } });

    const toast = useAppStore.getState().toasts.at(-1);
    expect(toast?.variant).toBe("error");
    expect(toast?.detail).toMatch(/Goop closed while this ran/);
    expect(toast?.detail).not.toBe("interrupted");
  });

  it("does not put a whole stderr dump in the toast", () => {
    render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    );
    const stderr = `ffmpeg: ${"x".repeat(9000)}`;
    setJobs("running");
    setJobs({ error: { message: stderr, detail: stderr } });

    expect((useAppStore.getState().toasts.at(-1)?.detail ?? "").length).toBeLessThan(300);
  });
});

describe("useToastTriggers batch failure detail", () => {
  function failed(message: string): JobState {
    return { error: { message, detail: null } };
  }

  function runBatch(jobs: Job[]): void {
    render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    );
    // All members enqueued and running FIRST — the batch toast fires when
    // the last one leaves the queue, so they must all be visible before
    // any of them finishes, or the first to land looks like a batch of one.
    //
    // One transition per publish, which is what the queue's own events
    // produce. The other sequencing — a wholesale `api.queue.list()` snapshot
    // carrying several already-terminal members at once — is covered by
    // "batch aggregation across snapshots" below.
    const running = jobs.map((j) => ({ ...j, state: "running" as JobState }));
    act(() => {
      useAppStore.setState({ jobs: running });
    });
    for (let i = 0; i < jobs.length; i += 1) {
      act(() => {
        useAppStore.setState({
          jobs: jobs.map((j, idx) => (idx <= i ? j : running[idx]!)),
        });
      });
    }
  }

  function lastToast() {
    const toasts = useAppStore.getState().toasts;
    return toasts[toasts.length - 1];
  }

  it("names what failed instead of only counting it", () => {
    // "3 files failed" told the user nothing they could act on — not which
    // links, and not whether it was one cause or three.
    runBatch([
      batchJob(1, failed("The site blocked the request."), "https://a.example/one"),
      batchJob(2, failed("age verification required"), "https://b.example/two"),
    ]);

    const toast = lastToast();
    expect(toast?.variant).toBe("error");
    expect(toast?.title).toBe("2 files failed");
    expect(toast?.detail).toContain("a.example/one — The site blocked the request.");
    expect(toast?.detail).toContain("b.example/two — age verification required");
  });

  it("caps the list and says how many it left out", () => {
    // A forty-item batch that fails wholesale must not paste forty lines
    // into a toast.
    runBatch(
      [1, 2, 3, 4, 5].map((n) =>
        batchJob(n, failed(`reason ${n}`), `https://s${n}.example/x`),
      ),
    );

    const detail = lastToast()?.detail ?? "";
    expect(detail).toContain("reason 1");
    expect(detail).toContain("reason 3");
    expect(detail).not.toContain("reason 4");
    expect(detail).toContain("2 more");
  });

  it("explains an interrupted batch member the same way the rows do", () => {
    runBatch([batchJob(1, failed("interrupted"), "https://a.example/one")]);
    expect(lastToast()?.detail).toContain("Goop closed while this ran");
  });

  it("keeps the reasons on a partly-failed batch too", () => {
    // The common real-world outcome, and the branch that had no detail at
    // all — so the only notice of the failures was a count that
    // auto-dismisses.
    runBatch([
      batchJob(1, "done", "https://a.example/one"),
      batchJob(2, failed("The site blocked the request."), "https://b.example/two"),
    ]);
    const toast = lastToast();
    expect(toast?.title).toBe("1 done · 1 failed");
    expect(toast?.detail).toContain("b.example/two — The site blocked the request.");
  });

  it("bounds each reason so a stderr dump cannot swallow the screen", () => {
    // An error toast never auto-dismisses and grows upward from the bottom
    // of the viewport, so an unbounded line pushes its own dismiss button
    // off the top of the screen. A count cap alone does not prevent that.
    const huge = `ffmpeg: ${"x".repeat(9000)}`;
    runBatch([batchJob(1, failed(huge), "https://a.example/one")]);
    const detail = lastToast()?.detail ?? "";
    expect(detail.length).toBeLessThan(400);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("bounds the label as well as the reason", () => {
    // `failureView` clips the reason, but the label in front of it is a
    // filename and nothing clips that. A 5000-character basename is
    // unusual and entirely legal.
    const job = makeJob(failed("boom"), {
      id: "00000000-0000-7000-8000-000000000009" as Job["id"],
      kind: "convert",
      payload: { input_path: `/tmp/${"n".repeat(5000)}.mkv`, batch_id: "batch-1" },
    });
    runBatch([job]);
    const detail = lastToast()?.detail ?? "";
    expect(detail.length).toBeLessThan(400);
  });

  it("adds no detail when nothing failed", () => {
    runBatch([
      batchJob(1, "done", "https://a.example/one"),
      batchJob(2, "done", "https://b.example/two"),
    ]);
    const toast = lastToast();
    expect(toast?.variant).toBe("success");
    expect(toast?.detail).toBeUndefined();
  });
});

describe("useToastTriggers batch aggregation across snapshots", () => {
  function failed(message: string): JobState {
    return { error: { message, detail: null } };
  }

  /**
   * The other sequencing that reaches this code: `jobs` replaced wholesale by
   * an `api.queue.list()` snapshot (refresh / refreshJobs / loadAll), which can
   * carry several already-terminal members in a single publish. `applyQueue`
   * early-returns for a job not yet in `s.jobs`, so the window between
   * `ConvertActionBar`'s enqueue loop and `onEnqueued()`'s refresh is exactly
   * where fast members first appear already finished.
   */
  function publish(jobs: Job[]): void {
    act(() => {
      useAppStore.setState({ jobs });
    });
  }

  function toastCount(): number {
    return useAppStore.getState().toasts.length;
  }

  function lastToast() {
    const toasts = useAppStore.getState().toasts;
    return toasts[toasts.length - 1];
  }

  beforeEach(() => {
    render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    );
  });

  it("summarizes one batch once when two members settle in a single publish", () => {
    const jobs = [
      batchJob(1, failed("The site blocked the request."), "https://a.example/one"),
      batchJob(2, failed("age verification required"), "https://b.example/two"),
    ];
    publish(jobs.map((j) => ({ ...j, state: "running" as JobState })));
    publish(jobs);

    expect(toastCount()).toBe(1);
    const toast = lastToast();
    expect(toast?.variant).toBe("error");
    expect(toast?.title).toBe("2 files failed");
    expect(toast?.detail).toContain("a.example/one — The site blocked the request.");
    expect(toast?.detail).toContain("b.example/two — age verification required");
  });

  it("still caps the reasons when the whole batch settles at once", () => {
    const jobs = [1, 2, 3, 4, 5].map((n) =>
      batchJob(n, failed(`reason ${n}`), `https://s${n}.example/x`),
    );
    publish(jobs.map((j) => ({ ...j, state: "running" as JobState })));
    publish(jobs);

    expect(toastCount()).toBe(1);
    expect(lastToast()?.title).toBe("5 files failed");
    const detail = lastToast()?.detail ?? "";
    expect(detail).toContain("reason 1");
    expect(detail).toContain("reason 3");
    expect(detail).not.toContain("reason 4");
    expect(detail).toContain("2 more");
  });

  it("mixes outcomes from one publish into a single summary", () => {
    const jobs = [
      batchJob(1, "done", "https://a.example/one"),
      batchJob(2, failed("The site blocked the request."), "https://b.example/two"),
      batchJob(3, "cancelled", "https://c.example/three"),
    ];
    publish(jobs.map((j) => ({ ...j, state: "running" as JobState })));
    publish(jobs);

    expect(toastCount()).toBe(1);
    const toast = lastToast();
    expect(toast?.title).toBe("1 done · 1 failed · 1 cancelled");
    expect(toast?.detail).toContain("b.example/two — The site blocked the request.");
  });

  it("waits for the stragglers when a snapshot settles only part of the batch", () => {
    const jobs = [
      batchJob(1, failed("reason 1"), "https://a.example/one"),
      batchJob(2, failed("reason 2"), "https://b.example/two"),
      batchJob(3, failed("reason 3"), "https://c.example/three"),
    ];
    const running = jobs.map((j) => ({ ...j, state: "running" as JobState }));
    publish(running);
    // Two land together, the third is still going: nothing to summarize yet.
    publish([jobs[0]!, jobs[1]!, running[2]!]);
    expect(toastCount()).toBe(0);

    publish(jobs);
    expect(toastCount()).toBe(1);
    expect(lastToast()?.title).toBe("3 files failed");
  });

  it("stays silent while any member is still going", () => {
    // The flush now runs once per publish rather than once per member, so
    // guard the other direction too: repeated snapshots that settle more of
    // the batch must not summarize it early.
    const jobs = [1, 2, 3, 4].map((n) =>
      batchJob(n, failed(`reason ${n}`), `https://s${n}.example/x`),
    );
    const running = jobs.map((j) => ({ ...j, state: "running" as JobState }));
    publish(running);

    for (let settled = 1; settled < jobs.length; settled += 1) {
      publish(jobs.map((j, idx) => (idx < settled ? j : running[idx]!)));
      expect(toastCount()).toBe(0);
    }

    publish(jobs);
    expect(toastCount()).toBe(1);
    expect(lastToast()?.title).toBe("4 files failed");
  });

  it("keeps separate batches separate within one publish", () => {
    const first = [
      batchJob(1, failed("reason 1"), "https://a.example/one"),
      batchJob(2, failed("reason 2"), "https://b.example/two"),
    ];
    const second = [3, 4].map((n) =>
      makeJob("done", {
        id: `00000000-0000-7000-8000-00000000000${n}` as Job["id"],
        payload: { url: `https://c.example/${n}`, batch_id: "batch-2" },
      }),
    );
    const all = [...first, ...second];
    publish(all.map((j) => ({ ...j, state: "running" as JobState })));
    publish(all);

    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts.map((t) => t.title).sort()).toEqual(["2 files downloaded", "2 files failed"]);
  });
});
