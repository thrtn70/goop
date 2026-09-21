import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const recorderState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@/performance/responsiveness", () => ({
  getResponsivenessRecorder: () => recorderState.current,
}));
vi.mock("../LeftNav", () => ({ default: () => null }));
vi.mock("../TopBar", () => ({ default: () => null }));
vi.mock("../CommandPalette", () => ({ default: () => null }));
vi.mock("../Onboarding", () => ({ default: () => null }));
vi.mock("../SkipNav", () => ({ default: () => null }));
vi.mock("@/features/queue/QueueSidebar", () => ({ default: () => null }));
vi.mock("@/hooks/useTheme", () => ({ useTheme: () => undefined }));
vi.mock("@/hooks/useQueueHotkey", () => ({ useQueueHotkey: () => undefined }));
vi.mock("@/hooks/useHotkeys", () => ({ useHotkeys: () => undefined }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function recorder(mode: "noop" | "enabled" | "faulted") {
  const owner = { kind: "setup" as const, setup_id: 1 };
  let spanId = 0;
  if (mode === "noop") {
    return {
      startSetup: () => null,
      settleSetup: () => undefined,
      cancelSetup: () => undefined,
      startSpan: () => null,
      endSpan: () => undefined,
      cancelSpan: () => undefined,
    };
  }
  if (mode === "faulted") {
    // A recorder that has crossed its internal failure boundary is inert.
    return {
      startSetup: vi.fn(() => null),
      settleSetup: vi.fn(),
      cancelSetup: vi.fn(),
      startSpan: vi.fn(() => null),
      endSpan: vi.fn(),
      cancelSpan: vi.fn(),
    };
  }
  return {
    startSetup: vi.fn(() => owner),
    settleSetup: vi.fn(),
    cancelSetup: vi.fn(),
    startSpan: vi.fn(() => ++spanId),
    endSpan: vi.fn(),
    cancelSpan: vi.fn(),
  };
}

describe.each(["noop", "enabled", "faulted"] as const)("draft persistence alert with %s recorder", (mode) => {
  it("keeps the unchanged in-memory draft visible and retries the real storage write", async () => {
    let failWrites = true;
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failWrites) throw new Error("quota detail must stay private");
        values.set(key, value);
      },
    });
    recorderState.current = recorder(mode);

    const drafts = await import("@/store/workspaceDrafts");
    const { DRAFT_STORAGE_KEY, decodeDraftEntries } = await import("@/store/workspacePersistence");
    const { default: Layout } = await import("../Layout");
    const wrapper = ({ children }: { children: ReactNode }) => createElement(
      drafts.WorkspaceDraftProvider,
      { tool: "image" },
      children,
    );

    render(<MemoryRouter><Layout /></MemoryRouter>);
    const draft = renderHook(
      () => drafts.useWorkspaceDraftState<string[]>("ImagePage.files", []),
      { wrapper },
    );
    act(() => draft.result.current[1](["/private/source.png"]));

    expect((await screen.findByRole("alert")).textContent).toContain("Unfinished edits could not be saved for restart");
    expect(draft.result.current[0]).toEqual(["/private/source.png"]);
    expect(values.has(DRAFT_STORAGE_KEY)).toBe(false);

    failWrites = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    expect(draft.result.current[0]).toEqual(["/private/source.png"]);
    expect(decodeDraftEntries(values.get(DRAFT_STORAGE_KEY) ?? "")).toEqual({
      [JSON.stringify(["image", "ImagePage.files"])]: { value: ["/private/source.png"] },
    });
  });
});
