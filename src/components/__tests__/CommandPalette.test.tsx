import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import CommandPalette from "@/components/CommandPalette";
import { useAppStore } from "@/store/appStore";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const apiMocks = vi.hoisted(() => ({
  update: {
    check: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/ipc/commands", () => ({
  api: apiMocks,
}));

function openPalette(): void {
  useAppStore.getState().setPaletteOpen(true);
}

function resetStore(): void {
  useAppStore.setState({
    paletteOpen: false,
    pendingFocusUrlInput: 0,
    pendingFilePicker: 0,
    toasts: [],
  });
}

beforeEach(() => {
  resetStore();
  navigateMock.mockReset();
  apiMocks.update.check.mockClear();
});

afterEach(() => {
  cleanup();
});

function renderPalette(): void {
  render(
    <MemoryRouter>
      <CommandPalette />
    </MemoryRouter>,
  );
}

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    renderPalette();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the dialog and grouped actions when open", () => {
    openPalette();
    renderPalette();
    expect(screen.getByRole("dialog", { name: /command palette/i })).toBeTruthy();
    expect(screen.getByText("Navigate")).toBeTruthy();
    expect(screen.getByText("Actions")).toBeTruthy();
    expect(screen.getByText("Queue")).toBeTruthy();
  });

  it("navigates and closes when a Navigate item is selected", async () => {
    const user = userEvent.setup();
    openPalette();
    renderPalette();
    await user.click(screen.getByText("Go to Convert"));
    expect(navigateMock).toHaveBeenCalledWith("/convert");
    expect(useAppStore.getState().paletteOpen).toBe(false);
  });

  it("requests URL focus + navigates to /extract for the Paste URL action", async () => {
    const user = userEvent.setup();
    openPalette();
    renderPalette();
    await user.click(screen.getByText("Paste URL and download"));
    expect(navigateMock).toHaveBeenCalledWith("/extract");
    expect(useAppStore.getState().pendingFocusUrlInput).toBe(1);
  });

  it("requests file picker and routes to /convert when not on a picker page", async () => {
    const user = userEvent.setup();
    openPalette();
    renderPalette();
    await user.click(screen.getByText("Open file picker"));
    expect(useAppStore.getState().pendingFilePicker).toBe(1);
    // location.pathname in jsdom defaults to "/", so we route to /convert.
    expect(navigateMock).toHaveBeenCalledWith("/convert");
  });

  it("filters actions by search query", async () => {
    const user = userEvent.setup();
    openPalette();
    renderPalette();
    const input = screen.getByPlaceholderText(/Type a command/);
    await user.type(input, "compress");
    // The Compress nav item should remain; Extract should be filtered out.
    expect(screen.queryByText("Go to Compress")).toBeTruthy();
    expect(screen.queryByText("Go to Extract")).toBeNull();
  });

  it("shows the empty state when nothing matches", async () => {
    const user = userEvent.setup();
    openPalette();
    renderPalette();
    await user.type(screen.getByPlaceholderText(/Type a command/), "xyzzy");
    expect(screen.getByText(/No matching commands/)).toBeTruthy();
  });

  it("calls api.update.check when Check for updates is selected", async () => {
    const user = userEvent.setup();
    openPalette();
    renderPalette();
    await user.click(screen.getByText("Check for updates"));
    expect(apiMocks.update.check).toHaveBeenCalled();
  });
});
