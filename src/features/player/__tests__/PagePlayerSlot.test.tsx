import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import ConvertPage from "@/pages/ConvertPage";
import CompressPage from "@/pages/CompressPage";
import { useAppStore } from "@/store/appStore";
import { clearWorkspaceDrafts } from "@/store/workspaceDrafts";
import type { Settings } from "@/types";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  open: vi.fn(),
  throws: false,
}));

vi.mock("@/ipc/commands", () => ({
  api: {
    convert: { inspect: mocks.inspect, fromFile: vi.fn() },
    preview: {
      eligibility: vi.fn().mockResolvedValue({ available: true, reason: null }),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
    queue: { list: vi.fn().mockResolvedValue([]) },
    pdf: { probe: vi.fn().mockResolvedValue({ pages: 3 }) },
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: vi.fn() }));
vi.mock("@/features/convert/DropZone", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/features/presets/PresetChips", () => ({ default: () => null }));
vi.mock("@/features/presets/PresetSaveDialog", () => ({ default: () => null }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/") }));

// Stands in for the real player: shows the collapse flag it was handed and can fall over on demand.
vi.mock("@/features/player/SourcePlayer", () => ({
  default: ({ path, collapsed, onToggleCollapsed }: { path: string; collapsed: boolean; onToggleCollapsed: () => void }) => {
    if (mocks.throws) throw new Error("player exploded");
    return (
      <button type="button" onClick={onToggleCollapsed}>
        {(collapsed ? "Show " : "Hide ") + path}
      </button>
    );
  },
}));

const inspection = {
  probe: {
    source_kind: "video",
    video_codec: "h264",
    audio_codec: "aac",
    has_video: true,
    has_audio: true,
    duration_ms: 1000,
    file_size: 100,
    width: 2,
    height: 2,
    audio_codecs: ["aac"],
    subtitle_codecs: [],
  },
  capabilities: {
    targets: ["mp4", "mkv", "gif"].map((target) => ({ target, available: true, reason: null, metadata_warning: null })),
    compression: { quality: true, target_size: true, lossless: false, reason: null },
  },
};

// jsdom prints a render error as "Uncaught" before React hands it to the boundary; claim the expected one.
const claimExpectedError = (event: ErrorEvent) => {
  if (event.error?.message === "player exploded") event.preventDefault();
};

const setPlayerSetting = (media_player_enabled: boolean) =>
  useAppStore.setState({ settings: { media_player_enabled } as Settings });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.throws = false;
  mocks.inspect.mockResolvedValue(inspection);
  mocks.open.mockResolvedValue(["/a.mp4"]);
  clearWorkspaceDrafts("convert");
  clearWorkspaceDrafts("compress");
  useAppStore.setState((s) => ({ settings: null, ui: { ...s.ui, playerCollapsed: false } }));
});

afterEach(() => {
  window.removeEventListener("error", claimExpectedError);
  vi.restoreAllMocks();
  cleanup();
  useAppStore.setState({ settings: null });
});

const page = (tool: "convert" | "compress") => (
  <MemoryRouter>{tool === "convert" ? <ConvertPage /> : <CompressPage />}</MemoryRouter>
);

async function stage(tool: "convert" | "compress") {
  const view = render(page(tool));
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  const action = await screen.findByRole("button", { name: (tool === "convert" ? "Convert" : "Compress") + " 1 file" });
  await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
  return view;
}

const slot = () => document.querySelector(".workspace-inspector-media");

for (const tool of ["convert", "compress"] as const) {
  const label = tool === "convert" ? "Convert" : "Compress";

  describe(`${tool} page player slot`, () => {
    it("adds no media element while the player is off", async () => {
      setPlayerSetting(false);
      await stage(tool);
      expect(slot()).toBeNull();
      expect(screen.queryByRole("button", { name: /^(Hide|Show) / })).toBeNull();
    });

    it("pins the player above the settings while it is on", async () => {
      setPlayerSetting(true);
      await stage(tool);
      const media = slot();
      const scroll = document.querySelector(".workspace-inspector-scroll");
      expect(media).not.toBeNull();
      expect(media?.textContent).toBe("Hide /a.mp4");
      expect(media!.compareDocumentPosition(scroll!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("keeps the collapse choice when the page is left and another tool is opened", async () => {
      setPlayerSetting(true);
      const first = await stage(tool);
      fireEvent.click(await screen.findByRole("button", { name: "Hide /a.mp4" }));
      expect(screen.getByRole("button", { name: "Show /a.mp4" })).toBeTruthy();
      first.unmount();

      await stage(tool === "convert" ? "compress" : "convert");
      expect(await screen.findByRole("button", { name: "Show /a.mp4" })).toBeTruthy();
    });

    it(`keeps ${label} working when the player throws`, async () => {
      // React and the boundary both report the caught error; the output is expected here.
      vi.spyOn(console, "error").mockImplementation(() => {});
      window.addEventListener("error", claimExpectedError);
      mocks.throws = true;
      setPlayerSetting(true);
      await stage(tool);
      expect(await screen.findByText("Preview unavailable.")).toBeTruthy();
      expect((screen.getByRole("button", { name: label + " 1 file" }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByRole("button", { name: "Select a.mp4" })).toBeTruthy();
    });
  });
}
