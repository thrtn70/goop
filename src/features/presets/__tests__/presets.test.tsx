import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PresetChips from "@/features/presets/PresetChips";
import PresetManager from "@/features/presets/PresetManager";
import UpdateBanner from "@/components/UpdateBanner";
import { api } from "@/ipc/commands";
import { useAppStore } from "@/store/appStore";
import type { Preset, Settings, UpdateInfo } from "@/types";

const importMocks = vi.hoisted(() => ({open:vi.fn(),read:vi.fn()}));
vi.mock("@tauri-apps/plugin-dialog", () => ({open:importMocks.open,save:vi.fn()}));
vi.mock("@tauri-apps/plugin-fs", () => ({readTextFile:importMocks.read,writeTextFile:vi.fn()}));
// --- IPC mock ---

vi.mock("@/ipc/commands", () => ({
  api: {
    preset: {
      list: vi.fn().mockResolvedValue([]),
      import: vi.fn().mockResolvedValue([]),
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

  it("applies independently owned nested video transforms", async () => {
    const video_options = {kind:"encode" as const,codec:"h264" as const,processor:"software" as const,speed:"medium" as const,
      rate_control:{kind:"constant_quality" as const,crf:23},resize:{kind:"fit_within" as const,width:1920,height:1080},
      frame_rate:{kind:"constant" as const,numerator:24000,denominator:1001}};
    const preset = makePreset({id:"video",name:"Video",video_options});
    resetStore({presets:[preset]});
    const onApply = vi.fn();
    render(<PresetChips kind="convert" onApply={onApply}/>);
    await userEvent.click(screen.getByRole("button",{name:"Video"}));
    const applied = onApply.mock.calls[0][0] as Preset;
    if (applied.video_options?.kind !== "encode" || applied.video_options.resize?.kind !== "fit_within" || applied.video_options.frame_rate?.kind !== "constant") throw new Error("expected transformed Encode preset");
    applied.video_options.resize.width = 640;
    applied.video_options.frame_rate.numerator = 60;
    expect(video_options.resize.width).toBe(1920);
    expect(video_options.frame_rate.numerator).toBe(24000);
  });

  it("labels and independently applies a portable choose-per-file track policy", async () => {
    const policy = { kind: "audio" as const, selection: { kind: "choose_per_file" as const } };
    const preset = makePreset({ id: "audio", name: "Podcast", target: "m4a", audio_options: { kind: "copy" }, track_policy: policy });
    resetStore({ presets: [preset] });
    const onApply = vi.fn();
    render(<PresetChips kind="convert" onApply={onApply} />);
    expect(screen.getByText("· Choose track")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: /Podcast.*Choose track/ }));
    const applied = onApply.mock.calls[0][0] as Preset;
    expect(applied.track_policy).toEqual(policy);
    expect(applied.track_policy).not.toBe(policy);
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
    expect(list.getAttribute("role")).toBe("list");
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

describe("JPEG preset save snapshot", () => {
  afterEach(cleanup);
  beforeEach(() => { vi.clearAllMocks(); resetStore(); });

  it("captures a deep copy when opened, including nested resize settings", async () => {
    const { default: PresetSaveDialog } = await import("@/features/presets/PresetSaveDialog");
    const options = { jpeg_quality: 90, resize: { kind: "fit_within" as const, width: 2048, height: 2048 } };
    const snapshot = { target: "jpeg" as const, image_options: options };
    const { rerender } = render(<PresetSaveDialog open onClose={() => {}} snapshot={snapshot} />);
    options.resize.width = 1;
    rerender(<PresetSaveDialog open onClose={() => {}} snapshot={snapshot} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Preset name" }), "Portrait");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.preset.save).toHaveBeenCalledWith(expect.objectContaining({ image_options: {
      jpeg_quality: 90, resize: { kind: "fit_within", width: 2048, height: 2048 } } }));
    options.resize.height = 1;
    expect(vi.mocked(api.preset.save).mock.calls[0][0].image_options?.resize).toEqual({ kind: "fit_within", width: 2048, height: 2048 });
  });
});

describe("video preset snapshots", () => {
  afterEach(cleanup);
  beforeEach(() => { vi.clearAllMocks(); resetStore(); });
  it("captures nested video controls when opened before later edits", async () => {
    const {default: Dialog} = await import("../PresetSaveDialog");
    const options = {kind:"encode" as const,codec:"hevc" as const,processor:"software" as const,speed:"slow" as const,rate_control:{kind:"average_bitrate" as const,kbps:5000},
      resize:{kind:"fit_within" as const,width:1920,height:1080},frame_rate:{kind:"constant" as const,numerator:30000,denominator:1001}};
    render(<Dialog open onClose={() => {}} snapshot={{target:"mov",video_options:options}}/>);
    options.rate_control.kbps=8000; options.resize.width=640; options.frame_rate.numerator=60;
    await userEvent.type(screen.getByRole("textbox",{name:"Preset name"}),"Video");
    await userEvent.click(screen.getByRole("button",{name:"Save"}));
    expect(api.preset.save).toHaveBeenCalledWith(expect.objectContaining({video_options:{...options,
      rate_control:{kind:"average_bitrate",kbps:5000},resize:{kind:"fit_within",width:1920,height:1080},
      frame_rate:{kind:"constant",numerator:30000,denominator:1001}}}));
  });
  it("refuses captured invalid raw settings", async () => {
    const {default: Dialog} = await import("../PresetSaveDialog");
    render(<Dialog open onClose={() => {}} validationError="Video CRF must be a whole number from 1 to 51" snapshot={{target:"mp4",video_options:{kind:"copy"}}}/>);
    await userEvent.type(screen.getByRole("textbox",{name:"Preset name"}),"Invalid");
    await userEvent.click(screen.getByRole("button",{name:"Save"}));
    expect(api.preset.save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("whole number");
  });
});

describe("audio track preset snapshots", () => {
  afterEach(cleanup);
  beforeEach(() => { vi.clearAllMocks(); resetStore(); });

  it("explains and saves Choose per file without a source binding", async () => {
    const { default: Dialog } = await import("../PresetSaveDialog");
    render(<Dialog open onClose={() => {}} snapshot={{
      target: "m4a",
      audio_options: { kind: "copy" },
      track_policy: { kind: "audio", selection: { kind: "choose_per_file" } },
    }} />);
    expect(screen.getByText("Audio track will be chosen for each source.")).toBeDefined();
    await userEvent.type(screen.getByRole("textbox", { name: "Preset name" }), "Commentary workflow");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(api.preset.save).toHaveBeenCalledOnce());
    const saved = vi.mocked(api.preset.save).mock.calls[0][0];
    expect(saved.track_policy).toEqual({ kind: "audio", selection: { kind: "choose_per_file" } });
    expect(JSON.stringify(saved)).not.toMatch(/canonical_path|stream_index|inventory/);
  });
});

describe("atomic preset import UI", () => {
  afterEach(cleanup);
  beforeEach(() => {vi.clearAllMocks(); resetStore({presets:[makePreset({id:"old",name:"Keep"})]});
    importMocks.open.mockResolvedValue("/presets.json");
    importMocks.read.mockResolvedValue(JSON.stringify({version:3,presets:[{name:"First",target:"mp4",video_options:{kind:"copy"}},{name:"Second",target:"mov",video_options:{kind:"copy"}}]}));
  });
  it("sends one bulk invocation and refreshes only after success", async () => {
    vi.mocked(api.preset.import).mockResolvedValueOnce([]);
    render(<PresetManager/>);
    await userEvent.click(screen.getByRole("button",{name:"Import…"}));
    expect(api.preset.import).toHaveBeenCalledOnce();
    expect(vi.mocked(api.preset.import).mock.calls[0][0]).toHaveLength(2);
    expect(api.preset.save).not.toHaveBeenCalled();
    expect(api.preset.list).toHaveBeenCalledOnce();
  });
  it("does not install or refresh any item after backend rejection", async () => {
    vi.mocked(api.preset.import).mockRejectedValueOnce(new Error("storage failed"));
    render(<PresetManager/>);
    await userEvent.click(screen.getByRole("button",{name:"Import…"}));
    expect(api.preset.import).toHaveBeenCalledOnce();
    expect(api.preset.save).not.toHaveBeenCalled(); expect(api.preset.list).not.toHaveBeenCalled();
    expect(useAppStore.getState().presets.map(p => p.id)).toEqual(["old"]);
    expect(await screen.findByText("storage failed")).toBeDefined();
  });
});
