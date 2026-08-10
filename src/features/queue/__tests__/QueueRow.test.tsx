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
    // Resume path brings the row back to running: the pause button must
    // be usable again, not stuck disabled from the previous click.
    rerender(<QueueRow job={{ ...job, state: "running" }} index={0} />);
    const btn = screen.getByRole("button", { name: /^Pause/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.getByText("pause")).toBeTruthy();
  });

  it("stays quiet when pause fails because the job already left running", async () => {
    const user = userEvent.setup();
    queueMocks.pause.mockRejectedValue({ code: "queue", message: "job_not_running" });
    const job = makeJob({
      state: "running",
      kind: "extract",
      payload: { url: "https://example.com/video" },
    });
    // Store shows the job already finished: pausing is moot, not an error.
    useAppStore.setState({ jobs: [{ ...job, state: "done" }] });
    render(<QueueRow job={job} index={0} />);
    await user.click(screen.getByRole("button", { name: /^Pause/ }));
    await waitFor(() => {
      expect(queueMocks.pause).toHaveBeenCalledTimes(3);
    });
    expect(
      useAppStore.getState().toasts.some((t) => t.title === "Couldn't pause"),
    ).toBe(false);
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
    // Store still says running: the failure is real, not a moot action.
    useAppStore.setState({ jobs: [job] });
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
          state: { error: { message: "HTTP 403", detail: null } },
          payload: { url: "https://example.com/video" },
        })}
        index={0}
      />,
    );
    expect(screen.getByRole("button", { name: /^Retry/ })).toBeTruthy();
  });

  it("hides the retry button on a failed convert job", () => {
    render(
      <QueueRow job={makeJob({ state: { error: { message: "boom", detail: null } } })} index={0} />,
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
      state: { error: { message: "connection reset", detail: null } },
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
      state: { error: { message: "boom", detail: null } },
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
          state: { error: { message: "connection reset by peer", detail: null } },
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
          state: { error: { message: "", detail: null } },
          payload: { url: "https://example.com/video" },
        })}
        index={0}
      />,
    );
    expect(container.querySelector(".text-error\\/80")).toBeNull();
  });
});

