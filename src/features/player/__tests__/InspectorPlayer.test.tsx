import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import InspectorPlayer from "@/features/player/InspectorPlayer";
import { UNAVAILABLE_MESSAGES } from "@/features/player/previewPlan";
import type { HomeDirState } from "@/hooks/useHomeDir";
import type { ProbeState } from "@/hooks/useProbe";
import { useAppStore } from "@/store/appStore";
import type { ProbeResult, Settings } from "@/types";

const home = vi.hoisted(() => ({ state: { status: "ready", dir: "/Users/a" } as HomeDirState }));
vi.mock("@/hooks/useHomeDir", () => ({ useHomeDir: () => home.state }));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => "asset://localhost/" + encodeURIComponent(path),
}));

// The real player, except that a source whose name contains "boom" makes it throw while rendering.
vi.mock("@/features/player/SourcePlayer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/player/SourcePlayer")>();
  const { createElement } = await import("react");
  return {
    default: (props: import("@/features/player/SourcePlayer").SourcePlayerProps) => {
      if (props.path.includes("boom")) throw new Error("player exploded");
      return createElement(actual.default, props);
    },
  };
});

const probe = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  duration_ms: BigInt(60_000),
  width: null,
  height: null,
  video_codec: null,
  audio_codec: null,
  file_size: BigInt(1_048_576),
  container: null,
  has_video: false,
  has_audio: false,
  source_kind: "video",
  color_space: null,
  image_format: null,
  has_subtitles: false,
  subtitle_codecs: [],
  audio_codecs: [],
  ...overrides,
});

const ready = (p: ProbeResult): ProbeState => ({
  phase: "ready",
  probe: p,
  capabilities: {
    targets: [],
    compression: { quality: false, target_size: false, lossless: false, reason: null },
  },
});

const videoState = ready(probe({ has_video: true, has_audio: true, video_codec: "h264", audio_codec: "aac" }));
const pdfState = ready(probe({ source_kind: "pdf" }));
const PATH = "/Users/a/clip.mp4";
const srcOf = (path: string) => "asset://localhost/" + encodeURIComponent(path);

/** jsdom has no media pipeline, so report a playback position and state by hand. */
const setPlayback = (media: HTMLMediaElement, currentTime: number, paused: boolean) => {
  Object.defineProperty(media, "currentTime", { configurable: true, writable: true, value: currentTime });
  Object.defineProperty(media, "paused", { configurable: true, value: paused });
};

const setEnabled = (media_player_enabled: boolean) =>
  act(() => useAppStore.setState({ settings: { media_player_enabled } as Settings }));

// jsdom has no media pipeline: report every codec as playable and make play/pause inert.
// Created per test and restored after it, so no stub leaks into other suites' elements.
let mediaSpies: {
  canPlayType: MockInstance<HTMLMediaElement["canPlayType"]>;
  play: MockInstance<HTMLMediaElement["play"]>;
  pause: MockInstance<HTMLMediaElement["pause"]>;
};

beforeEach(() => {
  home.state = { status: "ready", dir: "/Users/a" };
  mediaSpies = {
    canPlayType: vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably"),
    play: vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined),
    pause: vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}),
  };
  useAppStore.setState((s) => ({ settings: { media_player_enabled: true } as Settings, ui: { ...s.ui, playerCollapsed: false } }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.setState({ settings: null });
});

