import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SourcePlayer, { type SourcePlayerProps } from "@/features/player/SourcePlayer";
import { UNAVAILABLE_MESSAGES } from "@/features/player/previewPlan";
import type { ProbeState } from "@/hooks/useProbe";
import type { ProbeResult } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => "asset://localhost/" + encodeURIComponent(path),
}));

const HOME = "/Users/a";
const srcOf = (path: string) => "asset://localhost/" + encodeURIComponent(path);

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

const videoProbe = ready(probe({ has_video: true, has_audio: true, video_codec: "h264", audio_codec: "aac" }));
const audioProbe = ready(probe({ source_kind: "audio", has_audio: true, audio_codec: "mp3" }));
const imageProbe = ready(probe({ source_kind: "image", width: 1920, height: 1080 }));
const pdfProbe = ready(probe({ source_kind: "pdf" }));

const VIDEO_PATH = "/Users/a/my clip #1 %é.mov";
const AUDIO_PATH = "/Users/a/song.mp3";
const IMAGE_PATH = "/Users/a/p.heic";

const baseProps = (overrides: Partial<SourcePlayerProps> = {}): SourcePlayerProps => ({
  path: VIDEO_PATH,
  state: videoProbe,
  homeDir: HOME,
  homeReady: true,
  collapsed: false,
  onToggleCollapsed: vi.fn(),
  onEnlarge: vi.fn(),
  ...overrides,
});

const mediaSpies = {
  canPlayType: vi.spyOn(HTMLMediaElement.prototype, "canPlayType"),
  play: vi.spyOn(HTMLMediaElement.prototype, "play"),
  pause: vi.spyOn(HTMLMediaElement.prototype, "pause"),
  load: vi.spyOn(HTMLMediaElement.prototype, "load"),
};

/** Whether each element still had a src attribute when load() was called on it. */
let srcAtLoad: Map<HTMLMediaElement, boolean>;

