import { describe, expect, it } from "vitest";
import type {
  AudioConvertOptions,
  TrackIdentity,
  TrackSettingsCapabilities,
} from "@/types";
import {
  cloneTrackOptions,
  resolvedTrackOptions,
  selectedTrackAvailability,
  trackOptionsAfterSourceReplacement,
  trackSelectionProblem,
} from "../trackOptions";

const fact = (value: string) => ({ kind: "value" as const, value });
const track = (
  index: number,
  language: TrackIdentity["language"] = fact("eng"),
): TrackIdentity => ({
  index,
  codec_type: "audio",
  codec_name: fact(index === 1 ? "aac" : "flac"),
  container_stream_id: { kind: "missing" },
  language,
  title: fact(index === 1 ? "Main" : "Commentary"),
  disposition: {
    default: index === 1,
    forced: index === 2,
    attached_pic: false,
    other: {},
    malformed: false,
  },
});

const settings: TrackSettingsCapabilities = {
  source: {
    version: 1,
    canonical_path: "/movie.mkv",
    size_bytes: "4096",
    modified_unix_ns: "1700000000000000000",
    inventory: { version: 1, streams: [track(0), track(1), track(2)] },
  },
  audio_choices: [
    {
      track: track(1),
      copy: { available: true },
      encode: { available: false, reason: "Encoding facts are unavailable" },
    },
    {
      track: track(2),
      copy: { available: false, reason: "FLAC cannot be copied to M4A" },
      encode: { available: true },
    },
  ],
};

describe("audio track draft contracts", () => {
  it("auto-resolves a sole choice but leaves multiple choices unresolved", () => {
    expect(resolvedTrackOptions(undefined, { ...settings, audio_choices: [settings.audio_choices[0]] }))
      .toMatchObject({ kind: "audio", stream_index: 1 });
    expect(resolvedTrackOptions(undefined, settings)).toBeNull();
  });

  it("uses the selected track's mode capability instead of the first track", () => {
    const selected = {
      kind: "audio" as const,
      source: settings.source,
      stream_index: 2,
    };
    expect(selectedTrackAvailability(settings, selected, "copy")).toEqual({
      available: false,
      reason: "FLAC cannot be copied to M4A",
    });
    expect(selectedTrackAvailability(settings, selected, "encode")).toEqual({
      available: true,
      reason: null,
    });
  });

  it("blocks each multi-track explicit row until selected and rejects a changed binding", () => {
    const copy: AudioConvertOptions = { kind: "copy" };
    expect(trackSelectionProblem({ audioOptions: copy, trackOptions: null, trackSettings: settings }))
      .toMatch(/choose an audio track/i);
    const selected = { kind: "audio" as const, source: settings.source, stream_index: 1 };
    expect(trackSelectionProblem({ audioOptions: copy, trackOptions: selected, trackSettings: settings }))
      .toBeNull();
    const changed = {
      ...settings,
      source: { ...settings.source, modified_unix_ns: "1700000000000000001" },
    };
    expect(trackSelectionProblem({ audioOptions: copy, trackOptions: selected, trackSettings: changed }))
      .toMatch(/source changed.*choose.*again/i);
  });

  it("resets a binding for a replacement path but leaves same-path mutations actionable", () => {
    const selected = { kind: "audio" as const, source: settings.source, stream_index: 1 };
    expect(trackOptionsAfterSourceReplacement(selected, {
      ...settings,
      source: { ...settings.source, canonical_path: "/replacement.mkv" },
    })).toBeNull();
    expect(trackOptionsAfterSourceReplacement(selected, {
      ...settings,
      source: { ...settings.source, modified_unix_ns: "999" },
    })).toBe(selected);
  });

  it("owns the complete nested binding before deferred work", () => {
    const source = structuredClone(settings.source);
    const original = { kind: "audio" as const, source, stream_index: 1 };
    const clone = cloneTrackOptions(original)!;
    source.inventory.streams[1].title = fact("Changed later");
    expect(clone.source.inventory.streams[1].title).toEqual(fact("Main"));
  });
});
