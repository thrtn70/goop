import { describe, expect, it } from "vitest";
import {
  audioBitratesForTarget,
  audioOptionsForTarget,
  audioOptionsProblem,
  cloneAudioOptions,
  defaultAudioOptions,
  validateAudioOptions,
  validateAudioRequest,
} from "../audioOptions";

describe("audio option projection", () => {
  it("clones every nested option boundary", () => {
    const options = {
      kind: "encode",
      bitrate: { kind: "target", kbps: 192 },
      channels: { kind: "stereo" },
      sample_rate: { kind: "exact", hz: 48_000 },
    } as const;
    const copy = cloneAudioOptions(options);
    expect(copy).toEqual(options);
    expect(copy).not.toBe(options);
    if (copy?.kind === "encode") {
      expect(copy.bitrate).not.toBe(options.bitrate);
      expect(copy.channels).not.toBe(options.channels);
      expect(copy.sample_rate).not.toBe(options.sample_rate);
    }
  });

  it("owns target-specific bitrate choices and defaults", () => {
    expect(audioBitratesForTarget("mp3")).toEqual([64, 96, 128, 160, 192, 256, 320]);
    expect(audioBitratesForTarget("aac")).toEqual([64, 96, 128, 160, 192, 256]);
    expect(audioBitratesForTarget("wav")).toEqual([]);
    expect(defaultAudioOptions("m4a")).toEqual({
      kind: "encode",
      bitrate: { kind: "target", kbps: 192 },
      channels: { kind: "preserve" },
      sample_rate: { kind: "exact", hz: 48_000 },
    });
    expect(defaultAudioOptions("flac")?.bitrate).toBeNull();
  });

  it("rejects unknown keys, invalid policies, and target mismatches", () => {
    expect(() => validateAudioOptions({ kind: "copy", kbps: 192 })).toThrow(/Copy/);
    expect(() => validateAudioOptions({
      kind: "encode",
      bitrate: { kind: "target", kbps: 320 },
      channels: { kind: "surround" },
      sample_rate: { kind: "exact", hz: 96_000 },
    })).toThrow(/channels|sample rate/i);
    expect(() => validateAudioRequest({ target: "aac", audio_options: {
      kind: "encode",
      bitrate: { kind: "target", kbps: 320 },
      channels: { kind: "preserve" },
      sample_rate: { kind: "exact", hz: 48_000 },
    } })).toThrow(/AAC bitrate/);
    expect(() => validateAudioRequest({ target: "wav", audio_options: {
      kind: "encode",
      bitrate: { kind: "target", kbps: 192 },
      channels: { kind: "preserve" },
      sample_rate: { kind: "preserve" },
    } })).toThrow(/WAV.*bitrate/i);
  });

  it("rejects explicit audio conflicts but leaves Automatic compatible", () => {
    expect(validateAudioRequest({ target: "mp3", audio_options: null, video_options: { kind: "copy" } })).toBeNull();
    expect(() => validateAudioRequest({
      target: "mp3",
      audio_options: { kind: "copy" },
      video_options: { kind: "copy" },
    })).toThrow(/cannot be combined/i);
    expect(audioOptionsProblem({
      target: "mp3",
      audioOptions: { kind: "copy" },
      videoOptions: { kind: "copy" },
    })).toMatch(/cannot be combined/i);
  });

  it("normalizes Custom settings when the target changes", () => {
    const mp3 = {
      kind: "encode",
      bitrate: { kind: "target", kbps: 320 },
      channels: { kind: "mono" },
      sample_rate: { kind: "exact", hz: 44_100 },
    } as const;
    expect(audioOptionsForTarget(mp3, "aac")).toEqual({
      ...mp3,
      bitrate: { kind: "target", kbps: 192 },
    });
    expect(audioOptionsForTarget(mp3, "flac")).toEqual({ ...mp3, bitrate: null });
    expect(audioOptionsForTarget(mp3, "mp4")).toBeNull();
    expect(audioOptionsForTarget({ kind: "copy" }, "wav")).toEqual({ kind: "copy" });
  });
});
