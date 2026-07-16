import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QueueRow from "@/features/queue/QueueRow";
import { useAppStore } from "@/store/appStore";
import type { Job } from "@/types";

// --- IPC mock ---

const queueMocks = vi.hoisted(() => ({
  pause: vi.fn().mockResolvedValue(undefined),
  resume: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockResolvedValue(undefined),
  retry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/ipc/commands", () => ({
  api: {
    queue: queueMocks,
  },
}));

// --- Fixtures ---

function makeJob(overrides: Partial<Job> = {}): Job {
  const base: Job = {
    id: "00000000-0000-7000-8000-000000000000",
    kind: "convert",
    state: "running",
    payload: { input_path: "/tmp/in.mp4", target: "mp4" },
    result: null,
    priority: 0,
    attempts: 0,
    created_at: BigInt(1_700_000_000_000),
    started_at: null,
    finished_at: null,
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  useAppStore.setState({
    progressById: {},
    ui: {
      ...useAppStore.getState().ui,
      queueSelectedIds: new Set(),
    },
  });
  useAppStore.setState({ toasts: [] });
  queueMocks.pause.mockClear();
  queueMocks.pause.mockResolvedValue(undefined);
  queueMocks.resume.mockClear();
  queueMocks.cancel.mockClear();
  queueMocks.retry.mockClear();
  queueMocks.retry.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("QueueRow pause/resume controls", () => {
  it("shows a pause button on a running video conversion", () => {
    render(<QueueRow job={makeJob({ state: "running" })} index={0} />);
    expect(screen.getByRole("button", { name: /^Pause/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Cancel/ })).toBeTruthy();
  });

  it("hides the pause button on a running image conversion", () => {
    render(
      <QueueRow
        job={makeJob({
          state: "running",
          payload: { input_path: "/tmp/in.png", target: "png" },
        })}
        index={0}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Pause/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Cancel/ })).toBeTruthy();
  });

  it("shows the pause button on a running yt-dlp extract job", () => {
    render(
      <QueueRow
        job={makeJob({
          state: "running",
          kind: "extract",
          payload: { url: "https://example.com/video" },
        })}
        index={0}
      />,
    );
    expect(screen.getByRole("button", { name: /^Pause/ })).toBeTruthy();
  });

  it("shows the pause button on a running gallery-dl extract job", () => {
    // Pausability is kind-wide for downloads, not extractor-specific.
    render(
      <QueueRow
        job={makeJob({
          state: "running",
          kind: "extract",
          payload: { url: "https://bunkr.cr/a/abc" },
        })}
        index={0}
      />,
    );
    expect(screen.getByRole("button", { name: /^Pause/ })).toBeTruthy();
  });

  it("calls api.queue.pause when pausing a running extract job", async () => {
    const user = userEvent.setup();
    const job = makeJob({
      state: "running",
      kind: "extract",
      payload: { url: "https://example.com/video" },
    });
    render(<QueueRow job={job} index={0} />);
    await user.click(screen.getByRole("button", { name: /^Pause/ }));
    expect(queueMocks.pause).toHaveBeenCalledOnce();
    expect(queueMocks.pause).toHaveBeenCalledWith(job.id);
  });

  it("disables the pause button and shows a pausing state after a click", async () => {
    const user = userEvent.setup();
    const job = makeJob({
      state: "running",
      kind: "extract",
      payload: { url: "https://example.com/video" },
    });
    render(<QueueRow job={job} index={0} />);
    await user.click(screen.getByRole("button", { name: /^Pause/ }));
    const btn = screen.getByRole("button", { name: /^Pause/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText("pausing…")).toBeTruthy();
    // Row keeps its running visuals until the Paused event arrives.
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("clears the pausing state when the job leaves running", async () => {
    const user = userEvent.setup();
    const job = makeJob({
      state: "running",
      kind: "extract",
      payload: { url: "https://example.com/video" },
    });
    const { rerender } = render(<QueueRow job={job} index={0} />);
    await user.click(screen.getByRole("button", { name: /^Pause/ }));
    expect(screen.getByText("pausing…")).toBeTruthy();
    rerender(<QueueRow job={{ ...job, state: "paused" }} index={0} />);
    expect(screen.getByRole("button", { name: /^Resume/ })).toBeTruthy();
    expect(screen.queryByText("pausing…")).toBeNull();
  });

  it("re-enables the pause button when the pause IPC fails", async () => {
    const user = userEvent.setup();
    queueMocks.pause.mockRejectedValueOnce({ code: "unknown", message: "boom" });
    const job = makeJob({
      state: "running",
      kind: "extract",
      payload: { url: "https://example.com/video" },
    });
    render(<QueueRow job={job} index={0} />);
    await user.click(screen.getByRole("button", { name: /^Pause/ }));
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /^Pause/ }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
    expect(screen.getByText("pause")).toBeTruthy();
    const toasts = useAppStore.getState().toasts;
    expect(toasts.some((t) => t.title === "Couldn't pause")).toBe(true);
  });

  it("retries pause on job_not_running before surfacing the failure", async () => {
    const user = userEvent.setup();
    queueMocks.pause.mockRejectedValue({ code: "queue", message: "job_not_running" });
    const job = makeJob({
      state: "running",
      kind: "extract",
      payload: { url: "https://example.com/video" },
    });
    render(<QueueRow job={job} index={0} />);
    await user.click(screen.getByRole("button", { name: /^Pause/ }));
    await waitFor(() => {
      expect(queueMocks.pause).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      const toasts = useAppStore.getState().toasts;
      expect(toasts.some((t) => t.title === "Couldn't pause")).toBe(true);
    });
  });

  it("shows the pause button on a running PDF compress job", () => {
    render(
      <QueueRow
        job={makeJob({
          state: "running",
          kind: "pdf",
          payload: {
            kind: "compress",
            input: "/tmp/in.pdf",
            output_path: "/tmp/out.pdf",
            quality: "ebook",
          },
        })}
        index={0}
      />,
    );
    expect(screen.getByRole("button", { name: /^Pause/ })).toBeTruthy();
  });

  it("hides the pause button on a PDF merge job", () => {
    render(
      <QueueRow
        job={makeJob({
          state: "running",
          kind: "pdf",
          payload: {
            kind: "merge",
            inputs: ["/tmp/a.pdf", "/tmp/b.pdf"],
            output_path: "/tmp/out.pdf",
          },
        })}
        index={0}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Pause/ })).toBeNull();
  });

  it("shows resume + cancel on a paused job", () => {
    render(<QueueRow job={makeJob({ state: "paused" })} index={0} />);
    expect(screen.getByRole("button", { name: /^Resume/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Cancel/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Pause/ })).toBeNull();
  });

  it("renders ETA — for a paused job", () => {
    render(<QueueRow job={makeJob({ state: "paused" })} index={0} />);
    expect(screen.getByText(/ETA/)).toBeTruthy();
  });

  it("calls api.queue.pause with the correct jobId when Pause is clicked", async () => {
    const user = userEvent.setup();
    const job = makeJob({ state: "running" });
    render(<QueueRow job={job} index={0} />);
    await user.click(screen.getByRole("button", { name: /^Pause/ }));
    expect(queueMocks.pause).toHaveBeenCalledOnce();
    expect(queueMocks.pause).toHaveBeenCalledWith(job.id);
  });

  it("calls api.queue.resume with the correct jobId when Resume is clicked", async () => {
    const user = userEvent.setup();
    const job = makeJob({ state: "paused" });
    render(<QueueRow job={job} index={0} />);
    await user.click(screen.getByRole("button", { name: /^Resume/ }));
    expect(queueMocks.resume).toHaveBeenCalledOnce();
    expect(queueMocks.resume).toHaveBeenCalledWith(job.id);
  });

  it("hides the pause button on a convert job whose payload has no target", () => {
    render(
      <QueueRow
        job={makeJob({
          state: "running",
          payload: { input_path: "/tmp/in.mp4" },
        })}
        index={0}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Pause/ })).toBeNull();
  });

  it("hides the pause button on a convert job whose target is null", () => {
    render(
      <QueueRow
        job={makeJob({
          state: "running",
          payload: { input_path: "/tmp/in.mp4", target: null },
        })}
        index={0}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Pause/ })).toBeNull();
  });
});

