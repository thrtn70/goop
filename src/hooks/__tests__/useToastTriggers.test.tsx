import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useToastTriggers } from "@/hooks/useToastTriggers";
import { useAppStore } from "@/store/appStore";
import type { Job, JobState } from "@/types";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(false),
  sendNotification: vi.fn(),
}));

function Probe() {
  useToastTriggers();
  return null;
}

function makeJob(state: JobState): Job {
  return {
    id: "00000000-0000-7000-8000-000000000001",
    kind: "extract",
    state,
    payload: { url: "https://example.com/video" },
    result: null,
    priority: 0,
    attempts: 0,
    created_at: BigInt(1_700_000_000_000),
    started_at: null,
    finished_at: null,
  };
}

function setJobs(state: JobState): void {
  act(() => {
    useAppStore.setState({ jobs: [makeJob(state)] });
  });
}

function errorToastCount(): number {
  return useAppStore.getState().toasts.filter((t) => t.variant === "error").length;
}

beforeEach(() => {
  useAppStore.setState({ jobs: [], toasts: [] });
});

afterEach(() => {
  cleanup();
});

describe("useToastTriggers across retry transitions", () => {
  it("re-toasts when a retried job fails again", () => {
    render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    );

    setJobs({ error: { message: "connection reset", detail: null } });
    expect(errorToastCount()).toBe(1);

    // Manual retry: the job leaves its terminal state...
    setJobs("queued");
    setJobs("running");
    expect(errorToastCount()).toBe(1);

    // ...and the second failure must toast again.
    setJobs({ error: { message: "connection reset again", detail: null } });
    expect(errorToastCount()).toBe(2);
  });

  it("does not double-toast while a job stays failed", () => {
    render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    );

    setJobs({ error: { message: "boom", detail: null } });
    // Unrelated store churn re-publishes the same terminal state.
    setJobs({ error: { message: "boom", detail: null } });
    expect(errorToastCount()).toBe(1);
  });
});
