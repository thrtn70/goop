import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import JobStateAnnouncer from "@/components/JobStateAnnouncer";
import { useAppStore } from "@/store/appStore";
import type { Job } from "@/types";

function makeJob(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    kind: "extract",
    state: "running",
    payload: { url: "https://example.com/a-clip" },
    result: null,
    priority: 0,
    attempts: 0,
    created_at: BigInt(1_700_000_000_000),
    started_at: BigInt(1_700_000_000_000),
    finished_at: null,
    ...overrides,
  } as unknown as Job;
}

beforeEach(() => {
  useAppStore.setState({ jobs: [] });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function advance(): void {
  // Match the 50ms clear-then-set delay in the component.
  act(() => {
    vi.advanceTimersByTime(60);
  });
}

describe("JobStateAnnouncer", () => {
  it("renders an aria-live polite status region that's visually hidden", () => {
    const { container } = render(<JobStateAnnouncer />);
    const region = container.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.className).toContain("sr-only");
  });

  it("does not announce on initial mount with already-terminal jobs", () => {
    useAppStore.setState({ jobs: [makeJob("a", { state: "done" })] });
    const { container } = render(<JobStateAnnouncer />);
    const region = container.querySelector('[role="status"]') as HTMLElement;
    expect(region.textContent).toBe("");
  });

  it("announces when a running job transitions to done", () => {
    useAppStore.setState({
      jobs: [
        makeJob("a", {
          state: "running",
          result: { output_path: "/tmp/song.mp3", bytes: BigInt(1024), duration_ms: BigInt(2000) },
        } as unknown as Partial<Job>),
      ],
    });
    const { container } = render(<JobStateAnnouncer />);
    act(() => {
      useAppStore.setState({
        jobs: [
          makeJob("a", {
            state: "done",
            result: {
              output_path: "/tmp/song.mp3",
              bytes: BigInt(1024),
              duration_ms: BigInt(2000),
            },
          } as unknown as Partial<Job>),
        ],
      });
    });
    advance();
    const region = container.querySelector('[role="status"]') as HTMLElement;
    expect(region.textContent).toMatch(/song\.mp3 finished/);
  });

  it("announces when a job transitions to cancelled", () => {
    useAppStore.setState({ jobs: [makeJob("a", { state: "running" })] });
    const { container } = render(<JobStateAnnouncer />);
    act(() => {
      useAppStore.setState({ jobs: [makeJob("a", { state: "cancelled" })] });
    });
    advance();
    const region = container.querySelector('[role="status"]') as HTMLElement;
    expect(region.textContent).toMatch(/cancelled/);
  });

  it("announces when a job transitions to error with the message", () => {
    useAppStore.setState({ jobs: [makeJob("a", { state: "running" })] });
    const { container } = render(<JobStateAnnouncer />);
    act(() => {
      useAppStore.setState({
        jobs: [
          makeJob("a", {
            state: { error: { message: "ffmpeg failed" } } as unknown as Job["state"],
          }),
        ],
      });
    });
    advance();
    const region = container.querySelector('[role="status"]') as HTMLElement;
    expect(region.textContent).toMatch(/failed: ffmpeg failed/);
  });

  it("clears the region briefly between announcements (forces re-announce of identical messages)", () => {
    useAppStore.setState({ jobs: [makeJob("a", { state: "running" })] });
    const { container } = render(<JobStateAnnouncer />);
    act(() => {
      useAppStore.setState({ jobs: [makeJob("a", { state: "cancelled" })] });
    });
    const region = container.querySelector('[role="status"]') as HTMLElement;
    // Before the timer fires, the message has been wiped to ""
    // (clear-then-set), so the DOM mutation is observable.
    expect(region.textContent).toBe("");
    advance();
    expect(region.textContent).toMatch(/cancelled/);
  });
});
