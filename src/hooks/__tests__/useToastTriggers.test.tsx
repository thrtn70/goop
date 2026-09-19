import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { useToastTriggers } from "@/hooks/useToastTriggers";
import { api } from "@/ipc/commands";
import { useAppStore } from "@/store/appStore";
import {
  finishSubmission,
  setSubmissionBatch,
  setSubmissionPhase,
  tryBegin,
  useWorkspaceSubmissions,
} from "@/store/workspaceSubmissions";
import type { Job, JobState } from "@/types";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(false),
  sendNotification: vi.fn(),
}));

function Probe() {
  useToastTriggers();
  return null;
}

function HydrateBeforePassiveEffect({ jobs }: { jobs: Job[] }) {
  useLayoutEffect(() => {
    useAppStore.setState({ jobs, queueSnapshotGeneration: 1 });
  }, [jobs]);
  return <Probe />;
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
  useAppStore.setState({
    jobs: [],
    toasts: [],
    queueRequestGeneration: 0,
    queueSnapshotGeneration: 0,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useWorkspaceSubmissions.setState({
    convert: { active: null, error: null },
    compress: { active: null, error: null },
  });
});

describe("useToastTriggers across retry transitions", () => {
  it("treats the delayed bootstrap snapshot as history", () => {
    render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    );

    const completed = makeJob("done", {
      result: {
        output_path: "/tmp/restored-history.mp4",
        bytes: BigInt(128),
        duration_ms: BigInt(10),
        result_kind: "file",
        file_count: 1,
      },
    });
    act(() => {
      useAppStore.setState({ jobs: [completed], queueSnapshotGeneration: 1 });
    });

    expect(useAppStore.getState().toasts).toHaveLength(0);

    const newJob = makeJob("running", {
      id: "00000000-0000-7000-8000-000000000003" as Job["id"],
      payload: { url: "https://example.com/after-bootstrap" },
    });
    act(() => {
      useAppStore.setState({
        jobs: [completed, newJob],
        queueSnapshotGeneration: 2,
      });
    });
    act(() => {
      useAppStore.setState({
        jobs: [completed, { ...newJob, state: "done" }],
        queueSnapshotGeneration: 3,
      });
    });

    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toContain("after-bootstrap");
  });

  it("does not suppress the first completion when hydration lands before effect setup", () => {
    const running = makeJob("running", {
      payload: { url: "https://example.com/render-effect-race" },
    });
    render(
      <MemoryRouter>
        <HydrateBeforePassiveEffect jobs={[running]} />
      </MemoryRouter>,
    );

    act(() => {
      useAppStore.setState({
        jobs: [{ ...running, state: "done" }],
        queueSnapshotGeneration: 2,
      });
    });

    expect(useAppStore.getState().toasts).toHaveLength(1);
    expect(useAppStore.getState().toasts[0]?.title).toContain("render-effect-race");
  });

  it("retains settled members from a partially complete bootstrap batch", () => {
    render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    );

    const completed = batchJob(1, "done", "https://example.com/already-done");
    const running = batchJob(2, "running", "https://example.com/finishes-later");
    act(() => {
      useAppStore.setState({
        jobs: [completed, running],
        queueSnapshotGeneration: 1,
      });
    });
    expect(useAppStore.getState().toasts).toHaveLength(0);

    act(() => {
      useAppStore.setState({
        jobs: [completed, { ...running, state: "done" }],
        queueSnapshotGeneration: 2,
      });
    });

    expect(useAppStore.getState().toasts).toHaveLength(1);
    expect(useAppStore.getState().toasts[0]?.title).toBe("2 files downloaded");
  });

  it("does not replay terminal history when a later queue update arrives", () => {
    const completed = makeJob("done", {
      result: {
        output_path: "/tmp/already-finished.mp4",
        bytes: BigInt(128),
        duration_ms: BigInt(10),
        result_kind: "file",
        file_count: 1,
      },
    });
    useAppStore.setState({ jobs: [completed] });

    render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    );

    const newJob = makeJob("running", {
      id: "00000000-0000-7000-8000-000000000002" as Job["id"],
      payload: { url: "https://example.com/new-video" },
    });
    act(() => {
      useAppStore.setState({ jobs: [completed, newJob] });
    });

    expect(useAppStore.getState().toasts).toHaveLength(0);

    act(() => {
      useAppStore.setState({ jobs: [completed, { ...newJob, state: "done" }] });
    });
    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toContain("new-video");
  });

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

  it("waits for batch submission to finish before summarizing fast members", async () => {
    const jobs = [
      batchJob(1, "done", "https://a.example/one"),
      batchJob(2, failed("The site blocked the request."), "https://b.example/two"),
      batchJob(3, "cancelled", "https://c.example/three"),
    ];
    act(() => {
      useAppStore.setState({
        jobs: [],
        queueRequestGeneration: 1,
        queueSnapshotGeneration: 1,
      });
    });
    let token = 0;
    act(() => {
      token = tryBegin("convert")!;
      setSubmissionPhase("convert", token, "enqueuing");
    });

    // Native IPC can publish a very fast first completion while sibling
    // queue commands are still being admitted. That partial snapshot must
    // not be mistaken for a one-item batch.
    publish([jobs[0]!]);
    expect(toastCount()).toBe(0);

    const list = vi.spyOn(api.queue, "list").mockResolvedValueOnce([...jobs]);
    act(() => finishSubmission("convert", token, null));

    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    await waitFor(() => expect(useAppStore.getState().jobs).toEqual(jobs));
    expect(toastCount()).toBe(1);
    expect(lastToast()?.title).toBe("1 done · 1 failed · 1 cancelled");
  });

  it("does not classify an active batch as history during delayed bootstrap", async () => {
    const jobs = [
      batchJob(1, "done", "https://a.example/one"),
      batchJob(2, failed("The site blocked the request."), "https://b.example/two"),
      batchJob(3, "cancelled", "https://c.example/three"),
    ];
    let token = 0;
    act(() => {
      token = tryBegin("convert")!;
      setSubmissionPhase("convert", token, "enqueuing");
      setSubmissionBatch("convert", token, "batch-1");
    });

    // This is the first accepted queue snapshot after mount. Existing
    // terminal history must be seeded, but the active batch member is live.
    act(() => {
      useAppStore.setState({
        jobs: [jobs[0]!],
        queueRequestGeneration: 1,
        queueSnapshotGeneration: 1,
      });
    });
    expect(toastCount()).toBe(0);

    vi.spyOn(api.queue, "list").mockResolvedValueOnce([...jobs]);
    act(() => finishSubmission("convert", token, null));

    await waitFor(() => expect(toastCount()).toBe(1));
    expect(lastToast()?.title).toBe("1 done · 1 failed · 1 cancelled");
  });

  it("retains a closing batch when its refresh is the first snapshot", async () => {
    const jobs = [
      batchJob(1, "done", "https://a.example/one"),
      batchJob(2, failed("The site blocked the request."), "https://b.example/two"),
      batchJob(3, "cancelled", "https://c.example/three"),
    ];
    let token = 0;
    act(() => {
      token = tryBegin("convert")!;
      setSubmissionPhase("convert", token, "enqueuing");
      setSubmissionBatch("convert", token, "batch-1");
    });

    const list = vi.spyOn(api.queue, "list").mockResolvedValueOnce([...jobs]);
    act(() => finishSubmission("convert", token, null));

    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    await waitFor(() => expect(toastCount()).toBe(1));
    expect(lastToast()?.title).toBe("1 done · 1 failed · 1 cancelled");
  });

  it("retains one closing batch while the other tool is still enqueuing", async () => {
    const jobs = [
      batchJob(1, "done", "https://a.example/one"),
      batchJob(2, failed("The site blocked the request."), "https://b.example/two"),
      batchJob(3, "cancelled", "https://c.example/three"),
    ];
    let convertToken = 0;
    let compressToken = 0;
    act(() => {
      convertToken = tryBegin("convert")!;
      setSubmissionPhase("convert", convertToken, "enqueuing");
      setSubmissionBatch("convert", convertToken, "batch-1");
      compressToken = tryBegin("compress")!;
      setSubmissionPhase("compress", compressToken, "enqueuing");
      setSubmissionBatch("compress", compressToken, "batch-2");
      finishSubmission("convert", convertToken, null);
    });

    act(() => {
      useAppStore.setState({
        jobs,
        queueRequestGeneration: 1,
        queueSnapshotGeneration: 1,
      });
    });
    expect(toastCount()).toBe(0);

    vi.spyOn(api.queue, "list").mockResolvedValueOnce([...jobs]);
    act(() => finishSubmission("compress", compressToken, null));

    await waitFor(() => expect(toastCount()).toBe(1));
    expect(lastToast()?.title).toBe("1 done · 1 failed · 1 cancelled");
  });

  it("does not flush a partial batch while the closing refresh is unresolved", async () => {
    const jobs = [
      batchJob(1, "done", "https://a.example/one"),
      batchJob(2, failed("The site blocked the request."), "https://b.example/two"),
      batchJob(3, "cancelled", "https://c.example/three"),
    ];
    act(() => {
      useAppStore.setState({
        jobs: [],
        queueRequestGeneration: 1,
        queueSnapshotGeneration: 1,
      });
    });
    let token = 0;
    act(() => {
      token = tryBegin("convert")!;
      setSubmissionPhase("convert", token, "enqueuing");
    });

    let resolveList!: (jobs: Job[]) => void;
    const closingSnapshot = new Promise<Job[]>((resolve) => {
      resolveList = resolve;
    });
    const list = vi.spyOn(api.queue, "list").mockReturnValueOnce(closingSnapshot);
    act(() => finishSubmission("convert", token, null));
    await waitFor(() => expect(list).toHaveBeenCalledOnce());

    // A queue event can finish an older partial refresh after admission has
    // closed. Its generation is below the closing refresh's barrier.
    publish([jobs[0]!]);
    expect(toastCount()).toBe(0);

    await act(async () => resolveList([...jobs]));
    await waitFor(() => expect(toastCount()).toBe(1));
    expect(lastToast()?.title).toBe("1 done · 1 failed · 1 cancelled");
  });

  it("retries a failed closing refresh and eventually releases the batch", async () => {
    const jobs = [
      batchJob(1, "done", "https://a.example/one"),
      batchJob(2, failed("The site blocked the request."), "https://b.example/two"),
      batchJob(3, "cancelled", "https://c.example/three"),
    ];
    act(() => {
      useAppStore.setState({
        jobs: [],
        queueRequestGeneration: 1,
        queueSnapshotGeneration: 1,
      });
    });
    let token = 0;
    act(() => {
      token = tryBegin("convert")!;
      setSubmissionPhase("convert", token, "enqueuing");
    });
    publish(jobs);
    expect(toastCount()).toBe(0);

    const list = vi
      .spyOn(api.queue, "list")
      .mockRejectedValue(new Error("queue unavailable"));
    act(() => finishSubmission("convert", token, null));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(toastCount()).toBe(1));
    expect(lastToast()?.title).toBe("1 done · 1 failed · 1 cancelled");
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
