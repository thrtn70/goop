import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlayerLightbox, { type PlayerLightboxProps } from "@/features/player/PlayerLightbox";

const SRC = "asset://localhost/%2FUsers%2Fa%2Fmy%20clip%20%231.mov";

const baseProps = (overrides: Partial<PlayerLightboxProps> = {}): PlayerLightboxProps => ({
  plan: { kind: "video", mime: "video/quicktime" },
  src: SRC,
  name: "my clip #1.mov",
  startAt: 0,
  playing: false,
  onClose: vi.fn(),
  ...overrides,
});

const mediaSpies = {
  play: vi.spyOn(HTMLMediaElement.prototype, "play"),
  pause: vi.spyOn(HTMLMediaElement.prototype, "pause"),
  load: vi.spyOn(HTMLMediaElement.prototype, "load"),
};

/** Whether each element still had a src attribute when load() was called on it. */
let srcAtLoad: Map<HTMLMediaElement, boolean>;

beforeEach(() => {
  srcAtLoad = new Map();
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

const videoOf = () => document.querySelector("video") as HTMLVideoElement;
const closeButton = () => screen.getByRole("button", { name: "Close preview" });
const dialog = () => screen.getByRole("dialog");

/** jsdom has no media pipeline, so report a playback position and state by hand. */
const setPlayback = (media: HTMLMediaElement, currentTime: number, paused: boolean) => {
  Object.defineProperty(media, "currentTime", { configurable: true, writable: true, value: currentTime });
  Object.defineProperty(media, "paused", { configurable: true, value: paused });
};

describe("PlayerLightbox markup", () => {
  it("is a modal dialog labelled with the file name, rendered into document.body", () => {
    const { container } = render(<PlayerLightbox {...baseProps()} />);
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(dialog().getAttribute("aria-label")).toBe("Preview of my clip #1.mov");
    expect(dialog().parentElement).toBe(document.body);
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });

  it("renders a video with native controls, metadata preload and the src as given", () => {
    render(<PlayerLightbox {...baseProps()} />);
    const video = videoOf();
    expect(video.controls).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.getAttribute("src")).toBe(SRC);
  });

  it("renders an audio element for an audio plan", () => {
    render(<PlayerLightbox {...baseProps({ plan: { kind: "audio", mime: "audio/mpeg" }, name: "song.mp3" })} />);
    expect(document.querySelector("audio[controls][preload=metadata]")).toBeTruthy();
    expect(document.querySelector("video")).toBeNull();
  });

  it("renders an img with a file-name alt for an image plan", () => {
    render(<PlayerLightbox {...baseProps({ plan: { kind: "image" }, name: "p.heic" })} />);
    const img = screen.getByRole("img", { name: "Preview of p.heic" });
    expect(img.getAttribute("src")).toBe(SRC);
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("audio")).toBeNull();
  });
});

describe("PlayerLightbox focus", () => {
  it("starts with focus on Close preview", () => {
    render(<PlayerLightbox {...baseProps()} />);
    expect(document.activeElement).toBe(closeButton());
  });

  it("returns focus to the control that opened it when it goes away", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<PlayerLightbox {...baseProps()} />);
    expect(document.activeElement).toBe(closeButton());
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("wraps Tab from the last control to the first", () => {
    render(<PlayerLightbox {...baseProps()} />);
    videoOf().focus();
    expect(document.activeElement).toBe(videoOf());
    const notPrevented = fireEvent.keyDown(videoOf(), { key: "Tab" });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(closeButton());
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    render(<PlayerLightbox {...baseProps()} />);
    expect(document.activeElement).toBe(closeButton());
    const notPrevented = fireEvent.keyDown(closeButton(), { key: "Tab", shiftKey: true });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(videoOf());
  });

  it("keeps focus on the only control of an image preview", () => {
    render(<PlayerLightbox {...baseProps({ plan: { kind: "image" }, name: "p.heic" })} />);
    expect(fireEvent.keyDown(closeButton(), { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(closeButton());
    expect(fireEvent.keyDown(closeButton(), { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(closeButton());
  });

  it("leaves other keys alone", () => {
    render(<PlayerLightbox {...baseProps()} />);
    expect(fireEvent.keyDown(closeButton(), { key: "a" })).toBe(true);
  });
});

describe("PlayerLightbox closing", () => {
  it("closes once on Escape, reporting the playback position and state", () => {
    const onClose = vi.fn();
    render(<PlayerLightbox {...baseProps({ onClose })} />);
    setPlayback(videoOf(), 30, false);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ startAt: 30, playing: true });
  });

  it("reports a paused video as not playing", () => {
    const onClose = vi.fn();
    render(<PlayerLightbox {...baseProps({ onClose })} />);
    setPlayback(videoOf(), 12.5, true);
    fireEvent.keyDown(closeButton(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ startAt: 12.5, playing: false });
  });

  it("does not let Escape reach page-level key handlers", () => {
    const pageHandler = vi.fn();
    document.addEventListener("keydown", pageHandler);
    render(<PlayerLightbox {...baseProps()} />);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    document.removeEventListener("keydown", pageHandler);
    expect(pageHandler).not.toHaveBeenCalled();
  });

  it("closes once when the scrim itself is clicked", () => {
    const onClose = vi.fn();
    render(<PlayerLightbox {...baseProps({ onClose })} />);
    setPlayback(videoOf(), 4, true);
    fireEvent.click(dialog());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ startAt: 4, playing: false });
  });

  it("closes once when a press starts and ends on the scrim", () => {
    const onClose = vi.fn();
    render(<PlayerLightbox {...baseProps({ onClose })} />);
    fireEvent.pointerDown(dialog());
    fireEvent.click(dialog());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open when a scrub that started on the video is released over the scrim", () => {
    // The browser sends that click to the nearest shared ancestor, which is the scrim.
    const onClose = vi.fn();
    render(<PlayerLightbox {...baseProps({ onClose })} />);
    fireEvent.pointerDown(videoOf());
    fireEvent.click(dialog());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open when a press on the close button is dragged off onto the scrim", () => {
    const onClose = vi.fn();
    render(<PlayerLightbox {...baseProps({ onClose })} />);
    fireEvent.pointerDown(closeButton());
    fireEvent.click(dialog());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("judges each press on its own", () => {
    const onClose = vi.fn();
    render(<PlayerLightbox {...baseProps({ onClose })} />);
    fireEvent.pointerDown(videoOf());
    fireEvent.click(dialog());
    fireEvent.pointerDown(dialog());
    fireEvent.click(dialog());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the media is clicked", () => {
    const onClose = vi.fn();
    render(<PlayerLightbox {...baseProps({ onClose })} />);
    fireEvent.click(videoOf());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes exactly once when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<PlayerLightbox {...baseProps({ onClose })} />);
    setPlayback(videoOf(), 7, false);
    fireEvent.click(closeButton());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ startAt: 7, playing: true });
  });

  it("reports the start of an image, not playing", () => {
    const onClose = vi.fn();
    render(<PlayerLightbox {...baseProps({ plan: { kind: "image" }, name: "p.heic", onClose })} />);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ startAt: 0, playing: false });
  });
});

