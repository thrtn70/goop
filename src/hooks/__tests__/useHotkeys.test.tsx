import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useHotkeys } from "@/hooks/useHotkeys";
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

function HotkeyHost(): null {
  useHotkeys();
  return null;
}

function mountHost(initialPath = "/extract"): void {
  // Match jsdom's pathname so the Cmd+O check (compress vs not) works.
  window.history.replaceState({}, "", initialPath);
  render(
    <MemoryRouter>
      <HotkeyHost />
    </MemoryRouter>,
  );
}

// `pressMod` and tinykeys' `$mod` must agree on which modifier represents
// "Cmd on Mac / Ctrl elsewhere". tinykeys resolves `$mod` at registration
// time using the same `navigator.userAgent` check we use here, so both
// sides stay in sync regardless of which OS the test host is running on.
function pressMod(key: string, options: KeyboardEventInit = {}): void {
  const isMac = /Mac|iPad|iPhone|iPod/.test(navigator.userAgent);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      metaKey: isMac,
      ctrlKey: !isMac,
      ...options,
    }),
  );
}

beforeEach(() => {
  useAppStore.setState({
    paletteOpen: false,
    pendingFocusUrlInput: 0,
    pendingFilePicker: 0,
  });
  navigateMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useHotkeys", () => {
  it("Cmd+K toggles the palette", () => {
    mountHost();
    pressMod("k");
    expect(useAppStore.getState().paletteOpen).toBe(true);
    pressMod("k");
    expect(useAppStore.getState().paletteOpen).toBe(false);
  });

  it("Cmd+1..5 navigates to the matching route", () => {
    mountHost();
    pressMod("1");
    pressMod("2");
    pressMod("3");
    pressMod("4");
    pressMod("5");
    expect(navigateMock).toHaveBeenNthCalledWith(1, "/extract");
    expect(navigateMock).toHaveBeenNthCalledWith(2, "/convert");
    expect(navigateMock).toHaveBeenNthCalledWith(3, "/compress");
    expect(navigateMock).toHaveBeenNthCalledWith(4, "/history");
    expect(navigateMock).toHaveBeenNthCalledWith(5, "/settings");
  });

  it("Cmd+, navigates to settings", () => {
    mountHost();
    pressMod(",");
    expect(navigateMock).toHaveBeenCalledWith("/settings");
  });

  it("Cmd+N navigates to /extract and increments pendingFocusUrlInput", () => {
    mountHost();
    pressMod("n");
    expect(navigateMock).toHaveBeenCalledWith("/extract");
    expect(useAppStore.getState().pendingFocusUrlInput).toBe(1);
  });

  it("Cmd+O on a non-compress route navigates to /convert and increments pendingFilePicker", () => {
    mountHost("/history");
    pressMod("o");
    expect(navigateMock).toHaveBeenCalledWith("/convert");
    expect(useAppStore.getState().pendingFilePicker).toBe(1);
  });

  it("Cmd+O on /compress stays on compress and still increments pendingFilePicker", () => {
    mountHost("/compress");
    pressMod("o");
    expect(navigateMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingFilePicker).toBe(1);
  });

  it("Escape closes the palette only when it's open", () => {
    mountHost();
    useAppStore.setState({ paletteOpen: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(useAppStore.getState().paletteOpen).toBe(false);
    // Pressing Escape when closed is a no-op (does not navigate).
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
