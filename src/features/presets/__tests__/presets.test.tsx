import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PresetChips from "@/features/presets/PresetChips";
import PresetManager from "@/features/presets/PresetManager";
import UpdateBanner from "@/components/UpdateBanner";
import { api } from "@/ipc/commands";
import { useAppStore } from "@/store/appStore";
import type { Preset, Settings, UpdateInfo } from "@/types";

// --- IPC mock ---

vi.mock("@/ipc/commands", () => ({
  api: {
    preset: {
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn(async (p: Preset) => p),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    update: {
      check: vi.fn().mockResolvedValue(null),
      download: vi.fn().mockResolvedValue(undefined),
      openReleasesPage: vi.fn().mockResolvedValue(undefined),
    },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(async (p: unknown) => p),
    },
    queue: { list: vi.fn().mockResolvedValue([]) },
    sidecar: {
      status: vi.fn(),
      updateYtDlp: vi.fn(),
      ytDlpVersion: vi.fn(),
      ffmpegVersion: vi.fn(),
    },
  },
}));

// --- Fixtures ---

function makePreset(overrides: Partial<Preset>): Preset {
  return {
    id: "x",
    name: "X",
    target: "mp4",
    quality_preset: null,
    resolution_cap: null,
    compress_mode: null,
    is_builtin: false,
    created_at: BigInt(1_700_000_000_000),
    ...overrides,
  };
}

function resetStore(patch: Partial<ReturnType<typeof useAppStore.getState>> = {}) {
  useAppStore.setState({
    presets: [],
    updateInfo: null,
    updateDownload: null,
    settings: null,
    ...patch,
  });
}

// --- PresetChips ---

describe("PresetChips", () => {
  afterEach(cleanup);
  beforeEach(() => resetStore());

  it("renders nothing when there are no presets", () => {
    const { container } = render(<PresetChips kind="convert" onApply={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders every preset on the Convert page", () => {
    resetStore({
      presets: [
        makePreset({ id: "a", name: "YouTube Upload" }),
        makePreset({
          id: "b",
          name: "Web Image",
          target: "webp",
          compress_mode: { kind: "quality", value: 85 },
        }),
      ],
    });
    render(<PresetChips kind="convert" onApply={() => {}} />);
    expect(screen.getByRole("button", { name: "YouTube Upload" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Web Image" })).toBeDefined();
  });

  it("hides presets without a compress_mode on the Compress page", () => {
    resetStore({
      presets: [
        makePreset({ id: "a", name: "YouTube Upload" }),
        makePreset({
          id: "b",
          name: "Podcast MP3",
          target: "mp3",
          compress_mode: { kind: "quality", value: 75 },
        }),
      ],
    });
    render(<PresetChips kind="compress" onApply={() => {}} />);
    expect(screen.queryByRole("button", { name: "YouTube Upload" })).toBeNull();
    expect(screen.getByRole("button", { name: "Podcast MP3" })).toBeDefined();
  });

  it("calls onApply with the full preset when a chip is clicked", async () => {
    const preset = makePreset({ id: "a", name: "YouTube Upload" });
    resetStore({ presets: [preset] });
    const onApply = vi.fn();
    render(<PresetChips kind="convert" onApply={onApply} />);
    await userEvent.click(screen.getByRole("button", { name: "YouTube Upload" }));
    expect(onApply).toHaveBeenCalledWith(preset);
  });

  it("exposes named preset buttons in list items with native keyboard activation", async () => {
    const preset = makePreset({
      id: "gif-social",
      name: "Social GIF",
      target: "gif",
      quality_preset: "balanced",
      resolution_cap: "r720p",
      compress_mode: { kind: "target_size_bytes", value: BigInt(8_000_000) },
      metadata_policy: "strip_all",
      gif_options: {
        size_preset: "medium",
        trim_start_ms: BigInt(1_000),
        trim_end_ms: BigInt(5_000),
      },
      subtitle: { source_path: "/tmp/captions.srt", mode: "burn_in" },
      is_builtin: true,
      created_at: BigInt(1_800_000_000_000),
    });
    resetStore({ presets: [preset] });
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(<PresetChips kind="convert" onApply={onApply} />);

    const list = screen.getByRole("list", { name: "Saved presets" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    const button = within(items[0]).getByRole("button", { name: preset.name });

    button.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onApply).toHaveBeenNthCalledWith(1, preset);
    expect(onApply).toHaveBeenNthCalledWith(2, preset);
  });
});

// --- PresetManager ---

describe("PresetManager", () => {
  afterEach(cleanup);
  beforeEach(() => resetStore());

  it("renders empty-state copy when no presets exist", () => {
    render(<PresetManager />);
    expect(screen.getByText(/No saved presets yet/i)).toBeDefined();
  });

  it("disables the delete button for built-in presets", () => {
    resetStore({
      presets: [
        makePreset({ id: "b1", name: "YouTube Upload", is_builtin: true }),
        makePreset({ id: "u1", name: "My Custom", is_builtin: false }),
      ],
    });
    render(<PresetManager />);
    const builtinDelete = screen.getByRole("button", { name: /Delete YouTube Upload/ });
    const customDelete = screen.getByRole("button", { name: /Delete My Custom/ });
    expect(builtinDelete).toHaveProperty("disabled", true);
    expect(customDelete).toHaveProperty("disabled", false);
  });
});

// --- UpdateBanner ---

describe("UpdateBanner", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  const info: UpdateInfo = {
    current_version: "0.1.6",
    latest_version: "0.1.7",
    download_url: "https://x/y/Goop.msi",
    asset_size: BigInt(12_000_000),
    release_notes: "",
    published_at: "2026-04-16T00:00:00Z",
  };

  const settings: Settings = {
    output_dir: "/tmp",
    theme: "dark",
    yt_dlp_last_update_ms: null,
    extract_concurrency: 4,
    convert_concurrency: 2,
    auto_check_updates: true,
    yt_dlp_auto_update: true,
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
  };

  it("renders nothing when no update is available", () => {
    const { container } = render(<UpdateBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a Download button when an update is available", () => {
    resetStore({ updateInfo: info, settings });
    render(<UpdateBanner />);
    expect(screen.getByText(/Goop v0.1.7 is available/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Download" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
  });

  it("stays hidden when this version has been dismissed", () => {
    resetStore({
      updateInfo: info,
      settings: { ...settings, dismissed_update_version: "0.1.7" },
    });
    const { container } = render(<UpdateBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the progress bar while a download is active", () => {
    resetStore({
      updateInfo: info,
      settings,
      updateDownload: { downloaded: 3_000_000, total: 12_000_000, active: true },
    });
    render(<UpdateBanner />);
    expect(screen.getByRole("progressbar")).toBeDefined();
    expect(screen.getByText(/25%/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("asks the backend to select the installer without passing a URL", async () => {
    const download = vi.mocked(api.update.download);
    download.mockResolvedValueOnce(undefined);
    resetStore({ updateInfo: info, settings });
    render(<UpdateBanner />);

    await userEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(download).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledWith();
    expect(useAppStore.getState().updateDownload).toEqual({
      downloaded: 12_000_000,
      total: 12_000_000,
      active: false,
    });
  });

  it("clears download progress and surfaces backend failures", async () => {
    vi.mocked(api.update.download).mockRejectedValueOnce(new Error("download failed"));
    resetStore({ updateInfo: info, settings });
    render(<UpdateBanner />);

    await userEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByText("download failed")).toBeDefined();
    expect(useAppStore.getState().updateDownload).toBeNull();
  });
});