describe("QueueRow folder progress (gallery-dl)", () => {
  it("renders the file-count stage instead of percent for gallery-dl jobs", () => {
    const job = makeJob({
      kind: "extract",
      state: "running",
      payload: { url: "https://bunkr.cr/a/abc" },
    });
    useAppStore.setState({
      progressById: {
        [job.id]: {
          percent: 0,
          eta_secs: null,
          speed_hr: null,
          encoder: null,
          stage: "downloaded 12 file(s)",
        },
      },
    });
    render(<QueueRow job={job} index={0} />);
    expect(screen.getByText("downloaded 12 file(s)")).toBeTruthy();
    // The 0.0% percent column should be hidden for folder-mode progress.
    expect(screen.queryByText("0.0%")).toBeNull();
  });

  it("keeps percent + ETA layout for yt-dlp jobs (no folder stage)", () => {
    const job = makeJob({
      kind: "extract",
      state: "running",
      payload: { url: "https://youtube.com/watch?v=abc" },
    });
    useAppStore.setState({
      progressById: {
        [job.id]: {
          percent: 42.5,
          eta_secs: 30,
          speed_hr: "1.2MiB/s",
          encoder: null,
          stage: "downloading",
        },
      },
    });
    render(<QueueRow job={job} index={0} />);
    expect(screen.getByText("42.5%")).toBeTruthy();
    expect(screen.getByText("1.2MiB/s")).toBeTruthy();
  });
});