describe("InspectorPlayer gating", () => {
  it("renders nothing while the setting is off", () => {
    setEnabled(false);
    const { container } = render(<InspectorPlayer path={PATH} state={videoState} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing before settings have loaded", () => {
    act(() => useAppStore.setState({ settings: null }));
    const { container } = render(<InspectorPlayer path={PATH} state={videoState} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when no source is selected", () => {
    const { container } = render(<InspectorPlayer path={null} state={videoState} />);
    expect(container.innerHTML).toBe("");
  });

  it("starts and stops following the setting", () => {
    setEnabled(false);
    const { container } = render(<InspectorPlayer path={PATH} state={videoState} />);
    expect(container.querySelector("video")).toBeNull();
    setEnabled(true);
    expect(container.querySelector("video")).not.toBeNull();
    setEnabled(false);
    expect(container.innerHTML).toBe("");
  });

  it("renders a video for a ready mp4", () => {
    const { container } = render(<InspectorPlayer path={PATH} state={videoState} />);
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toBe(srcOf(PATH));
    expect(video?.getAttribute("preload")).toBe("metadata");
  });

  it("renders nothing visible for a source with nothing to show", () => {
    const { container } = render(<InspectorPlayer path="/Users/a/doc.pdf" state={pdfState} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("InspectorPlayer home folder", () => {
  it("waits while the home folder is being looked up", () => {
    home.state = { status: "loading" };
    const { container } = render(<InspectorPlayer path={PATH} state={videoState} />);
    expect(container.querySelector("[aria-busy=true]")).not.toBeNull();
    expect(container.querySelector("video")).toBeNull();
  });

  it("plans without a home check when the lookup failed", () => {
    home.state = { status: "failed" };
    const { container } = render(<InspectorPlayer path="/Volumes/x/clip.mp4" state={videoState} />);
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("explains a file outside the home folder once the home is known", () => {
    render(<InspectorPlayer path="/Volumes/x/clip.mp4" state={videoState} />);
    expect(screen.getByRole("status").textContent).toBe(UNAVAILABLE_MESSAGES["outside-home"]);
  });
});

// jsdom prints a render error as "Uncaught" before React hands it to the boundary; claim the expected one.
const claimExpectedError = (event: ErrorEvent) => {
  if (event.error?.message === "player exploded") event.preventDefault();
};

describe("InspectorPlayer isolation", () => {
  beforeEach(() => {
    // React and the boundary both report the caught error; the output is expected here.
    vi.spyOn(console, "error").mockImplementation(() => {});
    window.addEventListener("error", claimExpectedError);
  });

  afterEach(() => {
    window.removeEventListener("error", claimExpectedError);
  });

  it("shows a quiet fallback and leaves its sibling untouched when the player throws", () => {
    const view = render(
      <>
        <InspectorPlayer path="/Users/a/boom.mp4" state={videoState} />
        <button type="button">Convert</button>
      </>,
    );
    expect(screen.getByText("Preview unavailable.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Convert" })).toHaveProperty("disabled", false);
    expect(view.container.querySelector("video")).toBeNull();
  });

  it("does not hand a position from the last source to the next one after a failure in between", () => {
    const view = render(<InspectorPlayer path={PATH} state={videoState} />);
    setPlayback(view.container.querySelector("video") as HTMLVideoElement, 0, true);
    fireEvent.click(screen.getByRole("button", { name: "Enlarge preview" }));
    setPlayback(screen.getByRole("dialog").querySelector("video") as HTMLVideoElement, 42, false);
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));

    view.rerender(<InspectorPlayer path="/Users/a/boom.mp4" state={videoState} />);
    expect(screen.getByText("Preview unavailable.")).toBeTruthy();
    mediaSpies.play.mockClear();
    view.rerender(<InspectorPlayer path="/Users/a/next.mp4" state={videoState} />);

    const next = view.container.querySelector("video") as HTMLVideoElement;
    expect(next.getAttribute("src")).toBe(srcOf("/Users/a/next.mp4"));
    expect(next.currentTime).toBe(0);
    expect(mediaSpies.play).not.toHaveBeenCalled();
  });

  it("tries again after a rerender with a new path", () => {
    const view = render(
      <>
        <InspectorPlayer path="/Users/a/boom.mp4" state={videoState} />
        <button type="button">Convert</button>
      </>,
    );
    expect(screen.getByText("Preview unavailable.")).toBeTruthy();
    view.rerender(
      <>
        <InspectorPlayer path={PATH} state={videoState} />
        <button type="button">Convert</button>
      </>,
    );
    expect(screen.queryByText("Preview unavailable.")).toBeNull();
    expect(view.container.querySelector("video")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Convert" })).toBeTruthy();
  });
});

describe("InspectorPlayer collapse", () => {
  it("collapses through the store, so the choice outlives the selection", () => {
    const { container, rerender } = render(<InspectorPlayer path={PATH} state={videoState} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    expect(useAppStore.getState().ui.playerCollapsed).toBe(true);
    expect(container.querySelector("video")).toBeNull();

    rerender(<InspectorPlayer path="/Users/a/other.mp4" state={videoState} />);
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByRole("button", { name: "Show preview" })).toBeTruthy();
  });

  it("starts collapsed when the store says so", () => {
    act(() => useAppStore.setState((s) => ({ ui: { ...s.ui, playerCollapsed: true } })));
    const { container } = render(<InspectorPlayer path={PATH} state={videoState} />);
    expect(container.querySelector("video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show preview" }));
    expect(useAppStore.getState().ui.playerCollapsed).toBe(false);
    expect(container.querySelector("video")).not.toBeNull();
  });
});

describe("InspectorPlayer enlarge", () => {
  const enlarge = () => fireEvent.click(screen.getByRole("button", { name: "Enlarge preview" }));
  const panelVideo = (container: HTMLElement) => container.querySelector("video") as HTMLVideoElement;

  it("opens the lightbox named after the file and hands the panel position over", () => {
    const { container } = render(<InspectorPlayer path={PATH} state={videoState} />);
    setPlayback(panelVideo(container), 7, false);
    enlarge();
    expect(screen.getByRole("dialog", { name: "Preview of clip.mp4" })).toBeTruthy();
    expect(mediaSpies.pause).toHaveBeenCalled();
    // The lightbox seeks to the handed-over position once its metadata is in.
    const lightboxVideo = screen.getByRole("dialog").querySelector("video") as HTMLVideoElement;
    expect(lightboxVideo.getAttribute("src")).toBe(srcOf(PATH));
    setPlayback(lightboxVideo, 0, true);
    fireEvent.loadedMetadata(lightboxVideo);
    expect(lightboxVideo.currentTime).toBe(7);
    expect(mediaSpies.play).toHaveBeenCalled();
  });

  it("closes the lightbox and puts the panel player back where the lightbox left off", () => {
    const { container } = render(<InspectorPlayer path={PATH} state={videoState} />);
    const panel = panelVideo(container);
    setPlayback(panel, 0, true);
    enlarge();
    setPlayback(screen.getByRole("dialog").querySelector("video") as HTMLVideoElement, 42, false);
    mediaSpies.play.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panelVideo(container)).toBe(panel);
    expect(panel.currentTime).toBe(42);
    expect(mediaSpies.play).toHaveBeenCalledTimes(1);
  });

  it("does not play on return when the lightbox was paused", () => {
    const { container } = render(<InspectorPlayer path={PATH} state={videoState} />);
    const panel = panelVideo(container);
    setPlayback(panel, 0, true);
    enlarge();
    setPlayback(screen.getByRole("dialog").querySelector("video") as HTMLVideoElement, 15, true);
    mediaSpies.play.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));

    expect(panel.currentTime).toBe(15);
    expect(mediaSpies.play).not.toHaveBeenCalled();
  });

  it("never carries a position over to a different source", () => {
    const { container, rerender } = render(<InspectorPlayer path={PATH} state={videoState} />);
    setPlayback(panelVideo(container), 0, true);
    enlarge();
    setPlayback(screen.getByRole("dialog").querySelector("video") as HTMLVideoElement, 42, false);
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    mediaSpies.play.mockClear();

    rerender(<InspectorPlayer path="/Users/a/other.mp4" state={videoState} />);

    const next = panelVideo(container);
    expect(next.getAttribute("src")).toBe(srcOf("/Users/a/other.mp4"));
    expect(next.currentTime).toBe(0);
    expect(mediaSpies.play).not.toHaveBeenCalled();
  });

  it("drops an open lightbox when the selection moves to another source", () => {
    const { container, rerender } = render(<InspectorPlayer path={PATH} state={videoState} />);
    setPlayback(panelVideo(container), 0, true);
    enlarge();
    expect(screen.getByRole("dialog")).toBeTruthy();

    rerender(<InspectorPlayer path="/Users/a/other.mp4" state={videoState} />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
