import { describe, expect, it } from "vitest";
import {
  entriesToPresets,
  parsePresetBundle,
  PresetParseError,
  PRESET_BUNDLE_VERSION,
  serializePresets,
} from "@/features/presets/io";
import type { Preset } from "@/types";

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "id-1",
    name: "Test",
    target: "mp4",
    quality_preset: "balanced",
    resolution_cap: "r1080p",
    compress_mode: null,
    is_builtin: false,
    created_at: BigInt(1_700_000_000_000),
    ...overrides,
  };
}

describe("preset I/O — serialize", () => {
  it("emits the current bundle version and the user's non-builtin presets", () => {
    const presets: Preset[] = [
      makePreset({ id: "a", name: "Alpha" }),
      makePreset({ id: "b", name: "Built-in", is_builtin: true }),
      makePreset({ id: "c", name: "Bravo", target: "mp3", resolution_cap: null }),
    ];
    const json = serializePresets(presets);
    const parsed = JSON.parse(json) as {
      version: number;
      presets: { name: string; target: string }[];
    };
    expect(parsed.version).toBe(PRESET_BUNDLE_VERSION);
    expect(parsed.presets).toHaveLength(2);
    expect(parsed.presets.map((p) => p.name)).toEqual(["Alpha", "Bravo"]);
  });

  it("includes an exported_at ISO timestamp", () => {
    const json = serializePresets([makePreset()]);
    const parsed = JSON.parse(json) as { exported_at: string };
    expect(parsed.exported_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("strips id, is_builtin, and created_at from the entry payload", () => {
    const json = serializePresets([
      makePreset({ id: "should-not-leak", name: "X" }),
    ]);
    const parsed = JSON.parse(json) as { presets: Record<string, unknown>[] };
    const entry = parsed.presets[0];
    expect(entry.id).toBeUndefined();
    expect(entry.is_builtin).toBeUndefined();
    expect(entry.created_at).toBeUndefined();
    expect(entry.name).toBe("X");
  });
});

describe("preset I/O — parse", () => {
  function bundleJson(extra: object = {}): string {
    return JSON.stringify({
      version: PRESET_BUNDLE_VERSION,
      exported_at: "2026-04-26T00:00:00.000Z",
      presets: [
        {
          name: "Roundtrip",
          target: "mp4",
          quality_preset: "balanced",
          resolution_cap: "r1080p",
          compress_mode: null,
        },
      ],
      ...extra,
    });
  }

  it("round-trips a serialized bundle", () => {
    const original = serializePresets([makePreset({ name: "Roundtrip" })]);
    const entries = parsePresetBundle(original);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("Roundtrip");
  });

  it.each(["srt", "vtt"] as const)("round-trips a %s subtitle preset", (target) => {
    const original = makePreset({
      name: "Subtitle",
      target,
      quality_preset: null,
      resolution_cap: null,
    });
    expect(parsePresetBundle(serializePresets([original]))).toEqual([{
      name: "Subtitle",
      target,
      quality_preset: null,
      resolution_cap: null,
      compress_mode: null,
      metadata_policy: null, gif_options: null, subtitle: null, image_options: null, video_options: null, audio_options: null,
    }]);
  });

  it("rejects malformed JSON", () => {
    expect(() => parsePresetBundle("not json {")).toThrow(PresetParseError);
  });

  it("rejects an unsupported version", () => {
    const bad = JSON.stringify({ version: 999, presets: [] });
    expect(() => parsePresetBundle(bad)).toThrow(/unsupported bundle version/);
  });

  it("rejects when presets is not an array", () => {
    const bad = JSON.stringify({ version: PRESET_BUNDLE_VERSION, presets: "nope" });
    expect(() => parsePresetBundle(bad)).toThrow(/missing the .presets. array/);
  });

  it("rejects an entry with an unknown target format", () => {
    const bad = bundleJson({
      presets: [
        {
          name: "Bad",
          target: "fakeformat",
          quality_preset: null,
          resolution_cap: null,
          compress_mode: null,
        },
      ],
    });
    expect(() => parsePresetBundle(bad)).toThrow(/recognised TargetFormat/);
  });

  it("rejects an empty preset name", () => {
    const bad = bundleJson({
      presets: [
        {
          name: "  ",
          target: "mp4",
          quality_preset: null,
          resolution_cap: null,
          compress_mode: null,
        },
      ],
    });
    expect(() => parsePresetBundle(bad)).toThrow(/non-empty string/);
  });

  it("accepts an empty presets array", () => {
    const empty = JSON.stringify({
      version: PRESET_BUNDLE_VERSION,
      exported_at: new Date().toISOString(),
      presets: [],
    });
    expect(parsePresetBundle(empty)).toEqual([]);
  });
});

describe("preset I/O — entriesToPresets", () => {
  it("assigns fresh ids and current timestamps", () => {
    const entries = parsePresetBundle(serializePresets([makePreset({ id: "old" })]));
    const fresh = entriesToPresets(entries, []);
    expect(fresh[0].id).not.toBe("old");
    expect(fresh[0].is_builtin).toBe(false);
    expect(typeof fresh[0].created_at).toBe("bigint");
  });

  it("appends ' (imported)' when the name collides with an existing preset", () => {
    const entries = parsePresetBundle(
      serializePresets([makePreset({ name: "Same" })]),
    );
    const existing = [makePreset({ id: "x", name: "Same" })];
    const fresh = entriesToPresets(entries, existing);
    expect(fresh[0].name).toBe("Same (imported)");
  });

  it("uses a counter suffix '(imported 2)' when '(imported)' is also taken", () => {
    const entries = parsePresetBundle(
      serializePresets([makePreset({ name: "Same" })]),
    );
    const existing = [
      makePreset({ id: "1", name: "Same" }),
      makePreset({ id: "2", name: "Same (imported)" }),
    ];
    const fresh = entriesToPresets(entries, existing);
    expect(fresh[0].name).toBe("Same (imported 2)");
  });

  it("counter increments past existing numbered duplicates", () => {
    const entries = parsePresetBundle(
      serializePresets([makePreset({ name: "Same" })]),
    );
    const existing = [
      makePreset({ id: "1", name: "Same" }),
      makePreset({ id: "2", name: "Same (imported)" }),
      makePreset({ id: "3", name: "Same (imported 2)" }),
      makePreset({ id: "4", name: "Same (imported 3)" }),
    ];
    const fresh = entriesToPresets(entries, existing);
    expect(fresh[0].name).toBe("Same (imported 4)");
  });
});

describe("preset I/O — target_size_bytes round-trip", () => {
  it("serializes bigint compress_mode.value as a JSON number and parses back to bigint", () => {
    const original = makePreset({
      name: "TargetSize",
      compress_mode: { kind: "target_size_bytes", value: BigInt(15_000_000) },
    });
    const json = serializePresets([original]);
    // JSON.stringify must NOT throw on bigint here — the wire shape uses number.
    const parsedRaw = JSON.parse(json) as {
      presets: { compress_mode: { kind: string; value: number } }[];
    };
    expect(parsedRaw.presets[0].compress_mode.value).toBe(15_000_000);
    expect(typeof parsedRaw.presets[0].compress_mode.value).toBe("number");

    const entries = parsePresetBundle(json);
    expect(entries[0].compress_mode).not.toBeNull();
    const cm = entries[0].compress_mode;
    if (cm && cm.kind === "target_size_bytes") {
      expect(typeof cm.value).toBe("bigint");
      expect(cm.value).toBe(BigInt(15_000_000));
    } else {
      throw new Error(`expected target_size_bytes mode, got ${JSON.stringify(cm)}`);
    }
  });

  it("round-trips quality compress_mode unchanged", () => {
    const original = makePreset({
      name: "Q",
      compress_mode: { kind: "quality", value: 75 },
    });
    const entries = parsePresetBundle(serializePresets([original]));
    expect(entries[0].compress_mode).toEqual({ kind: "quality", value: 75 });
  });
});

it("roundtrips all supported settings including safe numeric GIF trims", () => {
  const preset = makePreset({
    metadata_policy: "strip_all",
    gif_options: { size_preset: "small", trim_start_ms: 1000n, trim_end_ms: 2500n },
    subtitle: { source_path: "/captions.srt", mode: "soft" },
  });
  const restored = entriesToPresets(parsePresetBundle(serializePresets([preset])), [])[0];
  expect(restored).toMatchObject({ metadata_policy: "strip_all", subtitle: preset.subtitle,
    gif_options: { size_preset: "small", trim_start_ms: 1000, trim_end_ms: 2500 } });
});

it.each([
  { compress_mode: { kind: "quality", value: 101 } },
  { compress_mode: { kind: "target_size_bytes", value: 0 } },
  { compress_mode: { kind: "target_size_bytes", value: 0.5 } },
  { gif_options: { size_preset: "small", trim_start_ms: 2000, trim_end_ms: 1000 } },
  { gif_options: { size_preset: ["small"] } },
  { subtitle: { source_path: "/s.srt", mode: ["soft"] } },
  { metadata_policy: "invented" },
  { subtitle: { source_path: "", mode: "soft" } },
])("rejects invalid supported preset settings: %j", fields => {
  expect(() => parsePresetBundle(JSON.stringify({ version: 1, presets: [{ name: "Invalid", target: "mp4", ...fields }] }))).toThrow(PresetParseError);
});

describe("JPEG preset persistence", () => {
  const settings = { jpeg_quality: 90, resize: { kind: "fit_within" as const, width: 2048, height: 2048 } };
  const bundle = (image_options: unknown, version = 2, extra = {}) => JSON.stringify({ version,
    presets: [{ name: "Portrait JPEG", target: "jpeg", image_options, ...extra }] });

  it("exports complete JPEG settings in the current schema and imports them unchanged", () => {
    const json = serializePresets([makePreset({ target: "jpeg", quality_preset: null,
      resolution_cap: null, image_options: settings })]);
    expect(JSON.parse(json).version).toBe(PRESET_BUNDLE_VERSION);
    const entries = parsePresetBundle(json);
    expect(entries[0].image_options).toEqual(settings);
    const presets = entriesToPresets(entries, []);
    expect(presets[0].image_options).toEqual(settings);
    if (entries[0].image_options?.resize.kind === "fit_within") entries[0].image_options.resize.width = 1;
    expect(presets[0].image_options).toEqual(settings);
  });

  it("restores old schema 1 with null options and retains modern null fields", () => {
    expect(parsePresetBundle(bundle(undefined, 1))[0]).toMatchObject({ image_options: null,
      metadata_policy: null, gif_options: null, subtitle: null });
    expect(parsePresetBundle(serializePresets([makePreset({ image_options: null })]))[0].image_options).toBeNull();
  });

  it("rejects meaningful options hidden in schema 1", () => {
    expect(() => parsePresetBundle(bundle(settings, 1))).toThrow(/Portrait JPEG.*schema 1/);
    expect(parsePresetBundle(bundle(null, 1))[0].image_options).toBeNull();
  });

  it.each([
    {}, [], { jpeg_quality: 90 }, { ...settings, jpeg_quality: 1.5 },
    { ...settings, jpeg_quality: -1 }, { ...settings, jpeg_quality: 256 },
    { ...settings, jpeg_quality: Infinity }, { ...settings, jpeg_quality: "90" },
    { ...settings, resize: { kind: "fit_within", width: 1.2, height: 2 } },
    { ...settings, resize: { kind: "fit_within", width: -1, height: 2 } },
    { ...settings, resize: { kind: "fit_within", width: 4294967296, height: 2 } },
    { ...settings, resize: { kind: "original", source_path: "/private/photo.jpg" } },
    { ...settings, source_path: "/private/photo.jpg" },
  ])("rejects malformed image options with the preset name: %j", options => {
    expect(() => parsePresetBundle(bundle(options))).toThrow(/Portrait JPEG.*image_options/);
  });

  it("retains structurally valid settings beyond current runtime support", () => {
    const options = { jpeg_quality: 255, resize: { kind: "fit_within", width: 4294967295, height: 0 } };
    expect(parsePresetBundle(bundle(options))[0].image_options).toEqual(options);
  });

  it("rejects compression plus image options with the preset name", () => {
    expect(() => parsePresetBundle(bundle(settings, 2, { compress_mode: { kind: "quality", value: 75 } })))
      .toThrow(/Portrait JPEG.*compression.*image/i);
  });

  it("exports only image setting fields, never incidental source paths", () => {
    const options = { ...settings, source_path: "/private/photo.jpg",
      resize: { ...settings.resize, source_path: "/private/other.jpg" } };
    const json = serializePresets([makePreset({ image_options: options })]);
    expect(json).not.toContain("/private");
    expect(JSON.parse(json).presets[0].image_options).toEqual(settings);
  });
});


describe("schema 4 video presets", () => {
  const video = { kind: "encode", codec: "hevc", processor: "software", speed: "slow", rate_control: { kind: "average_bitrate", kbps: 5000 } } as const;
  const transformed = {...video,resize:{kind:"fit_within",width:1920,height:1080},
    frame_rate:{kind:"constant",numerator:30000,denominator:1001}} as const;
  it("roundtrips complete independently owned video controls", () => {
    const raw = serializePresets([makePreset({ quality_preset: null, resolution_cap:null, video_options: transformed })]);
    expect(JSON.parse(raw).version).toBe(PRESET_BUNDLE_VERSION);
    const entries = parsePresetBundle(raw);
    const presets = entriesToPresets(entries, []);
    expect(presets[0].video_options).toEqual(transformed);
    expect(presets[0].video_options).not.toBe(entries[0].video_options);
    if (presets[0].video_options?.kind === "encode" && entries[0].video_options?.kind === "encode") {
      expect(presets[0].video_options.rate_control).not.toBe(entries[0].video_options.rate_control);
      expect(presets[0].video_options.resize).not.toBe(entries[0].video_options.resize);
      expect(presets[0].video_options.frame_rate).not.toBe(entries[0].video_options.frame_rate);
    }
  });
  it.each([1, 2])("keeps schema %s legacy and rejects meaningful video fields", version => {
    expect(parsePresetBundle(JSON.stringify({version, presets:[{name:"Old",target:"mp4"}]}))[0].video_options).toBeNull();
    expect(() => parsePresetBundle(JSON.stringify({version, presets:[{name:"Wrong",target:"mp4",video_options:video}]}))).toThrow(/video_options/);
  });
  it("accepts legacy Encode in schema 3 but rejects schema 4 transforms", () => {
    const bundle = (video_options: unknown) => JSON.stringify({version:3,presets:[{name:"Legacy",target:"mp4",video_options}]});
    expect(parsePresetBundle(bundle(video))[0].video_options).toEqual(video);
    expect(() => parsePresetBundle(bundle(transformed))).toThrow(/schema 3/);
    expect(parsePresetBundle(bundle({...video,resize:null,frame_rate:null}))[0].video_options).toEqual(video);
  });
  it.each([{...video, extra:true}, {...video, rate_control:{kind:"constant_quality",crf:0}}, {...video, rate_control:{kind:"average_bitrate",kbps:1.5}}, {kind:"copy",codec:"h264"}])("rejects nested invalid settings", video_options => {
    expect(() => parsePresetBundle(JSON.stringify({version:4,presets:[{name:"Invalid",target:"mp4",video_options}]}))).toThrow(/Invalid/);
  });
  it.each([{target:"webm"}, {quality_preset:"original"}, {subtitle:{source_path:"/x.srt",mode:"soft"}}, {resolution_cap:"r720p",video_options:{kind:"copy"}}])("rejects request conflicts", overrides => {
    expect(() => parsePresetBundle(JSON.stringify({version:4,presets:[{name:"Conflict",target:"mp4",video_options:video,...overrides}]}))).toThrow(/Conflict/);
  });
});

describe("schema 5 audio presets", () => {
  const audio = {
    kind: "encode",
    bitrate: { kind: "target", kbps: 320 },
    channels: { kind: "mono" },
    sample_rate: { kind: "exact", hz: 44_100 },
  } as const;

  it("roundtrips complete independently owned audio controls", () => {
    const raw = serializePresets([makePreset({
      target: "mp3",
      quality_preset: null,
      resolution_cap: null,
      audio_options: audio,
    })]);
    expect(JSON.parse(raw).version).toBe(5);
    const entries = parsePresetBundle(raw);
    const presets = entriesToPresets(entries, []);
    expect(presets[0].audio_options).toEqual(audio);
    expect(presets[0].audio_options).not.toBe(entries[0].audio_options);
    if (presets[0].audio_options?.kind === "encode" && entries[0].audio_options?.kind === "encode") {
      expect(presets[0].audio_options.bitrate).not.toBe(entries[0].audio_options.bitrate);
      expect(presets[0].audio_options.channels).not.toBe(entries[0].audio_options.channels);
      expect(presets[0].audio_options.sample_rate).not.toBe(entries[0].audio_options.sample_rate);
    }
  });

  it.each([1, 2, 3, 4])("keeps schema %s legacy and rejects meaningful audio fields", (version) => {
    expect(parsePresetBundle(JSON.stringify({ version, presets: [{ name: "Old", target: "mp3" }] }))[0].audio_options).toBeNull();
    expect(() => parsePresetBundle(JSON.stringify({ version, presets: [{ name: "Wrong", target: "mp3", audio_options: audio }] }))).toThrow(/audio_options/);
  });

  it.each([
    { ...audio, extra: true },
    { ...audio, bitrate: { kind: "target", kbps: 63 } },
    { ...audio, channels: { kind: "surround" } },
    { ...audio, sample_rate: { kind: "exact", hz: 96_000 } },
    { kind: "copy", extra: true },
  ])("rejects malformed or unsupported audio settings", (audio_options) => {
    expect(() => parsePresetBundle(JSON.stringify({
      version: 5,
      presets: [{ name: "Invalid", target: "mp3", audio_options }],
    }))).toThrow(/Invalid/);
  });

  it("rejects target mismatches and request conflicts", () => {
    expect(() => parsePresetBundle(JSON.stringify({
      version: 5,
      presets: [{ name: "Wrong target", target: "flac", audio_options: audio }],
    }))).toThrow(/Wrong target/);
    expect(() => parsePresetBundle(JSON.stringify({
      version: 5,
      presets: [{ name: "Conflict", target: "mp3", audio_options: audio, video_options: { kind: "copy" } }],
    }))).toThrow(/Conflict/);
  });
});
