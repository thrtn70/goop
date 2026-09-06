import { beforeEach, expect, it, vi } from "vitest";
import { api } from "@/ipc/commands";
import { bootstrapStoreSubscriptions, useAppStore } from "@/store/appStore";
import * as startup from "./startup";

vi.mock("@/ipc/events", () => ({ subscribeAll: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@/ipc/commands", () => ({ api: { settings: { get: vi.fn() }, queue: { list: vi.fn() } } }));

beforeEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({ settings: null, jobs: [] });
  vi.spyOn(startup, "markInitialDataReady").mockImplementation(() => {});
  for (const name of ["loadPresets", "loadHistory", "refreshDoneToday"] as const) {
    vi.spyOn(useAppStore.getState(), name).mockResolvedValue(undefined);
  }
  vi.spyOn(useAppStore.getState(), "loadVersions").mockRejectedValue(new Error("unavailable"));
  vi.mocked(api.settings.get).mockResolvedValue({ auto_check_updates: false, history_view_mode: "grid" } as Awaited<ReturnType<typeof api.settings.get>>);
  vi.mocked(api.queue.list).mockResolvedValue([]);
});

it.each(["settings", "queue"] as const)("does not report hydration when %s fails", async (kind) => {
  const method = kind === "settings" ? api.settings.get : api.queue.list;
  vi.mocked(method).mockRejectedValue(new Error("snapshot unavailable"));
  await expect(bootstrapStoreSubscriptions()).resolves.toBeTypeOf("function");
  expect(startup.markInitialDataReady).not.toHaveBeenCalled();
  expect(useAppStore.getState().settings).toBeNull();
});
it("reports success only after both snapshots and preserves history preference hydration", async () => {
  await bootstrapStoreSubscriptions();
  expect(startup.markInitialDataReady).toHaveBeenCalledTimes(1);
  expect(useAppStore.getState().history.viewMode).toBe("grid");
});
