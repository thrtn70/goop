import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const path = vi.hoisted(() => ({ homeDir: vi.fn<() => Promise<string>>() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: path.homeDir }));

import { __resetHomeDirCacheForTests, useHomeDir } from "@/hooks/useHomeDir";

beforeEach(() => {
  __resetHomeDirCacheForTests();
  path.homeDir.mockReset();
});

afterEach(cleanup);

describe("useHomeDir", () => {
  it("starts loading and then reports the home folder", async () => {
    path.homeDir.mockResolvedValue("/Users/a");
    const { result } = renderHook(() => useHomeDir());
    expect(result.current).toEqual({ status: "loading" });
    await waitFor(() => expect(result.current).toEqual({ status: "ready", dir: "/Users/a" }));
  });

  it("asks the runtime once for the whole app run, however many consumers there are", async () => {
    path.homeDir.mockResolvedValue("/Users/a");
    const first = renderHook(() => useHomeDir());
    const second = renderHook(() => useHomeDir());
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    await waitFor(() => expect(second.result.current.status).toBe("ready"));
    const third = renderHook(() => useHomeDir());
    expect(path.homeDir).toHaveBeenCalledTimes(1);
    expect(third.result.current).toEqual({ status: "ready", dir: "/Users/a" });
  });

  it("maps a rejection to failed", async () => {
    path.homeDir.mockRejectedValue(new Error("no home"));
    const { result } = renderHook(() => useHomeDir());
    await waitFor(() => expect(result.current).toEqual({ status: "failed" }));
  });

  it("maps a synchronous throw to failed", async () => {
    path.homeDir.mockImplementation(() => {
      throw new Error("no runtime");
    });
    const { result } = renderHook(() => useHomeDir());
    await waitFor(() => expect(result.current).toEqual({ status: "failed" }));
  });
});
