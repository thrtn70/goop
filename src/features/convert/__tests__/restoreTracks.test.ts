import { describe, expect, it } from "vitest";
import type { TrackConvertOptions, TrackSourceBinding } from "@/types";
import { restoredTracks } from "../restoreTracks";

const source = (path: string): TrackSourceBinding => ({
  version: 1, canonical_path: path, size_bytes: "10", modified_unix_ns: "20", inventory: { version: 1, streams: [] },
});
const audio = (path: string, stream_index: number): TrackConvertOptions => ({ kind: "audio", source: source(path), stream_index });
const video = (
  path: string,
  audioPolicy: Extract<TrackConvertOptions, { kind: "video" }>["audio"],
  subtitles: Extract<TrackConvertOptions, { kind: "video" }>["subtitles"],
): TrackConvertOptions => ({ kind: "video", source: source(path), audio: audioPolicy, subtitles });

describe("restoredTracks: audio track choices", () => {
  it("keeps the row's own track whether the batch member is the apply source or an unresolved row", () => {
    const own = { trackOptions: audio("/second.mkv", 2) };
    expect(restoredTracks({ trackOptions: audio("/first.mkv", 1) }, own, true).trackOptions).toEqual(audio("/second.mkv", 2));
    expect(restoredTracks({ trackOptions: null }, own, true).trackOptions).toEqual(audio("/second.mkv", 2));
  });
  it("keeps the row's own track when the batch carries audio settings but no track intent", () => {
    expect(restoredTracks({ trackOptions: undefined }, { trackOptions: audio("/first.mkv", 1) }, true))
      .toEqual({ trackOptions: audio("/first.mkv", 1), pendingTrackPolicy: null });
  });
  it("leaves a row without its own track to choose one, as Apply did", () => {
    expect(restoredTracks({ trackOptions: audio("/first.mkv", 1) }, { trackOptions: undefined }, true))
      .toEqual({ trackOptions: null, pendingTrackPolicy: null });
  });
  it("drops track intent the batch never had when the restored settings carry no audio", () => {
    expect(restoredTracks({ trackOptions: undefined }, { trackOptions: video("/first.mkv", { kind: "none" }, { kind: "keep_all" }) }, false))
      .toEqual({ trackOptions: undefined, pendingTrackPolicy: undefined });
  });
});

describe("restoredTracks: video stream families", () => {
  const applySource = { trackOptions: video("/first.mkv", { kind: "choose", stream_indices: [1] }, { kind: "keep_all" }) };
  const unresolved = { trackOptions: null, pendingTrackPolicy: { kind: "video" as const, audio: { kind: "choose_per_file" as const }, subtitles: { kind: "keep_all" as const } } };

  it("keeps the row's chosen streams whichever batch member it restores from", () => {
    const own = { trackOptions: video("/second.mkv", { kind: "choose", stream_indices: [2] }, { kind: "keep_all" }) };
    for (const batch of [applySource, unresolved]) {
      expect(restoredTracks(batch, own, false)).toEqual({ trackOptions: own.trackOptions, pendingTrackPolicy: null });
    }
  });
  it("takes a family the batch copies to every row from the batch, not the row", () => {
    const own = { trackOptions: video("/first.mkv", { kind: "choose", stream_indices: [1] }, { kind: "none" }) };
    expect(restoredTracks(unresolved, own, false).trackOptions)
      .toEqual(video("/first.mkv", { kind: "choose", stream_indices: [1] }, { kind: "keep_all" }));
  });
  it("asks the row to choose again when it no longer holds a choice for a per-file family", () => {
    const own = { trackOptions: video("/first.mkv", { kind: "keep_all" }, { kind: "keep_all" }) };
    expect(restoredTracks(applySource, own, false)).toEqual({ trackOptions: null, pendingTrackPolicy: unresolved.pendingTrackPolicy });
  });
  it("completes a row's partial draft from the batch's copied families", () => {
    const own = { trackOptions: null, videoTrackPolicyDraft: { source: source("/first.mkv"), audio: { kind: "choose" as const, stream_indices: [1] }, subtitles: { kind: "none" as const } } };
    expect(restoredTracks(applySource, own, false).trackOptions)
      .toEqual(video("/first.mkv", { kind: "choose", stream_indices: [1] }, { kind: "keep_all" }));
  });
  it("needs the row's choice for every per-file family before it completes", () => {
    const batch = { trackOptions: video("/first.mkv", { kind: "choose", stream_indices: [1] }, { kind: "choose", stream_indices: [3] }) };
    const both = { trackOptions: video("/second.mkv", { kind: "choose", stream_indices: [2] }, { kind: "choose", stream_indices: [3] }) };
    expect(restoredTracks(batch, both, false).trackOptions).toEqual(both.trackOptions);
    const one = { trackOptions: null, videoTrackPolicyDraft: { source: source("/second.mkv"), audio: { kind: "choose" as const, stream_indices: [2] }, subtitles: { kind: "choose" as const, stream_indices: [] } } };
    expect(restoredTracks(batch, one, false)).toEqual({
      trackOptions: null,
      pendingTrackPolicy: { kind: "video", audio: { kind: "choose_per_file" }, subtitles: { kind: "choose_per_file" } },
    });
  });
  it("returns copies, never the row's own objects", () => {
    const ownAudio = { trackOptions: audio("/first.mkv", 1) };
    expect(restoredTracks({ trackOptions: null }, ownAudio, true).trackOptions).not.toBe(ownAudio.trackOptions);
    const ownVideo = { trackOptions: video("/second.mkv", { kind: "choose", stream_indices: [2] }, { kind: "keep_all" }) };
    expect(restoredTracks(applySource, ownVideo, false).trackOptions).not.toBe(ownVideo.trackOptions);
  });
  it("hands a batch with no per-file family back as its policy, for each row to resolve", () => {
    const batch = { trackOptions: video("/first.mkv", { kind: "keep_all" }, { kind: "none" }) };
    const own = { trackOptions: video("/second.mkv", { kind: "none" }, { kind: "none" }) };
    expect(restoredTracks(batch, own, false)).toEqual({
      trackOptions: null,
      pendingTrackPolicy: { kind: "video", audio: { kind: "keep_all" }, subtitles: { kind: "none" } },
    });
  });
});
