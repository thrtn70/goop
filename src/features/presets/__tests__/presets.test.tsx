import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PresetChips from "@/features/presets/PresetChips";
import PresetManager from "@/features/presets/PresetManager";
import UpdateBanner from "@/components/UpdateBanner";
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
    expect(screen.getByRole("listitem", { name: "YouTube Upload" })).toBeDefined();
    expect(screen.getByRole("listitem", { name: "Web Image" })).toBeDefined();
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
    expect(screen.queryByRole("listitem", { name: "YouTube Upload" })).toBeNull();
    expect(screen.getByRole("listitem", { name: "Podcast MP3" })).toBeDefined();
  });

  it("calls onApply with the full preset when a chip is clicked", async () => {
    const preset = makePreset({ id: "a", name: "YouTube Upload" });
    resetStore({ presets: [preset] });
    const onApply = vi.fn();
    render(<PresetChips kind="convert" onApply={onApply} />);
    await userEvent.click(screen.getByRole("listitem", { name: "YouTube Upload" }));
    expect(onApply).toHaveBeenCalledWith(preset);
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
  beforeEach(() => resetStore());

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
    dismissed_update_version: null,
    history_view_mode: "list",
    queue_sidebar_width: 288,
    hw_acceleration_enabled: true,
    cookies_from_browser: null,
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
});
