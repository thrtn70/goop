import { clearWorkspaceDrafts } from "@/store/workspaceDrafts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import ConvertPage from "@/pages/ConvertPage";
import { useAppStore } from "@/store/appStore";
import type { ProbeResult, Settings, Preset } from "@/types";

// --- Mocks ---

const { mockProbe, mockFromFile, mockOpen, mockSave, mockVideoPlan } = vi.hoisted(() => ({
  mockVideoPlan: vi.fn().mockResolvedValue({requested:{kind:"copy"},video_codec:"h264",video_stream_index:0,audio_stream_index:1,audio_codec:"aac",audio_copied:true,width:1920,height:1080,notices:["Color tags are unspecified"]}),
  mockProbe: vi.fn(),
  mockFromFile: vi.fn(),
  mockOpen: vi.fn(),
  mockSave: vi.fn(),
}));

vi.mock("@/ipc/commands", () => ({
  api: {
    convert: {
      videoPlan: (...args: unknown[]) => mockVideoPlan(...args),
      probe: (path: string) => mockProbe(path),
      inspect: async (path: string) => {
        const p = await mockProbe(path);
        const targets =
          p.source_kind === "image"
            ? ["png", "jpeg", "webp", "bmp", "avif", "jpeg_xl", "tiff"]
            : p.source_kind === "subtitle"
              ? ["srt", "vtt"]
              : [
                  ...(p.has_video
                    ? ["mp4", "mkv", "webm", "gif", "avi", "mov"]
                    : []),
                  ...(p.has_audio
                    ? [
                        "mp3",
                        "m4a",
                        "opus",
                        "wav",
                        "flac",
                        "ogg",
                        "aac",
                        "extract_audio_keep_codec",
                      ]
                    : []),
                ];
        return {
          probe: p,
          capabilities: {
            targets: targets.map((target) => ({
              target,
              available: true,
              reason: null,
              preserves_metadata: false,
              metadata_warning: null,
              video_settings: p.source_kind === "video" && ["mp4","mov","mkv"].includes(target) ? {
                copy:{available:true}, encode:{available:path !== "/tmp/unsupported.mp4",reason:"Unknown field order"},
                codecs:[{codec:"h264",encoder:"libx264",available:true},{codec:"hevc",encoder:"libx265",available:true}],
                crf_min:1,crf_max:51,default_crf:23,bitrate_min_kbps:100,bitrate_max_kbps:200000,default_bitrate_kbps:5000,
                speeds:["fast","medium","slow"],default_speed:"medium",processor:"software",preview_available:false,preview_unavailable_reason:"Explicit video samples are unavailable."
              } : null,
            })),
            compression: {
              quality: true,
              target_size: true,
              lossless: false,
              reason: null,
            },
          },
        };
      },
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
    expect(
      screen.getByRole("button", { name: /pick from your computer/i }),
    ).toBeDefined();
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
    clearWorkspaceDrafts("convert");
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
    mockProbe.mockRejectedValue({
      code: "sidecar_missing",
      message: "ffprobe",
    });
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
    await waitFor(() =>
      expect(screen.getByText("test-video.mp4")).toBeDefined(),
    );
    expect(screen.getByText(/subtitles:/i)).toBeDefined();
    unmount();
    cleanup();

    clearWorkspaceDrafts("convert");
    mockProbe.mockResolvedValue(audioOnlyProbe);
    renderPage();
    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() =>
      expect(screen.getByText("test-video.mp4")).toBeDefined(),
    );
    expect(screen.queryByText(/subtitles:/i)).toBeNull();
  });

  it("sends the picked subtitle with the convert request", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    mockFromFile.mockResolvedValue("job-id-1");
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() =>
      expect(screen.getByText("test-video.mp4")).toBeDefined(),
    );

    // The browse dialog and the subtitle picker share the same mock, so
    // swap its answer before opening the subtitle one.
    mockOpen.mockResolvedValue("/tmp/movie.srt");
    await userEvent.click(
      screen.getByRole("button", { name: /^add file\.\.\.$/i }),
    );
    await waitFor(() => expect(screen.getByText("movie.srt")).toBeDefined());

    await userEvent.click(
      screen.getByRole("button", { name: /convert 1 file/i }),
    );

    await waitFor(() => {
      expect(mockFromFile).toHaveBeenCalledWith(
        expect.objectContaining({
          subtitle: { source_path: "/tmp/movie.srt", mode: "soft" },
        }),
      );
    });
  });

  it("requires explicit removal of subtitles for an incompatible output", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    mockFromFile.mockResolvedValue("job-id-1");
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() =>
      expect(screen.getByText("test-video.mp4")).toBeDefined(),
    );

    mockOpen.mockResolvedValue("/tmp/movie.srt");
    await userEvent.click(
      screen.getByRole("button", { name: /^add file\.\.\.$/i }),
    );
    await waitFor(() => expect(screen.getByText("movie.srt")).toBeDefined());

    // GIF has no video track to mux into and no burn-in support.
    await userEvent.click(screen.getByRole("button", { name: "GIF" }));
    expect(screen.getByText("movie.srt")).toBeDefined();
    expect(screen.getByRole("button", {name:/convert 1 file/i})).toHaveProperty("disabled", true);
    expect(mockFromFile).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", {name:/remove subtitle/i}));

    await userEvent.click(
      screen.getByRole("button", { name: /convert 1 file/i }),
    );
    await waitFor(() => {
      expect(mockFromFile).toHaveBeenCalledWith(
        expect.objectContaining({ target: "gif", subtitle: null }),
      );
    });
  });

  it("requires an explicit subtitle mode change for AVI", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() =>
      expect(screen.getByText("test-video.mp4")).toBeDefined(),
    );

    mockOpen.mockResolvedValue("/tmp/movie.srt");
    await userEvent.click(
      screen.getByRole("button", { name: /^add file\.\.\.$/i }),
    );
    await waitFor(() => expect(screen.getByText("movie.srt")).toBeDefined());

    await userEvent.click(screen.getByRole("button", { name: "AVI" }));

    // The saved intent remains visible until the user chooses a supported mode.
    expect(screen.getByText("movie.srt")).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: /burn in/i })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.getByRole("button", { name: /soft track/i })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", {name:/convert 1 file/i})).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("button", {name:/burn in/i}));
    expect(screen.getByRole("button", {name:/convert 1 file/i})).toHaveProperty("disabled", false);
  });

  it("keeps a subtitle through a detour via an incompatible target", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    mockFromFile.mockResolvedValue("job-id-1");
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));
    await waitFor(() =>
      expect(screen.getByText("test-video.mp4")).toBeDefined(),
    );

    mockOpen.mockResolvedValue("/tmp/movie.srt");
    await userEvent.click(
      screen.getByRole("button", { name: /^add file\.\.\.$/i }),
    );
    await waitFor(() => expect(screen.getByText("movie.srt")).toBeDefined());

    // Tap GIF by mistake, then back to MP4: re-picking the file would be
    // an annoying tax on a misclick.
    await userEvent.click(screen.getByRole("button", { name: "GIF" }));
    await userEvent.click(screen.getByRole("button", { name: "MP4" }));

    expect(screen.getByText("movie.srt")).toBeDefined();
    await userEvent.click(
      screen.getByRole("button", { name: /convert 1 file/i }),
    );
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
    await userEvent.click(screen.getByRole("button", { name: "Select b.mp4" }));
    await userEvent.click(
      screen.getByRole("button", { name: /^add file\.\.\.$/i }),
    );
    await waitFor(() => expect(screen.getByText("movie.srt")).toBeDefined());

    await userEvent.click(screen.getByRole("button", { name: "Select a.mp4" }));
    await userEvent.click(screen.getByRole("button", { name: "GIF" }));
    await userEvent.click(
      screen.getByRole("button", { name: /apply first to all/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /convert 2 files/i }),
    );

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
    await waitFor(() =>
      expect(screen.getByText("test-video.mp4")).toBeDefined(),
    );

    expect(screen.queryByRole("button", { name: "MP4" })).toBeNull();
    expect(screen.queryByRole("button", { name: "MP3" })).toBeNull();
    // A .srt source defaults to the other format, since srt->srt is a no-op.
    expect(screen.getByRole("button", { name: /WebVTT/ }).className).toContain(
      "bg-accent",
    );
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
    await waitFor(() =>
      expect(screen.getByText("test-video.mp4")).toBeDefined(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "YouTube Upload" }),
    );
  }

  it("hides ignored video controls for audio outputs and clears inherited settings explicitly", async () => {
    await stageFileAndApplyPreset();
    await userEvent.click(screen.getByRole("button", { name: "MP3" }));
    expect(
      screen.queryByRole("combobox", { name: "Video quality" }),
    ).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Video resolution" }),
    ).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("do not apply");
    await userEvent.click(
      screen.getByRole("button", { name: "Clear video settings" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /convert 1 file/i }),
    );
    await waitFor(() => expect(mockFromFile).toHaveBeenCalled());
    expect(mockFromFile.mock.calls[0][0]).toMatchObject({
      target: "mp3",
      quality_preset: null,
      resolution_cap: null,
    });
  });

  it("clears unsupported AVI quality without discarding its supported resolution cap", async () => {
    await stageFileAndApplyPreset();
    await userEvent.click(screen.getByRole("button", { name: "AVI" }));
    expect(
      screen.queryByRole("combobox", { name: "Video quality" }),
    ).toBeNull();
    expect(
      (
        screen.getByRole("combobox", {
          name: "Video resolution",
        }) as HTMLSelectElement
      ).value,
    ).toBe("r1080p");
    await userEvent.click(
      screen.getByRole("button", { name: "Clear video settings" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /convert 1 file/i }),
    );
    await waitFor(() => expect(mockFromFile).toHaveBeenCalled());
    expect(mockFromFile.mock.calls[0][0]).toMatchObject({
      target: "avi",
      quality_preset: null,
      resolution_cap: "r1080p",
    });
  });

  it("GIF presets expose editable GIF settings without duplicate video controls", async () => {
    useAppStore.setState({
      presets: [
        {
          ...useAppStore.getState().presets[0],
          target: "gif",
          quality_preset: null,
          resolution_cap: null,
        },
      ],
    });
    await stageFileAndApplyPreset();
    expect(screen.getByText("GIF size")).toBeTruthy();
    expect(
      screen.queryByRole("combobox", { name: "Video quality" }),
    ).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Video resolution" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Small (320px)" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /convert 1 file/i }),
    );
    await waitFor(() => expect(mockFromFile).toHaveBeenCalled());
    expect(mockFromFile.mock.calls[0][0].gif_options).toMatchObject({
      size_preset: "small",
      trim_start_ms: null,
      trim_end_ms: null,
    });
  });

  it("sends the preset's quality and resolution cap on a single file", async () => {
    // The chip used to change only `target`, so a 4K source came out 4K
    // while the button said 1080p.
    await stageFileAndApplyPreset();
    await userEvent.click(
      screen.getByRole("button", { name: /convert 1 file/i }),
    );
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
    await waitFor(() =>
      expect(screen.getByText("test-video.mp4")).toBeDefined(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /convert 1 file/i }),
    );
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
    await userEvent.click(
      screen.getByRole("button", { name: /save as preset/i }),
    );
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
    await userEvent.click(
      screen.getByRole("button", { name: "YouTube Upload" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /convert 2 files/i }),
    );
    await waitFor(() => expect(mockFromFile).toHaveBeenCalledTimes(2));
    for (const call of mockFromFile.mock.calls) {
      expect(call[0].quality_preset).toBe("balanced");
      expect(call[0].resolution_cap).toBe("r1080p");
    }
  });
});

