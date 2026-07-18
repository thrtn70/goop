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
  // Mirror the real sidecar IPC surface: loadVersions fans out over all of
  // these, so a missing stub surfaces as "not a function" rather than a
  // meaningful assertion failure if a test ever exercises it for real.
  sidecar: {
    updateYtDlp: vi.fn(),
    updateGalleryDl: vi.fn(),
    ytDlpVersion: vi.fn(),
    ffmpegVersion: vi.fn(),
    galleryDlVersion: vi.fn(),
    ghostscriptVersion: vi.fn(),
    mutoolVersion: vi.fn(),
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
    ghostscript: "10.04.0",
    mutool: "1.27.0",
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
    default_metadata_policy: "preserve",
    torbox_api_key: null,
    ...overrides,
  };
}

// The sidecar-update tests swap in a stubbed loadVersions; keep the real one
// so each test starts from the store's actual implementation.
const realLoadVersions = useAppStore.getState().loadVersions;

beforeEach(() => {
  apiMocks.settings.set.mockReset();
  apiMocks.sidecar.updateYtDlp.mockReset();
  apiMocks.sidecar.updateGalleryDl.mockReset();
  useAppStore.setState({ loadVersions: realLoadVersions });
  // Mirror the Rust backend's apply_patch: regular Option<T> fields use
  // `if let Some(v)` and so a `null` on the wire means "no change", not
  // "set to null". Spreading the patch verbatim would overwrite theme,
  // cookies, etc. to null on every save and trigger React controlled-input
  // warnings on re-render.
  //
  // Caveat for future tests: the tri-state fields (cookies_from_browser,
  // output_dir_extract, torbox_api_key) deliberately use `null` to mean
  // "clear" on the wire. Tests that exercise the clear flow on those
  // fields will need a different mock that preserves explicit-null for
  // those keys. Today's tests only patch regular Option<T> fields.
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

describe("SettingsPage sidecar updates refresh the version cache", () => {
  it("force-refreshes cached versions after yt-dlp actually updates", async () => {
    const loadVersions = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ loadVersions });
    apiMocks.sidecar.updateYtDlp.mockResolvedValue({
      attempted: true,
      previous_version: "2024.10.07",
      new_version: "2024.11.18",
      message: "Updated yt-dlp to 2024.11.18",
    });
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: "Update yt-dlp" }));

    // `true` matters: the cache is warmed at boot, so an unforced call would
    // hand back the pre-update version and leave About stale.
    await waitFor(() => expect(loadVersions).toHaveBeenCalledWith(true));
  });

  it("force-refreshes cached versions after gallery-dl actually updates", async () => {
    const loadVersions = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ loadVersions });
    apiMocks.sidecar.updateGalleryDl.mockResolvedValue({
      attempted: true,
      previous_version: "1.32.0",
      new_version: "1.32.4",
      message: "Updated gallery-dl to 1.32.4",
    });
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: "Update gallery-dl" }));

    await waitFor(() => expect(loadVersions).toHaveBeenCalledWith(true));
  });

  it("keeps the success message when the version refresh fails", async () => {
    const loadVersions = vi.fn().mockRejectedValue(new Error("spawn failed"));
    useAppStore.setState({ loadVersions });
    apiMocks.sidecar.updateYtDlp.mockResolvedValue({
      attempted: true,
      previous_version: "2024.10.07",
      new_version: "2024.11.18",
      message: "Updated yt-dlp to 2024.11.18",
    });
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: "Update yt-dlp" }));

    // The update itself succeeded; a failed re-read must not overwrite that
    // with an error, and must not surface as an unhandled rejection.
    await waitFor(() => expect(loadVersions).toHaveBeenCalledWith(true));
    expect(screen.getByText("Updated yt-dlp to 2024.11.18")).toBeTruthy();
  });

  it("skips the refresh when the update was a no-op", async () => {
    const loadVersions = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ loadVersions });
    apiMocks.sidecar.updateYtDlp.mockResolvedValue({
      attempted: true,
      previous_version: "2024.11.18",
      new_version: "2024.11.18",
      message: "yt-dlp is up to date.",
    });
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: "Update yt-dlp" }));

    await screen.findByText("yt-dlp is up to date.");
    expect(loadVersions).not.toHaveBeenCalled();
  });

  it("skips the refresh when the update failed", async () => {
    const loadVersions = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ loadVersions });
    apiMocks.sidecar.updateYtDlp.mockRejectedValue(new Error("network down"));
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: "Update yt-dlp" }));

    await waitFor(() =>
      expect(screen.getByText(/network down/)).toBeTruthy(),
    );
    expect(loadVersions).not.toHaveBeenCalled();
  });
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