describe("PlayerLightbox hand-over from the panel", () => {
  it("seeks to startAt and plays on loadedmetadata when it was playing", () => {
    render(<PlayerLightbox {...baseProps({ startAt: 42, playing: true })} />);
    fireEvent.loadedMetadata(videoOf());
    expect(videoOf().currentTime).toBe(42);
    expect(mediaSpies.play).toHaveBeenCalledTimes(1);
  });

  it("seeks but does not play on loadedmetadata when it was paused", () => {
    render(<PlayerLightbox {...baseProps({ startAt: 42, playing: false })} />);
    fireEvent.loadedMetadata(videoOf());
    expect(videoOf().currentTime).toBe(42);
    expect(mediaSpies.play).not.toHaveBeenCalled();
  });

  it("does nothing until the metadata has loaded", () => {
    render(<PlayerLightbox {...baseProps({ startAt: 42, playing: true })} />);
    expect(mediaSpies.play).not.toHaveBeenCalled();
  });

  it("handles a rejected play() so it can never surface as an unhandled rejection", () => {
    render(<PlayerLightbox {...baseProps({ startAt: 5, playing: true })} />);
    // A plain function, not the spy: vitest attaches its own handler to promises a spy returns.
    const rejection = Promise.reject(new DOMException("blocked", "NotAllowedError"));
    const handlerAttached = vi.spyOn(rejection, "then");
    Object.defineProperty(videoOf(), "play", { configurable: true, value: () => rejection });
    expect(() => fireEvent.loadedMetadata(videoOf())).not.toThrow();
    expect(handlerAttached).toHaveBeenCalled();
  });

  it("copes with a play() that returns nothing", () => {
    mediaSpies.play.mockReturnValue(undefined as unknown as Promise<void>);
    render(<PlayerLightbox {...baseProps({ startAt: 5, playing: true })} />);
    expect(() => fireEvent.loadedMetadata(videoOf())).not.toThrow();
  });
});

/** Unmounts the lightbox from its own onClose, as the inspector does. */
function ClosingHost({ onClose, ...props }: PlayerLightboxProps) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <PlayerLightbox
      {...props}
      onClose={(state) => {
        onClose(state);
        setOpen(false);
      }}
    />
  );
}

describe("PlayerLightbox releases media", () => {
  it("lets go of its element once onClose has the position", () => {
    const onClose = vi.fn();
    render(<ClosingHost {...baseProps({ onClose })} />);
    const video = videoOf();
    setPlayback(video, 30, false);

    fireEvent.keyDown(dialog(), { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).toHaveBeenCalledWith({ startAt: 30, playing: true });
    expect(mediaSpies.pause.mock.contexts).toContain(video);
    expect(mediaSpies.load.mock.contexts).toContain(video);
    expect(srcAtLoad.get(video)).toBe(false);
    expect(video.hasAttribute("src")).toBe(false);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(mediaSpies.pause.mock.invocationCallOrder[0]);
  });

  it("lets go of an audio element when it unmounts", () => {
    const view = render(<PlayerLightbox {...baseProps({ plan: { kind: "audio", mime: "audio/mpeg" }, name: "song.mp3" })} />);
    const audio = document.querySelector("audio") as HTMLAudioElement;

    view.unmount();

    expect(mediaSpies.load.mock.contexts).toContain(audio);
    expect(srcAtLoad.get(audio)).toBe(false);
    expect(audio.hasAttribute("src")).toBe(false);
  });

  it("leaves the element alone while it stays open", () => {
    const view = render(<PlayerLightbox {...baseProps()} />);
    view.rerender(<PlayerLightbox {...baseProps({ startAt: 9 })} />);

    expect(mediaSpies.load).not.toHaveBeenCalled();
    expect(videoOf().getAttribute("src")).toBe(SRC);
  });
});
