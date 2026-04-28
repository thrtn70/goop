import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QueueRow from "@/features/queue/QueueRow";
import { useAppStore } from "@/store/appStore";
import type { Job } from "@/types";

// --- IPC mock ---

const queueMocks = vi.hoisted(() => ({
  pause: vi.fn().mockResolvedValue(undefined),
  resume: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockResolvedValue(undefined),
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
  queueMocks.pause.mockClear();
  queueMocks.resume.mockClear();
  queueMocks.cancel.mockClear();
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

  it("hides the pause button on a running yt-dlp extract job", () => {
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
    expect(screen.queryByRole("button", { name: /^Pause/ })).toBeNull();
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
