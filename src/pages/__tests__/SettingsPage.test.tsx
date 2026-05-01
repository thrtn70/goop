import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsPage from "@/pages/SettingsPage";
import { useAppStore } from "@/store/appStore";
import type { Settings } from "@/types";

const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogMocks.open,
}));

// SettingsPage touches several IPC surfaces — mock them broadly so the
// component renders without exploding. Only the `settings.set` mock
// matters for the Browse-picker interaction.
const apiMocks = vi.hoisted(() => ({
  settings: {
    set: vi.fn(),
    get: vi.fn(),
  },
  update: {
    openReleasesPage: vi.fn(),
    openAboutLink: vi.fn(),
  },
  sidecar: {
    updateYtDlp: vi.fn(),
    updateGalleryDl: vi.fn(),
    ytDlpVersion: vi.fn(),
    ffmpegVersion: vi.fn(),
    galleryDlVersion: vi.fn(),
  },
  preset: { list: vi.fn(), save: vi.fn(), delete: vi.fn() },
  thumbnail: { get: vi.fn() },
}));

vi.mock("@/ipc/commands", () => ({
  api: apiMocks,
}));

vi.mock("@/hooks/useAppVersion", () => ({
  useAppVersion: () => ({
    goop: "0.2.1",
    ytDlp: "2024.11.18",
    galleryDl: "1.32.0",
    ffmpeg: "n7.1",
    os: "darwin",
  }),
}));

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    output_dir: "/Users/example/Downloads",
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
    has_seen_onboarding: true,
    ...overrides,
  };
}

beforeEach(() => {
  apiMocks.settings.set.mockReset();
  apiMocks.settings.set.mockImplementation(
    async (patch: Partial<Settings>) => ({
      ...useAppStore.getState().settings,
      ...patch,
    }),
  );
  apiMocks.preset.list.mockResolvedValue([]);
  dialogMocks.open.mockReset();
  useAppStore.setState({
    settings: makeSettings(),
    presets: [],
    updateInfo: null,
  });
});

afterEach(() => {
  cleanup();
});

describe("SettingsPage Output folder Browse picker", () => {
  it("renders the current path and a Browse button (no typed input)", () => {
    render(<SettingsPage />);
    expect(screen.getByText("/Users/example/Downloads")).toBeTruthy();
    // Match the button by its exact label (the ellipsis is U+2026).
    expect(screen.getByText("Browse…")).toBeTruthy();
    // No typed-input affordance for output_dir.
    expect(screen.queryByDisplayValue("/Users/example/Downloads")).toBeNull();
  });

  it("opens directory picker and patches output_dir on success", async () => {
    dialogMocks.open.mockResolvedValue("/picked/folder");
    const user = userEvent.setup();

    render(<SettingsPage />);
    await user.click(screen.getByText("Browse…"));

    await waitFor(() => {
      expect(dialogMocks.open).toHaveBeenCalledWith(
        expect.objectContaining({ directory: true }),
      );
      expect(apiMocks.settings.set).toHaveBeenCalledWith(
        expect.objectContaining({ output_dir: "/picked/folder" }),
      );
    });
  });

  it("does not patch when the user cancels the picker", async () => {
    dialogMocks.open.mockResolvedValue(null);
    const user = userEvent.setup();

    render(<SettingsPage />);
    await user.click(screen.getByText("Browse…"));

    await waitFor(() => expect(dialogMocks.open).toHaveBeenCalled());
    expect(apiMocks.settings.set).not.toHaveBeenCalled();
  });
});
