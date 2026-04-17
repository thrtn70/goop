import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HistoryFilterChips from "@/features/history/HistoryFilterChips";
import PdfOperationPicker from "@/features/pdf/PdfOperationPicker";
import DeleteMenu from "@/features/preview/DeleteMenu";
import { useAppStore } from "@/store/appStore";
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

  it("disables Split and Compress on multi-file drops", () => {
    render(
      <PdfOperationPicker selected="merge" onSelect={() => {}} multiFile={true} />,
    );
    const split = screen.getByRole("radio", { name: /Split/ });
    const compress = screen.getByRole("radio", { name: /Compress/ });
    const merge = screen.getByRole("radio", { name: /Merge/ });
    expect(split).toHaveProperty("disabled", true);
    expect(compress).toHaveProperty("disabled", true);
    expect(merge).toHaveProperty("disabled", false);
  });

  it("enables all three on single-file drops", () => {
    render(
      <PdfOperationPicker selected="split" onSelect={() => {}} multiFile={false} />,
    );
    for (const label of ["Merge", "Split", "Compress"]) {
      expect(
        screen.getByRole("radio", { name: new RegExp(label) }),
      ).toHaveProperty("disabled", false);
    }
  });

  it("marks the selected operation with aria-checked", () => {
    render(<PdfOperationPicker selected="compress" onSelect={() => {}} multiFile={false} />);
    expect(
      screen.getByRole("radio", { name: /Compress/ }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("DeleteMenu", () => {
  afterEach(cleanup);
  beforeEach(() => resetStoreHistory({ all: 0, extract: 0, convert: 0, pdf: 0 }));

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

  it("disables Move to Trash when the job has no output path", async () => {
    render(<DeleteMenu job={makeJob({ result: null }) as unknown as Job} />);
    await userEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(
      screen.getByRole("menuitem", { name: /Move to Trash/ }),
    ).toHaveProperty("disabled", true);
  });
});
