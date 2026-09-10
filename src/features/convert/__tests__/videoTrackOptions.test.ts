import { describe, expect, it } from "vitest";
import type { TrackIdentity, TrackPresetPolicy, VideoTrackSettingsCapabilities } from "@/types";
import {
  defaultVideoTrackOptions,
  videoTrackOptionsFromPreset,
  videoTrackOptionsProblem,
  videoTrackPolicyForPreset,
  shouldOfferVideoTrackOptions,
  completeVideoTrackOptions,
  appliedVideoTrackState,
} from "../videoTrackOptions";

const fact = (value: string) => ({ kind: "value" as const, value });
const track = (index: number, codec_type: string, language: string): TrackIdentity => ({
  index, codec_type, codec_name: fact(codec_type === "audio" ? "aac" : "subrip"),
  container_stream_id: { kind: "missing" }, language: fact(language), title: fact(`Track ${index}`),
  disposition: { default: index === 1, forced: index === 3, attached_pic: false, other: {}, malformed: false },
});
const source = { version: 1 as const, canonical_path: "/movie.mkv", size_bytes: "42", modified_unix_ns: "7", inventory: { version: 1 as const, streams: [track(0, "video", "und"), track(1, "audio", "eng"), track(2, "audio", "spa"), track(3, "subtitle", "eng")] } };
const yes = { available: true, reason: null };
const no = (reason: string) => ({ available: false, reason });
const settings: VideoTrackSettingsCapabilities = {
  source,
  audio_tracks: [
    { track: source.inventory.streams[1], copy: yes, custom: yes },
    { track: source.inventory.streams[2], copy: no("AAC copy is unavailable"), custom: yes },
  ],
  subtitle_tracks: [{ track: source.inventory.streams[3], copy: yes, custom: yes }],
  audio_policy: { copy: { keep_all: no("Every selected audio stream must be copyable"), choose: yes, none: yes }, custom: { keep_all: yes, choose: yes, none: yes } },
  subtitle_policy: { copy: { keep_all: yes, choose: yes, none: yes }, custom: { keep_all: yes, choose: yes, none: yes } },
};

describe("explicit video track drafts", () => {
  it("starts with visible Keep all policies bound to the current source", () => {
    expect(defaultVideoTrackOptions(settings)).toEqual({ kind: "video", source, audio: { kind: "keep_all" }, subtitles: { kind: "keep_all" } });
  });

  it("fails closed for empty, reordered, stale, or unavailable choices", () => {
    const base = defaultVideoTrackOptions(settings);
    expect(videoTrackOptionsProblem({ options: { ...base, audio: { kind: "choose", stream_indices: [] } }, settings, mode: "copy" })).toMatch(/choose at least one audio/i);
    expect(videoTrackOptionsProblem({ options: { ...base, audio: { kind: "choose", stream_indices: [2, 1] } }, settings, mode: "custom" })).toMatch(/source order/i);
    expect(videoTrackOptionsProblem({ options: { ...base, audio: { kind: "choose", stream_indices: [2] } }, settings, mode: "copy" })).toBe("AAC copy is unavailable");
    expect(videoTrackOptionsProblem({ options: { ...base, source: { ...source, modified_unix_ns: "8" } }, settings, mode: "custom" })).toMatch(/source changed/i);
  });

  it("saves portable policy and resolves each portable non-Choose family per file", () => {
    const exact = { ...defaultVideoTrackOptions(settings), audio: { kind: "choose" as const, stream_indices: [1] }, subtitles: { kind: "none" as const } };
    expect(videoTrackPolicyForPreset(exact)).toEqual({ kind: "video", audio: { kind: "choose_per_file" }, subtitles: { kind: "none" } });
    const portable: TrackPresetPolicy = { kind: "video", audio: { kind: "keep_all" }, subtitles: { kind: "none" } };
    expect(videoTrackOptionsFromPreset(portable, settings)).toEqual({ kind: "video", source, audio: { kind: "keep_all" }, subtitles: { kind: "none" } });
    expect(videoTrackOptionsFromPreset({ ...portable, audio: { kind: "choose_per_file" } }, settings)).toBeNull();
  });

  it("keeps a two-family Choose Subs per-file draft off the wire until both are nonempty", () => {
    const draft = { source, audio: { kind: "choose" as const, stream_indices: [1] }, subtitles: { kind: "choose" as const, stream_indices: [] } };
    expect(completeVideoTrackOptions(draft)).toBeNull();
    expect(completeVideoTrackOptions({ ...draft, subtitles: { kind: "choose", stream_indices: [3] } }))
      .toEqual({ kind: "video", source, audio: { kind: "choose", stream_indices: [1] }, subtitles: { kind: "choose", stream_indices: [3] } });
  });

  it("clears an incomplete draft when applying a new preset policy", () => {
    const policy: Extract<TrackPresetPolicy, { kind: "video" }> = { kind: "video", audio: { kind: "choose_per_file" }, subtitles: { kind: "none" } };
    expect(appliedVideoTrackState({ policy, settings })).toEqual({
      trackOptions: null,
      pendingTrackPolicy: policy,
      videoTrackPolicyDraft: null,
    });
  });

  it("preserves absent legacy and one-audio UI while offering complex or retained policies", () => {
    expect(shouldOfferVideoTrackOptions({ target: "mkv", explicit: true, enabled: false, settings, options: undefined, pendingPolicy: undefined })).toBe(false);
    const oneAudio = { ...settings, audio_tracks: settings.audio_tracks.slice(0, 1), subtitle_tracks: [] };
    expect(shouldOfferVideoTrackOptions({ target: "mkv", explicit: true, enabled: true, settings: oneAudio, options: undefined, pendingPolicy: undefined })).toBe(false);
    expect(shouldOfferVideoTrackOptions({ target: "mkv", explicit: true, enabled: true, settings, options: undefined, pendingPolicy: undefined })).toBe(true);
    expect(shouldOfferVideoTrackOptions({ target: "mkv", explicit: true, enabled: false, settings: oneAudio, options: defaultVideoTrackOptions(oneAudio), pendingPolicy: undefined })).toBe(true);
  });
});