it("uses one selected inspector while inspecting hidden sources and preserves edits on selection", async () => {
  vi.clearAllMocks();
  mockProbe.mockResolvedValue(mp4Probe);
  mockOpen.mockResolvedValue(["/first.mp4", "/second.mp4"]);
  render(
    <MemoryRouter>
      <ConvertPage />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add files" }));
  await waitFor(() => expect(mockProbe).toHaveBeenCalledTimes(2));
  expect(screen.getAllByRole("button", { name: "MP4" })).toHaveLength(1);
  await userEvent.click(
    screen.getByRole("button", { name: /Select second.mp4/i }),
  );
  await userEvent.click(screen.getByRole("button", { name: "MKV" }));
  await userEvent.click(
    screen.getByRole("button", { name: /Select first.mp4/i }),
  );
  expect(screen.getByRole("button", { name: "MP4" }).className).toContain(
    "bg-accent",
  );
  await userEvent.click(
    screen.getByRole("button", { name: /Select second.mp4/i }),
  );
  expect(screen.getByRole("button", { name: "MKV" }).className).toContain(
    "bg-accent",
  );
  expect(mockProbe).toHaveBeenCalledTimes(2);
});

describe("explicit video inspector", () => {
  beforeEach(() => { cleanup(); vi.clearAllMocks(); clearWorkspaceDrafts("convert"); useAppStore.setState({presets:[]}); mockOpen.mockResolvedValue(["/tmp/test-video.mp4"]); mockProbe.mockResolvedValue(mp4Probe); mockSave.mockResolvedValue("/tmp/out.mp4"); mockFromFile.mockResolvedValue("job"); });
  afterEach(cleanup);
  async function stage() { renderPage(); await userEvent.click(screen.getByRole("button",{name:"Add files"})); await screen.findByLabelText("Processing"); }
  it("retains raw rates and Custom through mode, codec and route changes; blocks invalid save/enqueue", async () => {
    await stage();
    await userEvent.selectOptions(screen.getByLabelText("Video quality"), "balanced");
    await userEvent.selectOptions(screen.getByLabelText("Processing"), "encode");
    expect(screen.queryByLabelText("Video quality")).toBeNull();
    expect(screen.getByLabelText("CRF")).toHaveProperty("value","23");
    await userEvent.clear(screen.getByLabelText("CRF"));
    expect(screen.getByRole("button",{name:"Convert 1 file"})).toHaveProperty("disabled",true);
    expect(screen.getByRole("button",{name:"Save as preset"})).toHaveProperty("disabled",true);
    expect(screen.getAllByText(/whole number from 1 to 51/).length).toBeGreaterThan(0);
    await userEvent.selectOptions(screen.getByLabelText("Rate control"), "average_bitrate");
    expect(screen.getByLabelText("Video bitrate (kbps)")).toHaveProperty("value","5000");
    await userEvent.selectOptions(screen.getByLabelText("Rate control"), "constant_quality");
    expect(screen.getByLabelText("CRF")).toHaveProperty("value","");
    await userEvent.type(screen.getByLabelText("CRF"),"31");
    await userEvent.selectOptions(screen.getByLabelText("Speed"),"slow");
    await userEvent.selectOptions(screen.getByLabelText("Codec"),"hevc");
    expect(screen.getByLabelText("CRF")).toHaveProperty("value","31");
    await userEvent.selectOptions(screen.getByLabelText("Processing"),"copy");
    expect(screen.queryByLabelText("CRF")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Processing"),"automatic");
    expect(screen.getByLabelText("Video quality")).toHaveProperty("value","balanced");
    cleanup(); renderPage(); await screen.findByLabelText("Processing");
    await userEvent.selectOptions(screen.getByLabelText("Processing"),"encode");
    expect(screen.getByLabelText("CRF")).toHaveProperty("value","31");
    expect(screen.getByLabelText("Codec")).toHaveProperty("value","hevc");
    expect(screen.getByLabelText("Speed")).toHaveProperty("value","slow");
    expect(screen.getByText(/Software/)).toBeTruthy();
  });
  it("preserves explicit intent on unsupported targets and offers a way back", async () => {
    await stage(); await userEvent.selectOptions(screen.getByLabelText("Processing"),"encode");
    await userEvent.click(screen.getByRole("button",{name:"MP3"}));
    expect(screen.getByLabelText("Processing")).toHaveProperty("value","encode");
    expect(screen.getByRole("button",{name:"Convert 1 file"})).toHaveProperty("disabled",true);
    await userEvent.click(screen.getByRole("button",{name:"MP4"}));
    expect(screen.getByLabelText("CRF")).toHaveProperty("value","23");
    expect(screen.getByRole("button",{name:"Convert 1 file"})).toHaveProperty("disabled",false);
  });
  it("validates every batch source before applying and clones compatible rows", async () => {
    mockOpen.mockResolvedValue(["/tmp/test-video.mp4","/tmp/unsupported.mp4"]);
    await stage(); await userEvent.selectOptions(screen.getByLabelText("Processing"),"encode");
    await userEvent.click(screen.getByRole("button",{name:"Apply first to all"}));
    expect(screen.getByText(/Settings were not applied/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button",{name:"Select unsupported.mp4"}));
    expect(screen.getByLabelText("Processing")).toHaveProperty("value","automatic");
  });
  it("keeps invalid active and inactive raw text through remount and validates both rate ranges", async () => {
    await stage(); await userEvent.selectOptions(screen.getByLabelText("Processing"),"encode");
    for (const value of ["", "0", "52", "2.5"]) {
      fireEvent.change(screen.getByLabelText("CRF"),{target:{value}});
      expect(screen.getByRole("button",{name:"Convert 1 file"})).toHaveProperty("disabled",true);
    }
    await userEvent.selectOptions(screen.getByLabelText("Rate control"),"average_bitrate");
    for (const value of ["", "99", "200001", "100.5"]) {
      fireEvent.change(screen.getByLabelText("Video bitrate (kbps)"),{target:{value}});
      expect(screen.getByRole("button",{name:"Save as preset"})).toHaveProperty("disabled",true);
    }
    cleanup(); renderPage(); await screen.findByLabelText("Video bitrate (kbps)");
    expect(screen.getByLabelText("Video bitrate (kbps)")).toHaveProperty("value","100.5");
    await userEvent.selectOptions(screen.getByLabelText("Rate control"),"constant_quality");
    expect(screen.getByLabelText("CRF")).toHaveProperty("value","2.5");
    fireEvent.change(screen.getByLabelText("CRF"),{target:{value:"51"}});
    expect(screen.getByRole("button",{name:"Convert 1 file"})).toHaveProperty("disabled",false);
  });
  it("names Copy resolution conflicts and repairs them without erasing Custom", async () => {
    await stage(); await userEvent.selectOptions(screen.getByLabelText("Processing"),"encode");
    fireEvent.change(screen.getByLabelText("CRF"),{target:{value:"31"}});
    await userEvent.selectOptions(screen.getByLabelText("Video resolution"),"r480p");
    expect(screen.getByRole("option",{name:"Copy streams"})).toHaveProperty("disabled",true);
    await userEvent.click(screen.getByRole("button",{name:"Use original resolution"}));
    await userEvent.selectOptions(screen.getByLabelText("Processing"),"copy");
    expect(screen.queryByLabelText("Video resolution")).toBeNull();
    expect(screen.queryByLabelText("Speed")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Processing"),"encode");
    expect(screen.getByLabelText("CRF")).toHaveProperty("value","31");
  });
  it("keeps Software and complete Custom choices across a global hardware preference change", async () => {
    await stage(); await userEvent.selectOptions(screen.getByLabelText("Processing"),"encode");
    await userEvent.selectOptions(screen.getByLabelText("Codec"),"hevc");
    await userEvent.selectOptions(screen.getByLabelText("Rate control"),"average_bitrate");
    fireEvent.change(screen.getByLabelText("Video bitrate (kbps)"),{target:{value:"6000"}});
    await userEvent.selectOptions(screen.getByLabelText("Speed"),"fast");
    act(()=>useAppStore.setState({settings:{...useAppStore.getState().settings,hw_acceleration_enabled:true} as Settings}));
    expect(screen.getByText(/Processor: Software/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button",{name:"Convert 1 file"}));
    await waitFor(()=>expect(mockFromFile).toHaveBeenCalled());
    expect(mockFromFile.mock.calls[0][0].video_options).toEqual({kind:"encode",codec:"hevc",rate_control:{kind:"average_bitrate",kbps:6000},speed:"fast",processor:"software"});
  });
  it("applies independent Custom settings to a compatible batch and retains later per-file edits", async () => {
    mockOpen.mockResolvedValue(["/tmp/a.mp4","/tmp/b.mp4"]);
    await stage(); await userEvent.selectOptions(screen.getByLabelText("Processing"),"encode");
    fireEvent.change(screen.getByLabelText("CRF"),{target:{value:"31"}});
    await userEvent.click(screen.getByRole("button",{name:"Apply first to all"}));
    fireEvent.change(screen.getByLabelText("CRF"),{target:{value:"19"}});
    await userEvent.click(screen.getByRole("button",{name:"Select b.mp4"}));
    expect(screen.getByLabelText("CRF")).toHaveProperty("value","31");
    await userEvent.click(screen.getByRole("button",{name:"Convert 2 files"}));
    await waitFor(()=>expect(mockFromFile).toHaveBeenCalledTimes(2));
    expect(mockFromFile.mock.calls[0][0].video_options.rate_control.crf).toBe(19);
    expect(mockFromFile.mock.calls[1][0].video_options.rate_control.crf).toBe(31);
    expect(mockFromFile.mock.calls[0][0].video_options.rate_control).not.toBe(mockFromFile.mock.calls[1][0].video_options.rate_control);
  });
  it("rejects an incompatible preset atomically and only clears raw drafts on successful replacement", async () => {
    mockOpen.mockResolvedValue(["/tmp/test-video.mp4","/tmp/unsupported.mp4"]);
    const preset = {id:"video",name:"Video preset",target:"mp4",video_options:{kind:"encode",codec:"hevc",rate_control:{kind:"constant_quality",crf:28},speed:"slow",processor:"software"},quality_preset:null,resolution_cap:null,compress_mode:null,is_builtin:false,created_at:0n} as Preset;
    useAppStore.setState({presets:[preset]});
    await stage(); await userEvent.selectOptions(screen.getByLabelText("Processing"),"encode");
    fireEvent.change(screen.getByLabelText("CRF"),{target:{value:""}});
    await userEvent.click(screen.getByRole("button",{name:"Video preset"}));
    expect(screen.getByText(/Settings were not applied/)).toBeTruthy();
    expect(screen.getByLabelText("CRF")).toHaveProperty("value","");
    await userEvent.click(screen.getByRole("button",{name:"Select unsupported.mp4"}));
    expect(screen.getByLabelText("Processing")).toHaveProperty("value","automatic");
    await userEvent.click(screen.getByRole("button",{name:"Select test-video.mp4"}));
    useAppStore.setState({presets:[{...preset,video_options:{kind:"copy"}}]});
    await userEvent.click(screen.getByRole("button",{name:"Video preset"}));
    expect(screen.getByLabelText("Processing")).toHaveProperty("value","copy");
    await userEvent.selectOptions(screen.getByLabelText("Processing"),"encode");
    expect(screen.getByLabelText("CRF")).toHaveProperty("value","23");
  });
  it("saves the complete supported Custom preset with dormant Automatic quality projected out", async () => {
    const savePreset = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({savePreset});
    await stage(); await userEvent.selectOptions(screen.getByLabelText("Video quality"),"small");
    await userEvent.selectOptions(screen.getByLabelText("Processing"),"encode");
    await userEvent.selectOptions(screen.getByLabelText("Codec"),"hevc");
    await userEvent.selectOptions(screen.getByLabelText("Rate control"),"average_bitrate");
    fireEvent.change(screen.getByLabelText("Video bitrate (kbps)"),{target:{value:"6500"}});
    await userEvent.selectOptions(screen.getByLabelText("Speed"),"slow");
    await userEvent.click(screen.getByRole("button",{name:"Save as preset"}));
    await userEvent.type(screen.getByPlaceholderText(/e.g./),"My video");
    await userEvent.click(screen.getByRole("button",{name:"Save"}));
    await waitFor(()=>expect(savePreset).toHaveBeenCalled());
    expect(savePreset.mock.calls[0][0]).toMatchObject({quality_preset:null,video_options:{kind:"encode",codec:"hevc",rate_control:{kind:"average_bitrate",kbps:6500},speed:"slow",processor:"software"}});
    await userEvent.selectOptions(screen.getByLabelText("Processing"),"automatic");
    expect(screen.getByLabelText("Video quality")).toHaveProperty("value","small");
  });
  it("shows the fresh engine audio and geometry summary without creating a job", async () => {
    await stage(); await userEvent.selectOptions(screen.getByLabelText("Processing"),"encode");
    await waitFor(()=>expect(screen.getByRole("region",{name:"Video processing summary"}).textContent).toContain("Audio copied (aac)"));
    expect(screen.getByRole("region",{name:"Video processing summary"}).textContent).toContain("1920 × 1080");
    expect(screen.getByRole("region",{name:"Video processing summary"}).textContent).toContain("Color tags are unspecified");
    expect(mockFromFile).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button",{name:"Preview sample"})).toHaveProperty("disabled",true);
  });
  it("captures the entire explicit request before a deferred Save and preserves later edits", async () => {
    let resolve!: (path:string)=>void; mockSave.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    await stage(); await userEvent.selectOptions(screen.getByLabelText("Processing"),"encode");
    await userEvent.click(screen.getByRole("button",{name:"Convert 1 file"}));
    await waitFor(()=>expect(mockSave).toHaveBeenCalled());
    await userEvent.clear(screen.getByLabelText("CRF")); await userEvent.type(screen.getByLabelText("CRF"),"31");
    resolve("/tmp/out.mp4"); await waitFor(()=>expect(mockFromFile).toHaveBeenCalled());
    expect(mockFromFile.mock.calls[0][0]).toMatchObject({quality_preset:null,video_options:{kind:"encode",codec:"h264",rate_control:{kind:"constant_quality",crf:23},speed:"medium",processor:"software"}});
    expect(screen.getByLabelText("CRF")).toHaveProperty("value","31");
  });
});