describe("QueueRow retry button and error text", () => {
  it("shows a retry button on a failed extract job", () => {
    render(
      <QueueRow
        job={makeJob({
          kind: "extract",
          state: { error: { message: "HTTP 403" } },
          payload: { url: "https://example.com/video" },
        })}
        index={0}
      />,
    );
    expect(screen.getByRole("button", { name: /^Retry/ })).toBeTruthy();
  });

  it("hides the retry button on a failed convert job", () => {
    render(
      <QueueRow job={makeJob({ state: { error: { message: "boom" } } })} index={0} />,
    );
    expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
  });

  it("hides the retry button on done and cancelled extract jobs", () => {
    const base = { kind: "extract" as const, payload: { url: "https://x.com/v" } };
    const { rerender } = render(
      <QueueRow job={makeJob({ ...base, state: "cancelled" })} index={0} />,
    );
    expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
    rerender(
      <QueueRow
        job={makeJob({
          ...base,
          state: "done",
          result: {
            output_path: "/tmp/out.mp4",
            bytes: null,
            duration_ms: BigInt(1),
            result_kind: "file",
            file_count: 1,
          },
        })}
        index={0}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
  });

  it("calls api.queue.retry with the jobId when Retry is clicked", async () => {
    const user = userEvent.setup();
    const job = makeJob({
      kind: "extract",
      state: { error: { message: "connection reset" } },
      payload: { url: "https://example.com/video" },
    });
    render(<QueueRow job={job} index={0} />);
    await user.click(screen.getByRole("button", { name: /^Retry/ }));
    expect(queueMocks.retry).toHaveBeenCalledOnce();
    expect(queueMocks.retry).toHaveBeenCalledWith(job.id);
  });

  it("shows a toast when retry fails", async () => {
    const user = userEvent.setup();
    queueMocks.retry.mockRejectedValueOnce({ code: "queue", message: "job_not_retryable" });
    const job = makeJob({
      kind: "extract",
      state: { error: { message: "boom" } },
      payload: { url: "https://example.com/video" },
    });
    render(<QueueRow job={job} index={0} />);
    await user.click(screen.getByRole("button", { name: /^Retry/ }));
    await waitFor(() => {
      const toasts = useAppStore.getState().toasts;
      expect(toasts.some((t) => t.title === "Couldn't retry")).toBe(true);
    });
  });

  it("renders the error message text on a failed row", () => {
    render(
      <QueueRow
        job={makeJob({
          kind: "extract",
          state: { error: { message: "connection reset by peer" } },
          payload: { url: "https://example.com/video" },
        })}
        index={0}
      />,
    );
    expect(screen.getByText("connection reset by peer")).toBeTruthy();
    expect(screen.getByTitle("connection reset by peer")).toBeTruthy();
  });

  it("renders no message line when the failure message is empty", () => {
    const { container } = render(
      <QueueRow
        job={makeJob({
          kind: "extract",
          state: { error: { message: "" } },
          payload: { url: "https://example.com/video" },
        })}
        index={0}
      />,
    );
    expect(container.querySelector(".text-error\\/80")).toBeNull();
  });
});

describe("QueueRow auto-retry stage rendering", () => {
  it("renders the retrying stage instead of percent during backoff", () => {
    const job = makeJob({
      kind: "extract",
      state: "running",
      payload: { url: "https://example.com/video" },
    });
    useAppStore.setState({
      progressById: {
        [job.id]: {
          percent: 37.2,
          eta_secs: 8,
          speed_hr: null,
          encoder: null,
          stage: "retrying (attempt 2/5)",
        },
      },
    });
    render(<QueueRow job={job} index={0} />);
    expect(screen.getByText("retrying (attempt 2/5)")).toBeTruthy();
    expect(screen.queryByText("37.2%")).toBeNull();
  });

  it("keeps the progress bar at the held percent during backoff", () => {
    const job = makeJob({
      kind: "extract",
      state: "running",
      payload: { url: "https://example.com/video" },
    });
    useAppStore.setState({
      progressById: {
        [job.id]: {
          percent: 37.2,
          eta_secs: 8,
          speed_hr: null,
          encoder: null,
          stage: "retrying (attempt 2/5)",
        },
      },
    });
    render(<QueueRow job={job} index={0} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("37");
  });
});
