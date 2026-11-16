import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@/types";
import { useAppStore } from "@/store/appStore";
import { api } from "@/ipc/commands";
import { useHandoff } from "../useHandoff";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual<typeof import("react-router-dom")>("react-router-dom")),
  useNavigate: () => navigate,
}));
vi.mock("@/ipc/commands", () => ({ api: { handoff: { resolve: vi.fn() } } }));

const resolve = vi.mocked(api.handoff.resolve);
const file = { id: "f", kind: "extract", state: "done", result: { output_path: "/movie.mp4", result_kind: "file" } } as unknown as Job;
const album = (n: number) =>
  ({ id: "a", kind: "extract", state: "done", result: { output_path: "/al", result_kind: "folder", files: Array.from({ length: n }, (_, i) => `${i}.jpg`) } }) as unknown as Job;
const failed = { ...file, id: "x", state: { error: { message: "m", detail: null } } } as Job;

function toasts() {
  return useAppStore.getState().toasts;
}

beforeEach(() => {
  navigate.mockClear();
  resolve.mockReset();
  useAppStore.setState({ toasts: [] });
});

describe("useHandoff", () => {
  it("rechecks paths, then opens the destination with what is still there", async () => {
    resolve.mockResolvedValue([{ paths: ["/movie.mp4"], missing: 0 }, { paths: ["/al/0.jpg"], missing: 1 }]);
    const { result } = renderHook(() => useHandoff());
    await act(() => result.current([file, failed, album(2)], "compress"));
    expect(resolve).toHaveBeenCalledWith([{ output_path: "/movie.mp4" }, { output_path: "/al", files: ["0.jpg", "1.jpg"] }]);
    expect(navigate).toHaveBeenCalledWith("/compress", {
      state: {
        handoff: expect.objectContaining({
          destination: "compress",
          items: [{ sourceJobId: "f", path: "/movie.mp4" }, { sourceJobId: "a", path: "/al/0.jpg" }],
          skipped: expect.objectContaining({ failed: 1, missing: 1 }),
        }),
      },
    });
  });

  it("refuses a handoff past the limit without checking or navigating", async () => {
    const { result } = renderHook(() => useHandoff());
    await act(() => result.current([album(640)], "convert"));
    expect(resolve).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(toasts()).toEqual([
      expect.objectContaining({ title: "This album has 640 files; Convert takes up to 200 at a time. Use Show in Finder to pick some." }),
    ]);
  });

  it("stays put and says why when nothing is left to add", async () => {
    resolve.mockResolvedValue([{ paths: [], missing: 1 }]);
    const { result } = renderHook(() => useHandoff());
    await act(() => result.current([file, failed], "convert"));
    expect(navigate).not.toHaveBeenCalled();
    expect(toasts()).toEqual([
      expect.objectContaining({ title: "Nothing to add to Convert", detail: "Skipped 2: 1 failed, 1 missing file." }),
    ]);

    await act(() => result.current([failed], "convert"));
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("reports a failed check instead of navigating", async () => {
    resolve.mockRejectedValue({ kind: "config", message: "boom" });
    const { result } = renderHook(() => useHandoff());
    await act(() => result.current([file], "convert"));
    expect(navigate).not.toHaveBeenCalled();
    expect(toasts()).toEqual([expect.objectContaining({ variant: "error", title: "Couldn't hand off to Convert" })]);
  });

  it("lets only the latest click navigate when an earlier check finishes later", async () => {
    const pending: Array<(value: { paths: string[]; missing: number }[]) => void> = [];
    resolve.mockImplementation(() => new Promise(done => { pending.push(done); }));
    const preview = renderHook(() => useHandoff());
    const queue = renderHook(() => useHandoff());
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = preview.result.current([file], "convert");
      second = queue.result.current([file], "compress");
    });
    await act(async () => {
      pending[1]([{ paths: ["/movie.mp4"], missing: 0 }]);
      await second;
      pending[0]([{ paths: ["/movie.mp4"], missing: 0 }]);
      await first;
    });
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(navigate.mock.calls.map(call => call[0])).toEqual(["/compress"]);
    expect(toasts()).toEqual([]);
  });

  it("does nothing once its page has closed", async () => {
    let finish!: (value: { paths: string[]; missing: number }[]) => void;
    resolve.mockImplementation(() => new Promise(done => { finish = done; }));
    const view = renderHook(() => useHandoff());
    let pendingHandoff!: Promise<boolean>;
    act(() => { pendingHandoff = view.result.current([file], "convert"); });
    view.unmount();
    await act(async () => {
      finish([{ paths: [], missing: 1 }]);
      await pendingHandoff;
    });
    expect(await pendingHandoff).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });
});
