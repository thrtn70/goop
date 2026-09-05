import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import QueueSidebar from "../QueueSidebar";
import { useAppStore } from "@/store/appStore";
import { api } from "@/ipc/commands";
import type { Job } from "@/types";

const patch = vi.fn().mockResolvedValue(undefined);
vi.mock("@/ipc/commands", () => ({ api: { queue: { cancelMany: vi.fn().mockResolvedValue(1) } } }));
vi.mock("../QueueRow", () => ({ default: ({job}: {job: Job}) => <button>Job {String(job.id)}</button> }));
vi.mock("../SortableQueueRow", () => ({ default: ({job}: {job: Job}) => <button>Job {String(job.id)}</button> }));
const job = { id: "queued-one", kind: "convert", state: "queued", payload: {}, result: null } as Job;

beforeEach(() => {
  useAppStore.setState({ jobs: [job], unseenCompletions: 1, progressById: {}, patchSettings: patch,
    ui: { queueCollapsed: true, queueSelectedIds: new Set(), doneToday: 0 } });
  patch.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("bottom queue", () => {
  it("starts collapsed in a new app session", () => {
    expect(useAppStore.getInitialState().ui.queueCollapsed).toBe(true);
  });
  it("keeps the summary visible and returns focus when content is collapsed", () => {
    render(<QueueSidebar />);
    const toggle = screen.getByRole("button", {name: "Expand queue"});
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", {name: /1 new completion/})).toBeTruthy();
    fireEvent.click(toggle);
    const row = screen.getByRole("button", {name: "Job queued-one"});
    row.focus();
    act(() => useAppStore.getState().toggleQueueCollapsed());
    expect(screen.queryByRole("button", {name: "Job queued-one"})).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", {name: "Expand queue"}));
  });
  it("resizes vertically by keyboard without rewriting the old width setting", () => {
    render(<QueueSidebar />);
    fireEvent.click(screen.getByRole("button", {name: "Expand queue"}));
    const grip = screen.getByRole("separator", {name: "Resize queue"});
    expect(grip.getAttribute("aria-orientation")).toBe("horizontal");
    const initial = Number(grip.getAttribute("aria-valuenow"));
    fireEvent.keyDown(grip, {key: "ArrowDown"});
    expect(Number(grip.getAttribute("aria-valuenow"))).toBe(initial - 16);
    fireEvent.keyDown(grip, {key: "Home"});
    expect(grip.getAttribute("aria-valuenow")).toBe(grip.getAttribute("aria-valuemin"));
    expect(patch).not.toHaveBeenCalled();
  });
  it("does not auto-collapse when an expanded queue becomes empty", () => {
    render(<QueueSidebar />);
    fireEvent.click(screen.getByRole("button", {name: "Expand queue"}));
    act(() => useAppStore.setState({ jobs: [] }));
    expect(screen.getByRole("button", {name: "Collapse queue"}).getAttribute("aria-expanded")).toBe("true");
  });
  it("restores the preferred height when a pointer resize is cancelled", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    render(<QueueSidebar />);
    fireEvent.click(screen.getByRole("button", {name: "Expand queue"}));
    const grip = screen.getByRole("separator", {name: "Resize queue"});
    grip.setPointerCapture = vi.fn();
    grip.hasPointerCapture = () => true;
    grip.releasePointerCapture = vi.fn();
    const initial = Number(grip.getAttribute("aria-valuenow"));
    fireEvent.pointerDown(grip, {clientY: 300});
    fireEvent.pointerMove(grip, {clientY: 350});
    expect(Number(grip.getAttribute("aria-valuenow"))).toBe(initial - 50);
    fireEvent.pointerCancel(grip);
    expect(Number(grip.getAttribute("aria-valuenow"))).toBe(initial);
    expect(patch).not.toHaveBeenCalled();
  });
  it("retains two-step selected cancellation and Escape dismissal", () => {
    useAppStore.setState({ui: {queueCollapsed: false, queueSelectedIds: new Set([job.id]), doneToday: 0}});
    render(<QueueSidebar />);
    fireEvent.click(screen.getByRole("button", {name: "Cancel selected"}));
    expect(screen.getByText("Cancel 1 job?")).toBeTruthy();
    expect(api.queue.cancelMany).not.toHaveBeenCalled();
    fireEvent.keyDown(window, {key: "Escape"});
    expect(screen.queryByRole("button", {name: "Yes, cancel"})).toBeNull();
    fireEvent.click(screen.getByRole("button", {name: "Cancel selected"}));
    act(() => useAppStore.setState({ui: {queueCollapsed: false, queueSelectedIds: new Set(), doneToday: 0}}));
    expect(screen.queryByRole("button", {name: "Yes, cancel"})).toBeNull();
    expect(api.queue.cancelMany).not.toHaveBeenCalled();
  });

  it("does not report an empty queue while a running job awaits progress", () => {
    useAppStore.setState({jobs: [{...job, state: "running"}]});
    render(<QueueSidebar />);
    expect(screen.getByText("Starting")).toBeTruthy();
    expect(screen.queryByText("No active jobs")).toBeNull();
  });

});
