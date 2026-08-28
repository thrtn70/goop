import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import ConvertPage from "@/pages/ConvertPage";
import { useAppStore } from "@/store/appStore";
import type { ProbeResult } from "@/types";

// --- Mocks ---

const { mockProbe, mockFromFile, mockOpen, mockSave } = vi.hoisted(() => ({
  mockProbe: vi.fn(),
  mockFromFile: vi.fn(),
  mockOpen: vi.fn(),
  mockSave: vi.fn(),
}));

vi.mock("@/ipc/commands", () => ({
  api: {
    convert: {
      probe: (path: string) => mockProbe(path),
      fromFile: (req: unknown) => mockFromFile(req),
    },
    queue: { list: vi.fn().mockResolvedValue([]) },
    settings: { get: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
  save: (...args: unknown[]) => mockSave(...args),
}));

// --- Fixtures ---

const mp4Probe: ProbeResult = {
  duration_ms: BigInt(120_000),
  width: 1920,
  height: 1080,
  video_codec: "h264",
  audio_codec: "aac",
  file_size: BigInt(10_485_760),
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  has_video: true,
  has_audio: true,
  source_kind: "video",
  color_space: null,
  image_format: null,
  has_subtitles: false,
  subtitle_codecs: [],
  audio_codecs: ["aac"],
};

const audioOnlyProbe: ProbeResult = {
  duration_ms: BigInt(180_000),
  width: null,
  height: null,
  video_codec: null,
  audio_codec: "opus",
  file_size: BigInt(2_048_000),
  container: "ogg",
  has_video: false,
  has_audio: true,
  source_kind: "audio",
  color_space: null,
  image_format: null,
  has_subtitles: false,
  subtitle_codecs: [],
  audio_codecs: ["opus"],
};

const imageProbe: ProbeResult = {
  duration_ms: BigInt(0),
  width: 1920,
  height: 1080,
  video_codec: null,
  audio_codec: null,
  file_size: BigInt(500_000),
  container: null,
  has_video: false,
  has_audio: false,
  source_kind: "image",
  color_space: "sRGB",
  image_format: "PNG",
  has_subtitles: false,
  subtitle_codecs: [],
  audio_codecs: [],
};

const srtProbe: ProbeResult = {
  duration_ms: BigInt(0),
  width: null,
  height: null,
  video_codec: null,
  audio_codec: null,
  file_size: BigInt(1_200),
  container: "srt",
  has_video: false,
  has_audio: false,
  source_kind: "subtitle",
  color_space: null,
  image_format: null,
  has_subtitles: true,
  subtitle_codecs: ["subrip"],
  audio_codecs: [],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/convert"]}>
      <ConvertPage />
    </MemoryRouter>,
  );
}

// --- Tests ---

describe("ConvertPage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpen.mockResolvedValue(["/tmp/test-video.mp4"]);
    mockSave.mockResolvedValue("/tmp/out.mp4");
  });

  it("renders the empty drop zone with browse link", () => {
    renderPage();
    expect(screen.getByText(/drop something here/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /pick from your computer/i })).toBeDefined();
  });

  it("shows file row after browse + probe", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));

    await waitFor(() => {
      expect(screen.getByText("test-video.mp4")).toBeDefined();
    });

    expect(mockProbe).toHaveBeenCalledWith("/tmp/test-video.mp4");
  });

  it("shows probe metadata after resolution", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));

    await waitFor(() => {
      expect(screen.getByText("test-video.mp4")).toBeDefined();
    });

    expect(screen.getByText(/1920.*1080/)).toBeDefined();
  });

  it("auto-selects smart default based on probe", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));

    await waitFor(() => {
      expect(screen.getByText("test-video.mp4")).toBeDefined();
    });

    const mp4Btn = screen.getByRole("button", { name: "MP4" });
    expect(mp4Btn.className).toContain("bg-accent");
  });

  it("hides video targets for audio-only files", async () => {
    mockProbe.mockResolvedValue(audioOnlyProbe);
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));

    await waitFor(() => {
      expect(screen.getByText("test-video.mp4")).toBeDefined();
    });

    // Video targets should not be rendered for audio-only sources
    expect(screen.queryByRole("button", { name: "MP4" })).toBeNull();

    // Extract audio should be the smart default
    const extractBtn = screen.getByRole("button", { name: "Extract audio" });
    expect(extractBtn).toHaveProperty("disabled", false);
    expect(extractBtn.className).toContain("bg-accent");
  });

  it("shows error state with retry on probe failure", async () => {
    mockProbe.mockRejectedValue({ code: "sidecar_missing", message: "ffprobe" });
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));

    await waitFor(() => {
      expect(screen.getByText(/try again/i)).toBeDefined();
    });

    expect(screen.getByText(/remove/i)).toBeDefined();
  });

  it("enqueues a convert job via Save-As for single file", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    mockFromFile.mockResolvedValue("job-id-1");
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));

    await waitFor(() => {
      expect(screen.getByText("test-video.mp4")).toBeDefined();
    });

    const convertBtn = screen.getByRole("button", { name: /convert 1 file/i });
    await userEvent.click(convertBtn);

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalled();
      expect(mockFromFile).toHaveBeenCalledWith(
        expect.objectContaining({
          input_path: "/tmp/test-video.mp4",
          output_path: "/tmp/out.mp4",
          target: "mp4",
        }),
      );
    });
  });

  it("offers subtitles for video sources and hides them for audio-only", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    const { unmount } = renderPage();
    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() => expect(screen.getByText("test-video.mp4")).toBeDefined());
    expect(screen.getByText(/subtitles:/i)).toBeDefined();
    unmount();
    cleanup();

    mockProbe.mockResolvedValue(audioOnlyProbe);
    renderPage();
    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() => expect(screen.getByText("test-video.mp4")).toBeDefined());
    expect(screen.queryByText(/subtitles:/i)).toBeNull();
  });

  it("sends the picked subtitle with the convert request", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    mockFromFile.mockResolvedValue("job-id-1");
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() => expect(screen.getByText("test-video.mp4")).toBeDefined());

    // The browse dialog and the subtitle picker share the same mock, so
    // swap its answer before opening the subtitle one.
    mockOpen.mockResolvedValue("/tmp/movie.srt");
    await userEvent.click(screen.getByRole("button", { name: /add file/i }));
    await waitFor(() => expect(screen.getByText("movie.srt")).toBeDefined());

    await userEvent.click(screen.getByRole("button", { name: /convert 1 file/i }));

    await waitFor(() => {
      expect(mockFromFile).toHaveBeenCalledWith(
        expect.objectContaining({
          subtitle: { source_path: "/tmp/movie.srt", mode: "soft" },
        }),
      );
    });
  });

  it("drops the subtitle when switching to a target that can't carry one", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    mockFromFile.mockResolvedValue("job-id-1");
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() => expect(screen.getByText("test-video.mp4")).toBeDefined());

    mockOpen.mockResolvedValue("/tmp/movie.srt");
    await userEvent.click(screen.getByRole("button", { name: /add file/i }));
    await waitFor(() => expect(screen.getByText("movie.srt")).toBeDefined());

    // GIF has no video track to mux into and no burn-in support.
    await userEvent.click(screen.getByRole("button", { name: "GIF" }));
    expect(screen.queryByText("movie.srt")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /convert 1 file/i }));
    await waitFor(() => {
      expect(mockFromFile).toHaveBeenCalledWith(
        expect.objectContaining({ target: "gif", subtitle: null }),
      );
    });
  });

  it("switches a soft track to burn-in for a container without subtitle tracks", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() => expect(screen.getByText("test-video.mp4")).toBeDefined());

    mockOpen.mockResolvedValue("/tmp/movie.srt");
    await userEvent.click(screen.getByRole("button", { name: /add file/i }));
    await waitFor(() => expect(screen.getByText("movie.srt")).toBeDefined());

    await userEvent.click(screen.getByRole("button", { name: "AVI" }));

    // The file is kept, but the only supported mode is now selected.
    expect(screen.getByText("movie.srt")).toBeDefined();
    expect(screen.getByRole("button", { name: /burn in/i }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: /soft track/i })).toHaveProperty("disabled", true);
  });

  it("keeps a subtitle through a detour via an incompatible target", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    mockFromFile.mockResolvedValue("job-id-1");
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() => expect(screen.getByText("test-video.mp4")).toBeDefined());

    mockOpen.mockResolvedValue("/tmp/movie.srt");
    await userEvent.click(screen.getByRole("button", { name: /add file/i }));
    await waitFor(() => expect(screen.getByText("movie.srt")).toBeDefined());

    // Tap GIF by mistake, then back to MP4: re-picking the file would be
    // an annoying tax on a misclick.
    await userEvent.click(screen.getByRole("button", { name: "GIF" }));
    await userEvent.click(screen.getByRole("button", { name: "MP4" }));

    expect(screen.getByText("movie.srt")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: /convert 1 file/i }));
    await waitFor(() => {
      expect(mockFromFile).toHaveBeenCalledWith(
        expect.objectContaining({
          target: "mp4",
          subtitle: { source_path: "/tmp/movie.srt", mode: "soft" },
        }),
      );
    });
  });

  it("reconciles a subtitle that apply-to-all left on an incompatible target", async () => {
    // The bug this guards: "apply to all" overwrites `target` on the other
    // rows without going through the row's own coercion, so a subtitle
    // picked for MP4 could ride along to a format that can't carry it and
    // be rejected by the backend.
    mockOpen.mockResolvedValue(["/tmp/a.mp4", "/tmp/b.mp4"]);
    mockProbe.mockResolvedValue(mp4Probe);
    mockFromFile.mockResolvedValue("job-id-1");
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() => expect(screen.getByText("a.mp4")).toBeDefined());

    // Attach a subtitle to the SECOND row, then set the first row to GIF
    // and push that target onto every row.
    mockOpen.mockResolvedValue("/tmp/movie.srt");
    const addButtons = screen.getAllByRole("button", { name: /add file/i });
    await userEvent.click(addButtons[1]);
    await waitFor(() => expect(screen.getByText("movie.srt")).toBeDefined());

    await userEvent.click(screen.getAllByRole("button", { name: "GIF" })[0]);
    await userEvent.click(screen.getByRole("button", { name: /apply to all/i }));
    await userEvent.click(screen.getByRole("button", { name: /convert 2 files/i }));

    await waitFor(() => expect(mockFromFile).toHaveBeenCalledTimes(2));
    const payloads = mockFromFile.mock.calls.map(([req]) => req);
    // Guard against a vacuous pass: apply-to-all must really have pushed
    // GIF onto both rows, which is what creates the bad pairing.
    expect(payloads.every((p) => p.target === "gif")).toBe(true);
    expect(payloads.every((p) => p.subtitle === null)).toBe(true);
  });

  it("offers only subtitle targets for a bare subtitle file", async () => {
    mockProbe.mockResolvedValue(srtProbe);
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() => expect(screen.getByText("test-video.mp4")).toBeDefined());

    expect(screen.queryByRole("button", { name: "MP4" })).toBeNull();
    expect(screen.queryByRole("button", { name: "MP3" })).toBeNull();
    // A .srt source defaults to the other format, since srt->srt is a no-op.
    expect(screen.getByRole("button", { name: /WebVTT/ }).className).toContain("bg-accent");
    expect(screen.getByRole("button", { name: "SRT" })).toBeDefined();
  });

  it("removes file row when remove is clicked", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));

    await waitFor(() => {
      expect(screen.getByText("test-video.mp4")).toBeDefined();
    });

    await userEvent.click(screen.getByText("Remove"));

    await waitFor(() => {
      expect(screen.queryByText("test-video.mp4")).toBeNull();
    });
  });

  it("shows image targets only for image sources", async () => {
    mockProbe.mockResolvedValue(imageProbe);
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));

    await waitFor(() => {
      expect(screen.getByText("test-video.mp4")).toBeDefined();
    });

    // Image targets should be visible
    expect(screen.getByRole("button", { name: "PNG" })).toBeDefined();
    expect(screen.getByRole("button", { name: "JPEG" })).toBeDefined();

    // Video targets should NOT be visible
    expect(screen.queryByRole("button", { name: "MP4" })).toBeNull();
    expect(screen.queryByRole("button", { name: "MKV" })).toBeNull();
  });

  it("does not show compression presets on Convert page (moved to Compress tab in v0.1.6)", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));

    await waitFor(() => {
      expect(screen.getByText("test-video.mp4")).toBeDefined();
    });

    // Compression preset buttons should no longer appear on Convert.
    expect(screen.queryByRole("button", { name: "Fast" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Balanced" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Small" })).toBeNull();
    // Resolution cap buttons should also be gone.
    expect(screen.queryByRole("button", { name: "1080p" })).toBeNull();
    expect(screen.queryByRole("button", { name: "720p" })).toBeNull();
  });
});

