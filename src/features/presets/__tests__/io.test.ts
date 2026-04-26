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
