import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRef, type KeyboardEvent } from "react";
import { FOCUS_SENTINEL_ATTR, trapTab } from "@/lib/focusTrap";

function Trap({ controls }: { controls: "none" | "two" | "disabled-first" }) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={ref}
      role="group"
      aria-label="trap"
      tabIndex={-1}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => ref.current && trapTab(event, ref.current)}
    >
      {controls === "disabled-first" && <button disabled>skipped</button>}
      {controls !== "none" && <button>first</button>}
      {controls !== "none" && <button>last</button>}
      {controls !== "none" && <a>no href, not a stop</a>}
    </div>
  );
}

type MediaKind = "video-controls" | "video-bare" | "audio-controls";

/** A button followed by a media element that is the last control, optionally with a trailing sentinel. */
function MediaTrap({
  media,
  sentinel = false,
  leadingSentinel = false,
}: {
  media: MediaKind;
  sentinel?: boolean;
  leadingSentinel?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={ref}
      role="group"
      aria-label="trap"
      tabIndex={-1}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => ref.current && trapTab(event, ref.current)}
    >
      {leadingSentinel && <span tabIndex={0} aria-hidden="true" {...{ [FOCUS_SENTINEL_ATTR]: "" }} />}
      <button>first</button>
      {media === "video-controls" && <video controls tabIndex={0} />}
      {media === "video-bare" && <video tabIndex={0} />}
      {media === "audio-controls" && <audio controls tabIndex={0} />}
      {sentinel && <span tabIndex={0} aria-hidden="true" {...{ [FOCUS_SENTINEL_ATTR]: "" }} />}
    </div>
  );
}

afterEach(cleanup);

describe("trapTab", () => {
  it("wraps forward from the last control and backward from the first", () => {
    render(<Trap controls="two" />);
    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });
    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(first);
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it("lets Tab move on naturally from a control in the middle", () => {
    render(<Trap controls="two" />);
    const first = screen.getByRole("button", { name: "first" });
    first.focus();
    expect(fireEvent.keyDown(first, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("sends focus to the first or last control when the container itself holds it", () => {
    render(<Trap controls="two" />);
    const group = screen.getByRole("group");
    group.focus();
    expect(fireEvent.keyDown(group, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "first" }));
    group.focus();
    expect(fireEvent.keyDown(group, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "last" }));
  });

  it("keeps focus on the container when it has nothing focusable", () => {
    render(<Trap controls="none" />);
    const group = screen.getByRole("group");
    group.focus();
    expect(fireEvent.keyDown(group, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(group);
  });

  it("ignores disabled controls and keys other than Tab", () => {
    render(<Trap controls="disabled-first" />);
    const first = screen.getByRole("button", { name: "first" });
    first.focus();
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "last" }));
    expect(fireEvent.keyDown(first, { key: "Enter" })).toBe(true);
  });

  it("does not intercept a forward Tab from a last control that is a media element with native controls", () => {
    render(<MediaTrap media="video-controls" />);
    const video = document.querySelector("video") as HTMLVideoElement;
    video.focus();
    expect(fireEvent.keyDown(video, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(video);
  });

  it("treats an audio element with controls the same way", () => {
    render(<MediaTrap media="audio-controls" />);
    const audio = document.querySelector("audio") as HTMLAudioElement;
    audio.focus();
    expect(fireEvent.keyDown(audio, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(audio);
  });

  it("still wraps from a last media element that has no native controls", () => {
    render(<MediaTrap media="video-bare" />);
    const video = document.querySelector("video") as HTMLVideoElement;
    video.focus();
    expect(fireEvent.keyDown(video, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "first" }));
  });

  it("still wraps Shift+Tab from the first control to a last media element with controls", () => {
    render(<MediaTrap media="video-controls" />);
    const first = screen.getByRole("button", { name: "first" });
    first.focus();
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(document.querySelector("video"));
  });

  it("does not count a focus sentinel as a control, so Shift+Tab from the first lands on the media", () => {
    render(<MediaTrap media="video-controls" sentinel />);
    const first = screen.getByRole("button", { name: "first" });
    first.focus();
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(document.querySelector("video"));
  });

  it("does not count a focus sentinel as a control for audio either", () => {
    render(<MediaTrap media="audio-controls" sentinel />);
    const first = screen.getByRole("button", { name: "first" });
    first.focus();
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(document.querySelector("audio"));
  });

  it("does not count a leading focus sentinel as the first control", () => {
    render(<MediaTrap media="video-controls" leadingSentinel sentinel />);
    const first = screen.getByRole("button", { name: "first" });
    first.focus();
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(document.querySelector("video"));
    const video = document.querySelector("video") as HTMLVideoElement;
    video.focus();
    expect(fireEvent.keyDown(video, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(video);
  });
});
