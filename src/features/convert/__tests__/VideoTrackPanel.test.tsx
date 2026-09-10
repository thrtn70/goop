import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TrackIdentity, VideoTrackSettingsCapabilities } from "@/types";
import VideoTrackPanel from "../VideoTrackPanel";
import { defaultVideoTrackOptions } from "../videoTrackOptions";

const fact = (value: string) => ({ kind: "value" as const, value });
const track = (index: number, codec_type: string, language: string, title: string): TrackIdentity => ({ index, codec_type,
  codec_name: fact(codec_type === "audio" ? "aac" : "subrip"), container_stream_id: { kind: "missing" }, language: fact(language), title: fact(title),
  disposition: { default: index === 1, forced: index === 3, attached_pic: false, other: {}, malformed: false } });
const video = track(0, "video", "und", "Picture");
const main = track(1, "audio", "eng", "Main");
const dub = track(2, "audio", "eng", "Main");
const subs = track(3, "subtitle", "eng", "English");
const yes = { available: true, reason: null };
const settings: VideoTrackSettingsCapabilities = {
  source: { version: 1, canonical_path: "/movie.mkv", size_bytes: "10", modified_unix_ns: "2", inventory: { version: 1, streams: [video, main, dub, subs] } },
  audio_tracks: [{ track: main, copy: yes, custom: yes }, { track: dub, copy: yes, custom: yes }],
  subtitle_tracks: [{ track: subs, copy: yes, custom: yes }],
  audio_policy: { copy: { keep_all: yes, choose: yes, none: yes }, custom: { keep_all: yes, choose: yes, none: yes } },
  subtitle_policy: { copy: { keep_all: yes, choose: yes, none: yes }, custom: { keep_all: yes, choose: yes, none: yes } },
};

it("shows literal identities and emits source-ordered nonempty choices", () => {
  const onChange = vi.fn();
  const value = { ...defaultVideoTrackOptions(settings), audio: { kind: "choose" as const, stream_indices: [1, 2] } };
  const view = render(<VideoTrackPanel settings={settings} mode="copy" value={value} onChange={onChange} />);
  expect(screen.getByText("Stream 1 · English · Main · AAC · Default")).toBeTruthy();
  expect(screen.getByText("Stream 2 · English · Main · AAC")).toBeTruthy();
  view.rerender(<VideoTrackPanel settings={settings} mode="copy" value={defaultVideoTrackOptions(settings)} onChange={onChange} />);
  fireEvent.click(screen.getByRole("radio", { name: "Choose audio streams" }));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ audio: { kind: "choose", stream_indices: [1, 2] } }));
});