describe("QueueRow failure detail", () => {
  const MARKER = "[goop] yt-dlp auto-updated 2026.01.01 -> 2026.08.09; retried once";

  function failedRow(message: string, detail: string | null) {
    return (
      <QueueRow
        job={makeJob({
          kind: "extract",
          state: { error: { message, detail } },
          payload: { url: "https://example.com/video" },
        })}
        index={0}
      />
    );
  }

  it("hides the raw text behind a toggle and shows it on demand", async () => {
    const user = userEvent.setup();
    const raw = 'ERROR: [youtube] abc: Sign in to confirm your age\n  File "common.py"';
    const { container } = render(failedRow("age verification required", raw));

    // Closed by default: a queue row is 288px wide and a Python traceback
    // is not what someone scanning the queue came to read.
    expect(screen.getByText("age verification required")).toBeTruthy();
    expect(container.querySelector("pre")).toBeNull();

    const toggle = screen.getByRole("button", { name: /show details/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);

    // Read off the element rather than `getByText`, which collapses the
    // newlines this block exists to preserve.
    expect(container.querySelector("pre")?.textContent).toBe(raw);
    const open = screen.getByRole("button", { name: /hide details/i });
    expect(open.getAttribute("aria-expanded")).toBe("true");

    await user.click(open);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("copies the raw text to the clipboard", async () => {
    // `userEvent.setup()` installs its own clipboard stub, so the spy has
    // to go on afterwards or it is silently replaced.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const raw = "ERROR: [youtube] abc: nsig extraction failed";
    render(failedRow("Something went wrong.", raw));

    await user.click(screen.getByRole("button", { name: /show details/i }));
    await user.click(screen.getByRole("button", { name: /copy error detail/i }));

    // The point of the button is pasting into a bug report, so it has to be
    // the raw text and not the friendly rewrite.
    expect(writeText).toHaveBeenCalledWith(raw);
    expect(writeText).not.toHaveBeenCalledWith("Something went wrong.");
    expect(await screen.findByRole("button", { name: /copy error detail/i })).toHaveProperty(
      "textContent",
      "Copied",
    );
  });

  it("says so when the clipboard is unavailable instead of failing silently", async () => {
    // No `navigator.clipboard` in an insecure context or some webviews, and
    // the access itself throws rather than rejecting. A Copy button that
    // does nothing at all is worse than no button.
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    render(failedRow("Something went wrong.", "ERROR: nsig extraction failed"));

    await user.click(screen.getByRole("button", { name: /show details/i }));
    await user.click(screen.getByRole("button", { name: /copy error detail/i }));

    await waitFor(() => {
      expect(useAppStore.getState().toasts.some((t) => t.title === "Couldn't copy")).toBe(
        true,
      );
    });
  });

  it("offers no details affordance on a row that predates the column", async () => {
    // Rows written before `error_detail` existed carry null. There is
    // nothing to backfill, so the button must be absent rather than
    // present-and-empty.
    render(failedRow("The site blocked the request.", null));
    expect(screen.queryByRole("button", { name: /show details/i })).toBeNull();
  });

  it("offers no details affordance when the detail only repeats the message", () => {
    render(
      failedRow("network error: connection reset by peer", "connection reset by peer"),
    );
    expect(screen.queryByRole("button", { name: /show details/i })).toBeNull();
  });

  it("renders the auto-update note as its own line, not buried in the detail", async () => {
    const user = userEvent.setup();
    render(failedRow("The site blocked the request.", `ERROR: HTTP Error 403\n${MARKER}`));

    // Visible without expanding anything: "Goop already tried the obvious
    // fix" is the part that changes what the user does next.
    expect(screen.getByText(MARKER)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /show details/i }));
    expect(screen.getByText("ERROR: HTTP Error 403")).toBeTruthy();
  });

  it("explains an interrupted row instead of showing the bare word", () => {
    render(failedRow("interrupted", null));
    expect(screen.getByText(/Goop closed while this ran/)).toBeTruthy();
    expect(screen.queryByText("interrupted")).toBeNull();
  });

  it("copies the auto-update note along with the tool's own output", async () => {
    // The note is lifted out of the detail so it can be rendered on its own
    // line, which silently removed it from what Copy produced — dropping the
    // one Goop-specific fact a bug report needs.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(failedRow("The site blocked the request.", `ERROR: HTTP Error 403\n${MARKER}`));

    await user.click(screen.getByRole("button", { name: /show details/i }));
    await user.click(screen.getByRole("button", { name: /copy error detail/i }));

    expect(writeText).toHaveBeenCalledWith(`ERROR: HTTP Error 403\n${MARKER}`);
  });

  it("keeps the raw text reachable when the message is itself the dump", async () => {
    // The regression this whole affordance exists to prevent: no friendly
    // pattern matched, so the message IS the stderr, and a naive
    // duplicate-suppression removed the expander for exactly the failures
    // carrying the most text.
    const user = userEvent.setup();
    const stderr = [
      "ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers",
      "[matroska @ 0x7f8] Could not find codec parameters for stream 2",
      "Conversion failed!",
    ].join("\n");
    const { container } = render(failedRow(`ffmpeg: ${stderr}`, stderr));

    const toggle = screen.getByRole("button", { name: /show details/i });
    await user.click(toggle);
    expect(container.querySelector("pre")?.textContent).toContain("Conversion failed!");
  });

  it("gives each failed row its own accessible names", () => {
    // Several rows can fail at once. Buttons that all read "Show details"
    // are indistinguishable in a screen reader's control list.
    render(
      <>
        <QueueRow
          job={makeJob({
            id: "00000000-0000-7000-8000-00000000000a",
            kind: "extract",
            state: { error: { message: "a", detail: "raw a" } },
            payload: { url: "https://one.example/x" },
          })}
          index={0}
        />
        <QueueRow
          job={makeJob({
            id: "00000000-0000-7000-8000-00000000000b",
            kind: "extract",
            state: { error: { message: "b", detail: "raw b" } },
            payload: { url: "https://two.example/y" },
          })}
          index={1}
        />
      </>,
    );
    expect(screen.getByRole("button", { name: /show details for one\.example/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /show details for two\.example/i })).toBeTruthy();
  });

  it("points the toggle at the block it opens", async () => {
    const user = userEvent.setup();
    const { container } = render(failedRow("boom", "raw text"));
    const toggle = screen.getByRole("button", { name: /show details/i });
    await user.click(toggle);
    const controls = toggle.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(container.querySelector("pre")?.id).toBe(controls);
  });

  it("keeps the expanded block from widening the 288px sidebar", async () => {
    // jsdom has no layout, so this pins the mechanism rather than the
    // outcome: a traceback full of long unbroken URLs needs `break-words`
    // to wrap at all, and the height cap plus `overflow-auto` is what
    // stops a hundred-line failure pushing the rest of the queue
    // off-screen. Losing either is invisible to every other test here.
    const user = userEvent.setup();
    const { container } = render(
      failedRow("boom", `ERROR: https://example.com/${"a".repeat(300)}`),
    );
    await user.click(screen.getByRole("button", { name: /show details/i }));

    const pre = container.querySelector("pre");
    expect(pre?.className).toContain("whitespace-pre-wrap");
    expect(pre?.className).toContain("break-words");
    expect(pre?.className).toContain("overflow-auto");
    expect(pre?.className).toContain("max-h-");
    // A scroll container a keyboard user cannot focus is one they cannot
    // read past the first screenful.
    expect(pre?.getAttribute("tabindex")).toBe("0");
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
    // The backoff wait is the one number that makes this row readable as
    // "waiting" rather than as a stalled download. It rides along on
    // `eta_secs` and used to be dropped on the floor here.
    expect(screen.getByText("retrying in 8s (attempt 2/5)")).toBeTruthy();
    expect(screen.queryByText("37.2%")).toBeNull();
  });

  it("still names the attempt when the backoff wait is missing", () => {
    const job = makeJob({
      kind: "extract",
      state: "running",
      payload: { url: "https://example.com/video" },
    });
    useAppStore.setState({
      progressById: {
        [job.id]: {
          percent: 37.2,
          eta_secs: null,
          speed_hr: null,
          encoder: null,
          stage: "retrying (attempt 2/5)",
        },
      },
    });
    render(<QueueRow job={job} index={0} />);
    expect(screen.getByText("retrying (attempt 2/5)")).toBeTruthy();
  });

  it("drops the retrying stage once the job is paused", () => {
    // Pausing during backoff aborts the retry loop backend-side; the row
    // must not keep claiming a retry is pending.
    const job = makeJob({
      kind: "extract",
      state: "paused",
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
    expect(screen.queryByText("retrying (attempt 2/5)")).toBeNull();
    expect(screen.getByText("37.2%")).toBeTruthy();
    expect(screen.getByText("ETA —")).toBeTruthy();
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

describe("QueueRow debrid waiting stage", () => {
  it("shows the waiting-on-TorBox stage on a queued row", () => {
    const job = makeJob({
      kind: "extract",
      state: "queued",
      payload: { url: "magnet:?xt=urn:btih:abc" },
    });
    useAppStore.setState({
      progressById: {
        [job.id as string]: {
          percent: 0,
          eta_secs: 10,
          speed_hr: null,
          encoder: null,
          stage: "waiting on TorBox (downloading)",
        },
      },
    });
    render(<QueueRow job={job} index={0} />);
    expect(screen.getByText("waiting on TorBox (downloading)")).toBeTruthy();
  });

  it("keeps plain queued rows free of stage text", () => {
    const job = makeJob({
      kind: "extract",
      state: "queued",
      payload: { url: "https://youtube.com/watch?v=abc" },
    });
    render(<QueueRow job={job} index={0} />);
    expect(screen.queryByText(/waiting on TorBox/)).toBeNull();
  });
});
