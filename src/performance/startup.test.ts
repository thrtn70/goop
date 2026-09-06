import { describe, expect, it, vi } from "vitest";
import { createStartupCoordinator } from "./startup";

function fixture(enabled = true) {
  const report = vi.fn().mockResolvedValue(undefined);
  const frames: (() => void)[] = [];
  const ready = createStartupCoordinator({
    enabled: async () => enabled,
    report,
    afterFrame: (callback: () => void) => frames.push(callback),
  });
  return { ready, report, frames };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("startup readiness", () => {
  it("requires hydration and a committed shell frame, with one report across duplicate signals", async () => {
    const { ready, report, frames } = fixture();
    ready.markShellReady();
    await flush();
    expect(report).not.toHaveBeenCalled();
    ready.markInitialDataReady();
    ready.markShellReady();
    ready.markInitialDataReady();
    await flush();
    expect(report).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames.shift()!();
    await flush();
    expect(report).toHaveBeenCalledTimes(1);
    ready.markShellReady();
    await flush();
    expect(report).toHaveBeenCalledTimes(1);
  });
  it("accepts hydration before shell commit", async () => {
    const { ready, report, frames } = fixture();
    ready.markInitialDataReady();
    await flush();
    expect(frames).toHaveLength(0);
    ready.markShellReady();
    await flush();
    frames.shift()!();
    await flush();
    expect(report).toHaveBeenCalledTimes(1);
  });
  it("failed hydration never claims ready", async () => {
    const { ready, report, frames } = fixture();
    ready.markShellReady();
    ready.markInitialDataReady(false);
    await flush();
    expect(frames).toHaveLength(0);
    expect(report).not.toHaveBeenCalled();
  });
  it("disabled instrumentation emits nothing", async () => {
    const { ready, report, frames } = fixture(false);
    ready.markShellReady();
    ready.markInitialDataReady();
    await flush();
    expect(frames).toHaveLength(0);
    expect(report).not.toHaveBeenCalled();
  });
  it("report failures remain nonfatal and are not retried", async () => {
    const { ready, report, frames } = fixture();
    report.mockRejectedValue(new Error("unwritable"));
    ready.markShellReady();
    ready.markInitialDataReady();
    await flush();
    frames.shift()!();
    await flush();
    ready.markShellReady();
    expect(report).toHaveBeenCalledTimes(1);
  });
});