beforeEach(() => {
  srcAtLoad = new Map();
  mediaSpies.canPlayType.mockReturnValue("probably");
  mediaSpies.play.mockResolvedValue(undefined);
  mediaSpies.pause.mockImplementation(() => {});
  mediaSpies.load.mockImplementation(function (this: HTMLMediaElement) {
    srcAtLoad.set(this, this.hasAttribute("src"));
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mediaElement = (container: HTMLElement, selector: "video" | "audio") =>
  container.querySelector(selector) as HTMLMediaElement;

describe("SourcePlayer media", () => {
  it("renders a video with native controls, metadata preload and the asset src", () => {
    const { container } = render(<SourcePlayer {...baseProps()} />);
    const video = mediaElement(container, "video");
    expect(video).toBeTruthy();
    expect(video.controls).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.src).toBe(srcOf(VIDEO_PATH));
  });

  it("renders an audio element with native controls and metadata preload", () => {
    const { container } = render(<SourcePlayer {...baseProps({ path: AUDIO_PATH, state: audioProbe })} />);
    expect(container.querySelector("audio[controls][preload=metadata]")).toBeTruthy();
    expect(container.querySelector("video")).toBeNull();
  });

  it("names the video after the file for assistive tech", () => {
    const { container } = render(<SourcePlayer {...baseProps()} />);
    expect(screen.getByLabelText("Preview of my clip #1 %é.mov")).toBe(mediaElement(container, "video"));
  });

  it("names the audio after the file for assistive tech", () => {
    const { container } = render(<SourcePlayer {...baseProps({ path: "C:\\Users\\a\\Music\\song.mp3", state: audioProbe, homeDir: "C:\\Users\\a" })} />);
    expect(mediaElement(container, "audio").getAttribute("aria-label")).toBe("Preview of song.mp3");
  });

  it("renders an image with a file-name alt", () => {
    render(<SourcePlayer {...baseProps({ path: IMAGE_PATH, state: imageProbe })} />);
    const img = screen.getByRole("img", { name: "Preview of p.heic" });
    expect(img.getAttribute("src")).toBe(srcOf(IMAGE_PATH));
    expect(img.getAttribute("decoding")).toBe("async");
  });

  it("marks out its bar and media body, which index.css lets shrink in a short panel", () => {
    const { container } = render(<SourcePlayer {...baseProps()} />);
    const root = container.firstElementChild;
    const bar = screen.getByRole("button", { name: "Hide preview" }).closest(".source-player-bar");
    const body = mediaElement(container, "video").parentElement;

    expect(root?.classList.contains("source-player")).toBe(true);
    expect(bar?.parentElement).toBe(root);
    expect(bar?.contains(screen.getByRole("button", { name: "Enlarge preview" }))).toBe(true);
    expect(body?.classList.contains("source-player-body")).toBe(true);
    expect(body?.parentElement).toBe(root);
  });

  it("takes the alt text from the last segment of a Windows path", () => {
    render(<SourcePlayer {...baseProps({ path: "C:\\Users\\a\\Pictures\\p.heic", state: imageProbe, homeDir: "C:\\Users\\a" })} />);
    expect(screen.getByRole("img", { name: "Preview of p.heic" })).toBeTruthy();
  });
});

describe("SourcePlayer unavailable states", () => {
  it("shows the format message when the webview refuses the codec", () => {
    mediaSpies.canPlayType.mockReturnValue("");
    const { container } = render(<SourcePlayer {...baseProps()} />);
    expect(screen.getByRole("status").textContent).toBe(UNAVAILABLE_MESSAGES.format);
    expect(container.querySelector("video")).toBeNull();
  });

  it("asks the webview about the exact planned MIME type", () => {
    render(<SourcePlayer {...baseProps()} />);
    expect(mediaSpies.canPlayType).toHaveBeenCalledWith('video/quicktime; codecs="avc1, mp4a.40.2"');
  });

  it("shows the playback message, without throwing, when the media element errors", () => {
    const { container } = render(<SourcePlayer {...baseProps()} />);
    expect(() => fireEvent.error(mediaElement(container, "video"))).not.toThrow();
    expect(screen.getByRole("status").textContent).toBe(UNAVAILABLE_MESSAGES.playback);
    expect(container.querySelector("video")).toBeNull();
  });

  it("shows the playback message when an image fails to load", () => {
    render(<SourcePlayer {...baseProps({ path: IMAGE_PATH, state: imageProbe })} />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByRole("status").textContent).toBe(UNAVAILABLE_MESSAGES.playback);
  });

  it("shows the outside-home message for a file outside the home folder", () => {
    render(<SourcePlayer {...baseProps({ path: "/Volumes/x/clip.mov" })} />);
    expect(screen.getByRole("status").textContent).toBe(UNAVAILABLE_MESSAGES["outside-home"]);
  });

  it("clears a playback error when the path changes", () => {
    const view = render(<SourcePlayer {...baseProps()} />);
    fireEvent.error(mediaElement(view.container, "video"));
    expect(screen.getByRole("status").textContent).toBe(UNAVAILABLE_MESSAGES.playback);

    const next = "/Users/a/next.mov";
    view.rerender(<SourcePlayer {...baseProps({ path: next })} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(mediaElement(view.container, "video").src).toBe(srcOf(next));

    // Coming back to the file that failed gets a fresh attempt too.
    view.rerender(<SourcePlayer {...baseProps()} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(mediaElement(view.container, "video").src).toBe(srcOf(VIDEO_PATH));
  });
});

describe("SourcePlayer probe states", () => {
  it("shows a busy loading line while probing", () => {
    const { container } = render(<SourcePlayer {...baseProps({ state: { phase: "probing" } })} />);
    expect(screen.getByText("Loading preview…")).toBeTruthy();
    expect(container.querySelector("[aria-busy=true]")).toBeTruthy();
    expect(container.querySelector("video")).toBeNull();
  });

  it("shows the loading line while the home folder is still resolving", () => {
    render(<SourcePlayer {...baseProps({ homeReady: false, homeDir: null })} />);
    expect(screen.getByText("Loading preview…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enlarge preview" })).toBeNull();
  });

  it("shows the probe-failed message when inspection failed", () => {
    render(<SourcePlayer {...baseProps({ state: { phase: "error", message: "x" } })} />);
    expect(screen.getByText(UNAVAILABLE_MESSAGES["probe-failed"])).toBeTruthy();
  });

  it("renders nothing for a source with no preview", () => {
    const { container } = render(<SourcePlayer {...baseProps({ path: "/Users/a/doc.pdf", state: pdfProbe })} />);
    expect(container.firstChild).toBeNull();
  });
});

/** Paused, emptied of its src, then reloaded so the webview drops the decoder and buffer now. */
const expectReleased = (element: HTMLMediaElement) => {
  expect(mediaSpies.pause.mock.contexts).toContain(element);
  expect(mediaSpies.load.mock.contexts).toContain(element);
  expect(srcAtLoad.get(element)).toBe(false);
  expect(element.hasAttribute("src")).toBe(false);
};

describe("SourcePlayer remount", () => {
  it("renders a fresh element for a new source and lets go of the old one", () => {
    const view = render(<SourcePlayer {...baseProps()} />);
    const first = mediaElement(view.container, "video");

    view.rerender(<SourcePlayer {...baseProps({ path: "/Users/a/other.mov" })} />);
    const second = mediaElement(view.container, "video");

    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expectReleased(first);
    expect(second.getAttribute("src")).toBe(srcOf("/Users/a/other.mov"));
    expect(mediaSpies.load.mock.contexts).not.toContain(second);
  });

  it("lets go of an audio element replaced by a video", () => {
    const view = render(<SourcePlayer {...baseProps({ path: AUDIO_PATH, state: audioProbe })} />);
    const audio = mediaElement(view.container, "audio");

    view.rerender(<SourcePlayer {...baseProps()} />);

    expectReleased(audio);
    expect(mediaSpies.load.mock.contexts).not.toContain(mediaElement(view.container, "video"));
  });

  it("lets go of an element that failed to play", () => {
    const { container } = render(<SourcePlayer {...baseProps()} />);
    const video = mediaElement(container, "video");

    fireEvent.error(video);

    expect(container.querySelector("video")).toBeNull();
    expectReleased(video);
  });

  it("lets go of the element when the player goes away", () => {
    const view = render(<SourcePlayer {...baseProps()} />);
    const video = mediaElement(view.container, "video");

    view.unmount();

    expectReleased(video);
  });

  it("leaves the element alone while it stays", () => {
    const view = render(<SourcePlayer {...baseProps()} />);
    view.rerender(<SourcePlayer {...baseProps({ resume: { startAt: 3, playing: false } })} />);

    expect(mediaSpies.load).not.toHaveBeenCalled();
    expect(mediaElement(view.container, "video").getAttribute("src")).toBe(srcOf(VIDEO_PATH));
  });
});

describe("SourcePlayer collapse", () => {
  it("hides the media when collapsed and offers to show it again", () => {
    const onToggleCollapsed = vi.fn();
    const { container } = render(<SourcePlayer {...baseProps({ collapsed: true, onToggleCollapsed })} />);
    expect(container.querySelector("video, audio, img")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Show preview" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("offers to hide the media when expanded", () => {
    render(<SourcePlayer {...baseProps()} />);
    const toggle = screen.getByRole("button", { name: "Hide preview" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("lets go of the element when the preview collapses", () => {
    const view = render(<SourcePlayer {...baseProps()} />);
    const video = mediaElement(view.container, "video");

    view.rerender(<SourcePlayer {...baseProps({ collapsed: true })} />);

    expect(view.container.querySelector("video")).toBeNull();
    expectReleased(video);
  });

  it("hides an unavailable message while collapsed", () => {
    mediaSpies.canPlayType.mockReturnValue("");
    render(<SourcePlayer {...baseProps({ collapsed: true })} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("SourcePlayer enlarge", () => {
  it("pauses the element and hands over its position and play state", () => {
    const onEnlarge = vi.fn();
    const { container } = render(<SourcePlayer {...baseProps({ onEnlarge })} />);
    const video = mediaElement(container, "video");
    Object.defineProperty(video, "currentTime", { value: 12, configurable: true });
    Object.defineProperty(video, "paused", { value: false, configurable: true });

    fireEvent.click(screen.getByRole("button", { name: "Enlarge preview" }));

    expect(mediaSpies.pause).toHaveBeenCalledTimes(1);
    expect(onEnlarge).toHaveBeenCalledTimes(1);
    expect(onEnlarge).toHaveBeenCalledWith({
      plan: { kind: "video", mime: 'video/quicktime; codecs="avc1, mp4a.40.2"' },
      src: srcOf(VIDEO_PATH),
      startAt: 12,
      playing: true,
    });
    expect(mediaSpies.pause.mock.invocationCallOrder[0]).toBeLessThan(onEnlarge.mock.invocationCallOrder[0]);
  });

  it("reports a paused element as not playing", () => {
    const onEnlarge = vi.fn();
    const { container } = render(<SourcePlayer {...baseProps({ path: AUDIO_PATH, state: audioProbe, onEnlarge })} />);
    const audio = mediaElement(container, "audio");
    Object.defineProperty(audio, "currentTime", { value: 3.5, configurable: true });
    Object.defineProperty(audio, "paused", { value: true, configurable: true });

    fireEvent.click(screen.getByRole("button", { name: "Enlarge preview" }));

    expect(onEnlarge).toHaveBeenCalledWith({
      plan: { kind: "audio", mime: "audio/mpeg" },
      src: srcOf(AUDIO_PATH),
      startAt: 3.5,
      playing: false,
    });
  });

  it("enlarges a photo from the start, since it has no playback position", () => {
    const onEnlarge = vi.fn();
    render(<SourcePlayer {...baseProps({ path: IMAGE_PATH, state: imageProbe, onEnlarge })} />);

    fireEvent.click(screen.getByRole("button", { name: "Enlarge preview" }));

    expect(onEnlarge).toHaveBeenCalledWith({
      plan: { kind: "image" },
      src: srcOf(IMAGE_PATH),
      startAt: 0,
      playing: false,
    });
    expect(mediaSpies.pause).not.toHaveBeenCalled();
  });

  it("is disabled while collapsed", () => {
    render(<SourcePlayer {...baseProps({ collapsed: true })} />);
    expect(screen.getByRole("button", { name: "Enlarge preview" }).hasAttribute("disabled")).toBe(true);
  });

  it("is disabled when there is nothing playable to show", () => {
    mediaSpies.canPlayType.mockReturnValue("");
    render(<SourcePlayer {...baseProps()} />);
    expect(screen.getByRole("button", { name: "Enlarge preview" }).hasAttribute("disabled")).toBe(true);
  });

  it("is disabled after a playback error", () => {
    const { container } = render(<SourcePlayer {...baseProps()} />);
    fireEvent.error(mediaElement(container, "video"));
    expect(screen.getByRole("button", { name: "Enlarge preview" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("SourcePlayer resume", () => {
  const withTimeSetter = (element: HTMLMediaElement) => {
    const setTime = vi.fn();
    Object.defineProperty(element, "currentTime", { set: setTime, get: () => 0, configurable: true });
    return setTime;
  };

  it("restores the position and keeps playing when the parent hands back a resume", () => {
    const view = render(<SourcePlayer {...baseProps()} />);
    const setTime = withTimeSetter(mediaElement(view.container, "video"));

    view.rerender(<SourcePlayer {...baseProps({ resume: { startAt: 42, playing: true } })} />);

    expect(setTime).toHaveBeenCalledWith(42);
    expect(mediaSpies.play).toHaveBeenCalledTimes(1);
  });

  it("restores the position without playing when it was paused", () => {
    const view = render(<SourcePlayer {...baseProps()} />);
    const setTime = withTimeSetter(mediaElement(view.container, "video"));

    view.rerender(<SourcePlayer {...baseProps({ resume: { startAt: 7, playing: false } })} />);

    expect(setTime).toHaveBeenCalledWith(7);
    expect(mediaSpies.play).not.toHaveBeenCalled();
  });

  it("applies a resume once per object, not once per render", () => {
    const view = render(<SourcePlayer {...baseProps()} />);
    const resume = { startAt: 5, playing: true };

    view.rerender(<SourcePlayer {...baseProps({ resume })} />);
    view.rerender(<SourcePlayer {...baseProps({ resume })} />);
    expect(mediaSpies.play).toHaveBeenCalledTimes(1);

    view.rerender(<SourcePlayer {...baseProps({ resume: { startAt: 5, playing: true } })} />);
    expect(mediaSpies.play).toHaveBeenCalledTimes(2);
  });

  it("swallows a rejected play() promise", async () => {
    mediaSpies.play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    const view = render(<SourcePlayer {...baseProps()} />);

    view.rerender(<SourcePlayer {...baseProps({ resume: { startAt: 1, playing: true } })} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mediaSpies.play).toHaveBeenCalledTimes(1);
  });

  it("tolerates a play() that returns nothing", () => {
    mediaSpies.play.mockReturnValueOnce(undefined as unknown as Promise<void>);
    const view = render(<SourcePlayer {...baseProps()} />);

    expect(() =>
      view.rerender(<SourcePlayer {...baseProps({ resume: { startAt: 1, playing: true } })} />),
    ).not.toThrow();
    expect(mediaSpies.play).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there is no media element to resume", () => {
    const view = render(<SourcePlayer {...baseProps({ collapsed: true })} />);

    expect(() =>
      view.rerender(<SourcePlayer {...baseProps({ collapsed: true, resume: { startAt: 9, playing: true } })} />),
    ).not.toThrow();
    expect(mediaSpies.play).not.toHaveBeenCalled();
  });

  it("does nothing for a photo", () => {
    const view = render(<SourcePlayer {...baseProps({ path: IMAGE_PATH, state: imageProbe })} />);

    expect(() =>
      view.rerender(
        <SourcePlayer {...baseProps({ path: IMAGE_PATH, state: imageProbe, resume: { startAt: 9, playing: true } })} />,
      ),
    ).not.toThrow();
    expect(mediaSpies.play).not.toHaveBeenCalled();
  });
});
