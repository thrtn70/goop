import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import EmptyHistory from "@/features/history/EmptyHistory";
import { useAppStore } from "@/store/appStore";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => navigateMock };
});

// Clear-filters triggers `setHistorySearch` / `setHistoryKind` which
// internally call `loadHistory` → `api.history.list`. Mock the IPC so
// those calls succeed without trying to reach a Tauri backend.
vi.mock("@/ipc/commands", () => ({
  api: {
    history: {
      list: vi.fn().mockResolvedValue([]),
      counts: vi.fn().mockResolvedValue({}),
    },
  },
}));

beforeEach(() => {
  navigateMock.mockReset();
  // Reset history slice fields the component reads on click handlers.
  useAppStore.setState((s) => ({
    history: { ...s.history, search: "", kind: null },
  }));
});

afterEach(() => {
  cleanup();
});

function renderEmpty(filtersActive: boolean): void {
  render(
    <MemoryRouter>
      <EmptyHistory filtersActive={filtersActive} />
    </MemoryRouter>,
  );
}

describe("EmptyHistory", () => {
  it("first-run state offers two routing chips", () => {
    renderEmpty(false);
    expect(screen.getByText(/Nothing finished yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Paste a link/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Convert a file/i })).toBeTruthy();
  });

  it("filter-empty state offers a Clear filters action and the right copy", () => {
    renderEmpty(true);
    expect(screen.getByText(/No finished jobs match those filters/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Clear filters/i })).toBeTruthy();
    // The first-run copy must NOT appear when filters are active.
    expect(screen.queryByText(/Nothing finished yet/i)).toBeNull();
  });

  it("Paste a link routes to /extract", async () => {
    renderEmpty(false);
    await userEvent.setup().click(screen.getByRole("button", { name: /Paste a link/i }));
    expect(navigateMock).toHaveBeenCalledWith("/extract");
  });

  it("Convert a file routes to /convert", async () => {
    renderEmpty(false);
    await userEvent.setup().click(screen.getByRole("button", { name: /Convert a file/i }));
    expect(navigateMock).toHaveBeenCalledWith("/convert");
  });

  it("Clear filters resets search and kind in the store", async () => {
    useAppStore.setState((s) => ({
      history: { ...s.history, search: "song", kind: "extract" },
    }));
    renderEmpty(true);
    await userEvent.setup().click(screen.getByRole("button", { name: /Clear filters/i }));
    const h = useAppStore.getState().history;
    expect(h.search).toBe("");
    expect(h.kind).toBeNull();
  });
});
