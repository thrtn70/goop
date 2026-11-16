import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "@/ipc/commands";
import { jobIdKey, useAppStore } from "@/store/appStore";
import type { Job } from "@/types";
import HistoryBulkActions from "../HistoryBulkActions";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual<typeof import("react-router-dom")>("react-router-dom")),
  useNavigate: () => navigate,
}));
vi.mock("@/ipc/commands", () => ({
  api: {
    queue: { reveal: vi.fn() },
    handoff: { resolve: vi.fn() },
  },
}));

const resolve = vi.mocked(api.handoff.resolve);

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    kind: "extract",
    state: "done",
    payload: null,
    result: { output_path: `/out/${id}.mp4`, result_kind: "file", file_count: 1, bytes: 1n, duration_ms: 1n },
    priority: 0,
    attempts: 0,
    created_at: 1n,
    started_at: null,
    finished_at: 1n,
    ...overrides,
  } as Job;
}

const failed = job("failed", { state: { error: { message: "x", detail: null } }, result: null });
const oldAlbum = job("old", { result: { output_path: "/out/old", result_kind: "folder", file_count: 3, bytes: 1n, duration_ms: 1n } as Job["result"] });

function select(jobs: Job[]) {
  useAppStore.setState(state => ({
    history: { ...state.history, jobs, selectedIds: new Set(jobs.map(j => jobIdKey(j.id))) },
  }));
}

beforeEach(() => {
  navigate.mockClear();
  resolve.mockReset();
  useAppStore.setState({ toasts: [] });
});

afterEach(cleanup);

describe("HistoryBulkActions handoffs", () => {
  it("hands every eligible selected item to Convert at once", async () => {
    const user = userEvent.setup();
    resolve.mockResolvedValue([{ paths: ["/out/a.mp4"], missing: 0 }, { paths: ["/out/b.mp4"], missing: 0 }]);
    select([job("a"), failed, job("b")]);
    render(<HistoryBulkActions />);
    await user.click(screen.getByRole("button", { name: "Convert…" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate.mock.calls[0][0]).toBe("/convert");
    expect(navigate.mock.calls[0][1].state.handoff).toMatchObject({
      destination: "convert",
      items: [{ sourceJobId: "a", path: "/out/a.mp4" }, { sourceJobId: "b", path: "/out/b.mp4" }],
      skipped: { failed: 1 },
    });
  });

  it("offers Compress too, and neither when no selected item qualifies", () => {
    select([job("a")]);
    const view = render(<HistoryBulkActions />);
    expect(screen.getByRole("button", { name: "Compress…" })).toBeTruthy();
    view.unmount();
    select([failed, oldAlbum]);
    render(<HistoryBulkActions />);
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Convert…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compress…" })).toBeNull();
  });

  it("lets the bar and its actions wrap in a narrow History column", () => {
    select([job("a")]);
    render(<HistoryBulkActions />);
    const bar = screen.getByText("1 selected").parentElement!;
    const actions = screen.getByRole("button", { name: "Convert…" }).parentElement!;
    expect(bar.className.split(" ")).toContain("flex-wrap");
    expect(actions.className.split(" ")).toContain("flex-wrap");
  });
});
