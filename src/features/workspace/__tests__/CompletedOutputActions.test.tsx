import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Job } from "@/types";
import { useAppStore } from "@/store/appStore";
import CompletedOutputActions from "../CompletedOutputActions";

const mocks = vi.hoisted(() => ({
  open: vi.fn().mockResolvedValue(undefined),
  reveal: vi.fn().mockResolvedValue(undefined),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/ipc/commands", () => ({
  api: {
    output: { open: mocks.open },
    queue: { reveal: mocks.reveal },
  },
}));

function job(resultKind: "file" | "folder" = "file", kind: Job["kind"] = "extract", files?: string[]): Job {
  return {
    id: "source-job",
    kind,
    state: "done",
    payload: null,
    result: {
      output_path: resultKind === "file" ? "/tmp/movie.mp4" : "/tmp/album",
      result_kind: resultKind,
      file_count: resultKind === "folder" ? 3 : 1,
      files,
      bytes: 1n,
      duration_ms: 1n,
    },
    priority: 0,
    attempts: 1,
    created_at: 1n,
    started_at: 1n,
    finished_at: 2n,
  } as Job;
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ toasts: [] });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
});

afterEach(cleanup);

describe("CompletedOutputActions", () => {
  it("runs file utilities and keeps both workflow handoffs deliberate", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const onHandoff = vi.fn();
    const outputJob = job();
    render(<CompletedOutputActions job={outputJob} variant="panel" onHandoff={onHandoff} />);

    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(mocks.open).toHaveBeenCalledWith("/tmp/movie.mp4", "file");
    await user.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(mocks.reveal).toHaveBeenCalledWith("/tmp/movie.mp4");
    await user.click(screen.getByRole("button", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledWith("/tmp/movie.mp4");
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe("Path copied");

    await user.click(screen.getByRole("button", { name: "Convert…" }));
    await user.click(screen.getByRole("button", { name: "Compress…" }));
    expect(onHandoff.mock.calls).toEqual([
      [outputJob, "convert"],
      [outputJob, "compress"],
    ]);
  });

  it("hands off an album with a recorded list", async () => {
    const user = userEvent.setup();
    const onHandoff = vi.fn();
    const album = job("folder", "extract", ["1.jpg"]);
    render(<CompletedOutputActions job={album} variant="panel" onHandoff={onHandoff} />);
    await user.click(screen.getByRole("button", { name: "Compress…" }));
    expect(onHandoff).toHaveBeenCalledWith(album, "compress");
  });

  it("shows an older album's handoffs disabled with the reason", async () => {
    const user = userEvent.setup();
    const onHandoff = vi.fn();
    render(<CompletedOutputActions job={job("folder")} variant="modal" onHandoff={onHandoff} />);
    const convert = screen.getByRole("button", { name: "Convert…" }) as HTMLButtonElement;
    expect(convert.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Compress…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Downloaded before v0.3.9: use Show in Finder")).toBeTruthy();
    expect(convert.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(convert.getAttribute("aria-describedby")!)?.textContent).toBe("Downloaded before v0.3.9: use Show in Finder");
    await user.click(convert);
    expect(onHandoff).not.toHaveBeenCalled();
  });

  it("keeps other folder actions truthful and excludes workflow handoffs", () => {
    render(<CompletedOutputActions job={job("folder", "pdf")} variant="modal" onHandoff={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show in Finder" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Convert…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compress…" })).toBeNull();
  });

  it("reports action-specific failures without changing the result", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    mocks.open.mockRejectedValueOnce(new Error("moved"));
    mocks.reveal.mockRejectedValueOnce(new Error("missing"));
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<CompletedOutputActions job={job()} variant="panel" onHandoff={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe("Couldn't open output");
    await user.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe("Couldn't show in Finder");
    await user.click(screen.getByRole("button", { name: "Copy path" }));
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe("Couldn't copy path");
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });
});
