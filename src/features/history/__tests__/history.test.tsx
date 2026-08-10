import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HistoryFilterChips from "@/features/history/HistoryFilterChips";
import PdfOperationPicker from "@/features/pdf/PdfOperationPicker";
import DeleteMenu from "@/features/preview/DeleteMenu";
import { api } from "@/ipc/commands";
import { useAppStore } from "@/store/appStore";
import { restoreStoreActions } from "@/test/storeActions";
import type { HistoryCounts, Job, JobKind } from "@/types";

vi.mock("@/ipc/commands", () => ({
  api: {
    queue: { list: vi.fn(), reveal: vi.fn(), cancel: vi.fn(), clearCompleted: vi.fn() },
    history: { list: vi.fn().mockResolvedValue([]), counts: vi.fn() },
    job: {
      forget: vi.fn().mockResolvedValue(undefined),
      forgetMany: vi.fn().mockResolvedValue(0),
    },
    file: { moveToTrash: vi.fn().mockResolvedValue(undefined) },
    settings: { set: vi.fn() },
  },
}));

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    kind: "convert" as JobKind,
    state: "done",
    payload: null,
    result: { output_path: "/tmp/out.mp4", bytes: BigInt(1024), duration_ms: BigInt(1000) },
    priority: 0,
    attempts: 0,
    created_at: BigInt(1),
    started_at: null,
    finished_at: BigInt(1),
    ...overrides,
  } as unknown as Job;
}

// Several tests below swap a store action for a spy. Zustand keeps that
// binding for the rest of the file, so put the real implementations back before
// each test rather than leaving the next one to run against a stale spy.
beforeEach(restoreStoreActions);

function resetStoreHistory(counts: HistoryCounts | null, kind: JobKind | null = null) {
  useAppStore.setState((s) => ({
    history: {
      ...s.history,
      counts,
      kind,
      jobs: [],
      selectedIds: new Set(),
      previewSelectedId: null,
    },
  }));
}

describe("HistoryFilterChips", () => {
  afterEach(cleanup);
  beforeEach(() => resetStoreHistory({ all: 10, extract: 3, convert: 5, pdf: 2 }));

  it("renders every kind with its count", () => {
    render(<HistoryFilterChips />);
    expect(screen.getByRole("button", { name: /All 10/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /Extract 3/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /Convert 5/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /PDF 2/ })).toBeDefined();
  });

  it("clicking PDF sets kind filter to 'pdf'", async () => {
    const setKind = vi.fn();
    useAppStore.setState({ setHistoryKind: setKind });
    render(<HistoryFilterChips />);
    await userEvent.click(screen.getByRole("button", { name: /PDF 2/ }));
    expect(setKind).toHaveBeenCalledWith("pdf");
  });

  it("marks the active chip with aria-pressed", () => {
    resetStoreHistory({ all: 10, extract: 3, convert: 5, pdf: 2 }, "convert");
    render(<HistoryFilterChips />);
    const convert = screen.getByRole("button", { name: /Convert 5/ });
    expect(convert.getAttribute("aria-pressed")).toBe("true");
    const all = screen.getByRole("button", { name: /All 10/ });
    expect(all.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("PdfOperationPicker", () => {
  afterEach(cleanup);

  // v0.2.3 dropped role="radio" in favor of plain <button aria-pressed>
  // because the picker has no roving-tabindex / arrow-key cycling
  // (the ARIA radio contract requires both). Tests use role="button"
  // and assert on aria-pressed accordingly.

  it("disables every op except Merge on multi-file drops", () => {
    render(
      <PdfOperationPicker selected="merge" onSelect={() => {}} multiFile={true} />,
    );
    const merge = screen.getByRole("button", { name: /Merge/ });
    expect(merge).toHaveProperty("disabled", false);
    for (const label of [
      "Split",
      "Compress",
      "Extract pages",
      "Reorder pages",
      "Delete pages",
      "Rotate pages",
      "Insert blank pages",
      "Edit metadata",
    ]) {
      expect(
        screen.getByRole("button", { name: new RegExp(label) }),
      ).toHaveProperty("disabled", true);
    }
  });

  it("enables every op on single-file drops", () => {
    render(
      <PdfOperationPicker selected="split" onSelect={() => {}} multiFile={false} />,
    );
    for (const label of [
      "Merge",
      "Split",
      "Compress",
      "Extract pages",
      "Reorder pages",
      "Delete pages",
      "Rotate pages",
      "Insert blank pages",
      "Edit metadata",
    ]) {
      expect(
        screen.getByRole("button", { name: new RegExp(label) }),
      ).toHaveProperty("disabled", false);
    }
  });

  it("marks the selected operation with aria-pressed=true", () => {
    render(<PdfOperationPicker selected="compress" onSelect={() => {}} multiFile={false} />);
    expect(
      screen.getByRole("button", { name: /Compress/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: /Merge/ }).getAttribute("aria-pressed"),
    ).toBe("false");
  });
});

describe("DeleteMenu", () => {
  afterEach(cleanup);
  beforeEach(() => {
    resetStoreHistory({ all: 0, extract: 0, convert: 0, pdf: 0 });
    vi.mocked(api.file.moveToTrash).mockClear();
    vi.mocked(api.job.forget).mockClear();
  });

  it("shows both options when the menu opens", async () => {
    render(<DeleteMenu job={makeJob()} />);
    await userEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(screen.getByRole("menuitem", { name: /Remove from history/ })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Move to Trash/ })).toBeDefined();
  });

  it("Remove from history calls forgetJobs", async () => {
    const forgetJobs = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ forgetJobs });
    render(<DeleteMenu job={makeJob()} />);
    await userEvent.click(screen.getByRole("button", { name: /Delete/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Remove from history/ }));
    expect(forgetJobs).toHaveBeenCalled();
  });

  it("Move to Trash calls trashJobs with the output path", async () => {
    const trashJobs = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ trashJobs });
    render(<DeleteMenu job={makeJob()} />);
    await userEvent.click(screen.getByRole("button", { name: /Delete/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Move to Trash/ }));
    expect(trashJobs).toHaveBeenCalledWith([
      expect.objectContaining({ path: "/tmp/out.mp4" }),
    ]);
  });

  // Guards the restore in the file-level beforeEach. The two tests above swap
  // `forgetJobs` and `trashJobs` for spies; without the restore this one runs
  // the leftover `trashJobs` spy and never reaches the IPC layer. `trashJobs`
  // also calls `forgetJobs` through `get()`, so it covers the indirect case
  // too — a stale `forgetJobs` spy would break the second assertion alone.
  it("reaches the IPC layer through the real trashJobs", async () => {
    render(<DeleteMenu job={makeJob()} />);
    await userEvent.click(screen.getByRole("button", { name: /Delete/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Move to Trash/ }));
    await waitFor(() => expect(api.file.moveToTrash).toHaveBeenCalledWith("/tmp/out.mp4"));
    await waitFor(() => expect(api.job.forget).toHaveBeenCalledWith("job-1"));
  });

  it("disables Move to Trash when the job has no output path", async () => {
    render(<DeleteMenu job={makeJob({ result: null }) as unknown as Job} />);
    await userEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(
      screen.getByRole("menuitem", { name: /Move to Trash/ }),
    ).toHaveProperty("disabled", true);
  });
});
