import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import ConvertPage from "@/pages/ConvertPage";
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
    expect(screen.getByText(/drop files here/i)).toBeDefined();
    expect(screen.getByText(/pick from your computer/i)).toBeDefined();
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

  it("shows compression presets for video targets", async () => {
    mockProbe.mockResolvedValue(mp4Probe);
    renderPage();

    await userEvent.click(screen.getByText(/pick from your computer/i));

    await waitFor(() => {
      expect(screen.getByText("test-video.mp4")).toBeDefined();
    });

    // Quality preset buttons should be visible
    expect(screen.getByRole("button", { name: "Fast" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Balanced" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Small" })).toBeDefined();
    // Resolution cap should be visible (1080p, 720p, 480p)
    expect(screen.getByRole("button", { name: "1080p" })).toBeDefined();
    expect(screen.getByRole("button", { name: "720p" })).toBeDefined();
  });
});
