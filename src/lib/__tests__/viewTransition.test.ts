import { afterEach, describe, expect, it, vi } from "vitest";
import { withViewTransition } from "@/lib/viewTransition";

const originalMatchMedia = window.matchMedia;
const originalStartViewTransition = document.startViewTransition;

function setReducedMotion(matches: boolean): void {
  window.matchMedia = vi.fn().mockReturnValue({ matches }) as typeof window.matchMedia;
}

function setViewTransition(start: ReturnType<typeof vi.fn>): void {
  document.startViewTransition = start as typeof document.startViewTransition;
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  document.startViewTransition = originalStartViewTransition;
  vi.restoreAllMocks();
});

describe("withViewTransition", () => {
  it("runs the update directly when reduced motion is requested", () => {
    setReducedMotion(true);
    const start = vi.fn();
    setViewTransition(start);
    const update = vi.fn();

    withViewTransition(update);

    expect(update).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it("uses the view-transition API when motion is allowed", async () => {
    setReducedMotion(false);
    let capturedUpdate: (() => Promise<void>) | undefined;
    const start = vi.fn((update: () => Promise<void>) => {
      capturedUpdate = update;
      return { finished: Promise.resolve() };
    });
    setViewTransition(start);
    const update = vi.fn();

    withViewTransition(update);

    expect(start).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    await capturedUpdate?.();
    expect(update).toHaveBeenCalledOnce();
  });
});
