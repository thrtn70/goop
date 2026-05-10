import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SettingsPage from "@/pages/SettingsPage";
import { useAppStore } from "@/store/appStore";
import type { Settings } from "@/types";

function renderPage(initialEntries: string[] = ["/settings"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

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
    notifications_enabled: false,
    output_dir_extract: null,
    extract_naming_scheme: "title",
    ...overrides,
  };
}

beforeEach(() => {
  apiMocks.settings.set.mockReset();
  // Mirror the Rust backend's apply_patch: regular Option<T> fields use
  // `if let Some(v)` and so a `null` on the wire means "no change", not
  // "set to null". Spreading the patch verbatim would overwrite theme,
  // cookies, etc. to null on every save and trigger React controlled-input
  // warnings on re-render.
  //
  // Caveat for future tests: the tri-state fields (cookies_from_browser,
  // output_dir_extract) deliberately use `null` to mean "clear" on the
  // wire. Tests that exercise the Clear-button flow on those fields will
  // need a different mock that preserves explicit-null for those keys.
  // Today's tests only patch regular Option<T> fields.
  apiMocks.settings.set.mockImplementation(async (patch: Partial<Settings>) => {
    const current = useAppStore.getState().settings ?? makeSettings();
    const applied = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== null),
    );
    return { ...current, ...applied } as Settings;
  });
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
    renderPage();
    expect(screen.getByText("/Users/example/Downloads")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Browse for output folder" })).toBeTruthy();
    // No typed-input affordance for output_dir.
    expect(screen.queryByDisplayValue("/Users/example/Downloads")).toBeNull();
  });

  it("opens directory picker and patches output_dir on success", async () => {
    dialogMocks.open.mockResolvedValue("/picked/folder");
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole("button", { name: "Browse for output folder" }));

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

    renderPage();
    await user.click(screen.getByRole("button", { name: "Browse for output folder" }));

    await waitFor(() => expect(dialogMocks.open).toHaveBeenCalled());
    expect(apiMocks.settings.set).not.toHaveBeenCalled();
  });
});