describe("ConvertPage applies what a preset chip promises", () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ presets: [] });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpen.mockResolvedValue(["/tmp/test-video.mp4"]);
    mockSave.mockResolvedValue("/tmp/out.mp4");
    mockProbe.mockResolvedValue(mp4Probe);
    // The shape `builtin_defaults()` seeds on first launch: "YouTube
    // Upload" really does carry a 1080p cap.
    useAppStore.setState({
      presets: [
        {
          id: "p1",
          name: "YouTube Upload",
          target: "mp4",
          quality_preset: "balanced",
          resolution_cap: "r1080p",
          compress_mode: null,
          is_builtin: true,
          created_at: 0n,
        },
      ],
    });
  });

  async function stageFileAndApplyPreset() {
    renderPage();
    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() => expect(screen.getByText("test-video.mp4")).toBeDefined());
    await userEvent.click(screen.getByRole("listitem", { name: "YouTube Upload" }));
  }

  it("sends the preset's quality and resolution cap on a single file", async () => {
    // The chip used to change only `target`, so a 4K source came out 4K
    // while the button said 1080p.
    await stageFileAndApplyPreset();
    await userEvent.click(screen.getByRole("button", { name: /convert 1 file/i }));
    await waitFor(() => expect(mockFromFile).toHaveBeenCalled());
    const req = mockFromFile.mock.calls[0]?.[0];
    expect(req.quality_preset).toBe("balanced");
    expect(req.resolution_cap).toBe("r1080p");
  });

  it("sends nothing extra when no preset was applied", async () => {
    // The default path must stay untouched: absent means absent, not a
    // silently-invented default.
    renderPage();
    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() => expect(screen.getByText("test-video.mp4")).toBeDefined());
    await userEvent.click(screen.getByRole("button", { name: /convert 1 file/i }));
    await waitFor(() => expect(mockFromFile).toHaveBeenCalled());
    const req = mockFromFile.mock.calls[0]?.[0];
    expect(req.quality_preset).toBeNull();
    expect(req.resolution_cap).toBeNull();
  });

  it("round-trips: saving the applied settings back out keeps them", async () => {
    // Otherwise the fix leaks straight back out the other side — apply
    // "YouTube Upload", click "Save as preset", and the new preset is
    // born with null quality and resolution, recreating the same lie.
    const savePreset = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ savePreset });
    await stageFileAndApplyPreset();
    await userEvent.click(screen.getByRole("button", { name: /save as preset/i }));
    await userEvent.type(screen.getByRole("textbox"), "My Preset");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(savePreset).toHaveBeenCalled());
    const saved = savePreset.mock.calls[0]?.[0];
    expect(saved.quality_preset).toBe("balanced");
    expect(saved.resolution_cap).toBe("r1080p");
  });

  it("carries the preset through a multi-file batch too", async () => {
    // The batch branch builds its own request object, so it can drop the
    // fields independently of the single-file branch.
    mockOpen.mockResolvedValue(["/tmp/a.mp4", "/tmp/b.mp4"]);
    renderPage();
    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() => expect(screen.getByText("a.mp4")).toBeDefined());
    await userEvent.click(screen.getByRole("listitem", { name: "YouTube Upload" }));
    await userEvent.click(screen.getByRole("button", { name: /convert 2 files/i }));
    await waitFor(() => expect(mockFromFile).toHaveBeenCalledTimes(2));
    for (const call of mockFromFile.mock.calls) {
      expect(call[0].quality_preset).toBe("balanced");
      expect(call[0].resolution_cap).toBe("r1080p");
    }
  });
});
