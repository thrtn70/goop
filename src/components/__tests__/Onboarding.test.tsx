import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Onboarding from "@/components/Onboarding";
import { useAppStore } from "@/store/appStore";
import type { Settings } from "@/types";

const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogMocks.open,
}));

const apiMocks = vi.hoisted(() => ({
  settings: {
    set: vi.fn(),
  },
}));

vi.mock("@/ipc/commands", () => ({
  api: {
    settings: apiMocks.settings,
  },
}));

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    output_dir: "/Users/thortran/Downloads",
    theme: "system",
    yt_dlp_last_update_ms: null,
    extract_concurrency: 2,
    convert_concurrency: 1,
    auto_check_updates: true,
    dismissed_update_version: null,
    history_view_mode: "list",
    queue_sidebar_width: 288,
    hw_acceleration_enabled: true,
    cookies_from_browser: null,
    has_seen_onboarding: false,
    ...overrides,
  };
}

beforeEach(() => {
  // The patchSettings store action calls api.settings.set under the hood
  // and writes the result back into state. Mock returns the merged settings.
  apiMocks.settings.set.mockReset();
  apiMocks.settings.set.mockImplementation(
    async (patch: Partial<Settings>) => ({
      ...useAppStore.getState().settings,
      ...patch,
    }),
  );
  dialogMocks.open.mockReset();
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ settings: null, toasts: [] });
});

describe("Onboarding", () => {
  it("renders nothing when settings haven't loaded yet", () => {
    useAppStore.setState({ settings: null });
    const { container } = render(<Onboarding />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when has_seen_onboarding is true", () => {
    useAppStore.setState({ settings: makeSettings({ has_seen_onboarding: true }) });
    const { container } = render(<Onboarding />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the welcome step on initial mount when flag is false", () => {
    useAppStore.setState({ settings: makeSettings() });
    render(<Onboarding />);
    expect(screen.getByText(/Welcome to Goop/)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: /Welcome to Goop/i })).toBeTruthy();
  });

  it("advances welcome -> downloads -> ready and shows current folder on step 2", async () => {
    useAppStore.setState({
      settings: makeSettings({ output_dir: "/Users/x/MyMedia" }),
    });
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/Where should downloads go/)).toBeTruthy();
    expect(screen.getByText("/Users/x/MyMedia")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/You're all set/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Get started" })).toBeTruthy();
  });

  it("Back goes to the previous step on the downloads screen", async () => {
    useAppStore.setState({ settings: makeSettings() });
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText(/Welcome to Goop/)).toBeTruthy();
  });

  it("Skip from any step flips has_seen_onboarding to true", async () => {
    useAppStore.setState({ settings: makeSettings() });
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => {
      expect(apiMocks.settings.set).toHaveBeenCalled();
    });
    const lastCall = apiMocks.settings.set.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ has_seen_onboarding: true });
  });

  it("Get started on the final step flips has_seen_onboarding to true", async () => {
    useAppStore.setState({ settings: makeSettings() });
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Get started" }));
    await waitFor(() => {
      expect(apiMocks.settings.set).toHaveBeenCalled();
    });
    const lastCall = apiMocks.settings.set.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ has_seen_onboarding: true });
  });

  it("Choose folder calls Tauri's open() and patches output_dir on success", async () => {
    useAppStore.setState({ settings: makeSettings() });
    dialogMocks.open.mockResolvedValueOnce("/picked/path");
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /Choose a different folder/ }));
    await waitFor(() => {
      expect(apiMocks.settings.set).toHaveBeenCalledWith(
        expect.objectContaining({ output_dir: "/picked/path" }),
      );
    });
  });

  it("Choose folder dismissed (returns null) does not patch settings", async () => {
    useAppStore.setState({ settings: makeSettings() });
    dialogMocks.open.mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<Onboarding />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /Choose a different folder/ }));
    expect(apiMocks.settings.set).not.toHaveBeenCalled();
  });

  it("focuses the primary action when the dialog opens", async () => {
    useAppStore.setState({ settings: makeSettings() });
    render(<Onboarding />);
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Continue" }),
      );
    });
  });

  it("Tab from the last focusable element wraps back to the first (focus trap)", async () => {
    useAppStore.setState({ settings: makeSettings() });
    render(<Onboarding />);
    const skip = screen.getByRole("button", { name: "Skip" });
    const continueBtn = screen.getByRole("button", { name: "Continue" });
    // Wait for autoFocus to land on Continue, then move to the last
    // focusable (Continue is the last in DOM order on step 1: Skip
    // appears first, Continue last) and Tab forward.
    await waitFor(() => {
      expect(document.activeElement).toBe(continueBtn);
    });
    const tabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(tabEvent);
    // Focus should wrap to the first focusable (Skip).
    expect(document.activeElement).toBe(skip);
  });
});
