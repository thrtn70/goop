import { it, expect, vi } from "vitest";
import { scheduleInspection } from "../sourceInspectionScheduler";
const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("@/ipc/commands", () => ({ api: { convert: { inspect } } }));
it("holds the global slot across retired routes, skips queued work, and releases on rejection", async () => {
  let reject!: (e: Error) => void;
  inspect
    .mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    )
    .mockResolvedValue({ probe: {}, capabilities: {} });
  const stale = vi.fn(),
    live = vi.fn();
  const retireA = scheduleInspection("/a.jxl", stale);
  const retireB = scheduleInspection("/b.dng", vi.fn());
  await Promise.resolve();
  expect(inspect).toHaveBeenCalledTimes(1);
  retireA();
  retireB();
  scheduleInspection("/c.png", live);
  await Promise.resolve();
  expect(inspect).toHaveBeenCalledTimes(1);
  reject(new Error("old decoder failed"));
  await vi.waitFor(() => expect(live).toHaveBeenCalledOnce());
  expect(inspect.mock.calls.map((c) => c[0])).toEqual(["/a.jxl", "/c.png"]);
  expect(stale).not.toHaveBeenCalled();
});
it("coalesces discarded StrictMode setup before issuing IPC", async () => {
  inspect.mockClear();
  scheduleInspection("/throwaway.png", vi.fn())();
  const ready = vi.fn();
  scheduleInspection("/retained.png", ready);
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  expect(inspect.mock.calls.map((c) => c[0])).toEqual(["/retained.png"]);
});
