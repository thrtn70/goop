import { describe, expect, it } from "vitest";
import type { ProbeState } from "@/hooks/useProbe";
import { batchKind, kindScope, targetScope } from "../batchScope";
import { batchResetSource, batchState, stampEntries, validBatchStamp, type StampableEntry } from "../batchStamp";

const ready = (source_kind: string, opts: { streams?: Array<{ codec_type: string; attached_pic: boolean }>; targets?: string[]; unavailable?: string[] } = {}) => ({
  phase: "ready",
  probe: { source_kind, video_details: opts.streams ? { streams: opts.streams } : null },
  capabilities: { targets: [
    ...(opts.targets ?? []).map(target => ({ target, available: true, reason: null })),
    ...(opts.unavailable ?? []).map(target => ({ target, available: false, reason: "No" })),
  ] },
}) as unknown as ProbeState;
const probing = { phase: "probing" } as ProbeState;
const failed = { phase: "error", message: "Bad file" } as ProbeState;
const cover = [{ codec_type: "video", attached_pic: true }];
const coverPlusVideo = [{ codec_type: "video", attached_pic: true }, { codec_type: "video", attached_pic: false }];

describe("batchKind", () => {
  it("treats cover-art-only video streams as audio and real video as video", () => {
    expect(batchKind(ready("video", { streams: cover }))).toBe("audio");
    expect(batchKind(ready("video", { streams: coverPlusVideo }))).toBe("video");
    expect(batchKind(ready("video"))).toBe("video");
    expect(batchKind(ready("audio"))).toBe("audio");
    expect(batchKind(ready("image"))).toBe("image");
    expect(batchKind(ready("pdf"))).toBeNull();
    expect(batchKind(probing)).toBeNull();
    expect(batchKind(undefined)).toBeNull();
  });
});

describe("scopes", () => {
  const entries = ["a", "b", "c", "d", "m"].map(id => ({ id, optionsReady: true }));
  const states = { a: ready("image", { targets: ["jpeg"] }), b: ready("image", { targets: ["jpeg"] }), c: ready("video", { targets: ["mp4"] }), d: failed, m: ready("video", { streams: cover, targets: ["mp3"] }) };
  it("scopes Apply to one kind in list order and counts the rest", () => {
    expect(kindScope(entries, states, "image")).toEqual({ ids: ["a", "b"], kept: { image: 0, video: 1, audio: 1, unknown: 1 }, pending: false });
  });
  it("reports pending while a file is probing or not yet seeded", () => {
    expect(kindScope([...entries, { id: "p", optionsReady: false }], { ...states, p: probing }, "image").pending).toBe(true);
    expect(kindScope([{ id: "a", optionsReady: false }], { a: ready("image") }, "image").pending).toBe(true);
  });
  it("scopes presets by available target capability", () => {
    expect(targetScope(entries, { ...states, b: ready("image", { unavailable: ["jpeg"] }) }, "jpeg")).toEqual({ ids: ["a"], kept: { image: 1, video: 1, audio: 1, unknown: 1 }, pending: false });
  });
});

describe("stamps", () => {
  const stamp = { id: "s1", label: "Web Image", revision: 3 };
  it("derives Batch, Edited and none from the revision", () => {
    expect(batchState({ revision: 3, batch: stamp })).toBe("batch");
    expect(batchState({ revision: 4, batch: stamp })).toBe("edited");
    expect(batchState({ revision: 3 })).toBeNull();
    expect(batchState({ revision: 3, batch: null })).toBeNull();
  });
  it("stamps only the given ids at their current revision and truncates long labels", () => {
    const rows: StampableEntry[] = [{ id: "a", revision: 2 }, { id: "b", revision: 7 }, { id: "c", revision: 1 }];
    const out = stampEntries(rows, new Set(["a", "b"]), { id: "s9", label: "x".repeat(300) });
    expect(out[0].batch).toEqual({ id: "s9", label: "x".repeat(256), revision: 2 });
    expect(out[1].batch?.revision).toBe(7);
    expect(out[2]).toBe(rows[2]);
  });
  it("finds an unedited member of the same batch, never the row itself", () => {
    const x = { id: "x", revision: 5, batch: stamp };
    const y = { id: "y", revision: 3, batch: stamp };
    const z = { id: "z", revision: 3, batch: { ...stamp, id: "other" } };
    expect(batchResetSource(x, [x, y, z])).toBe(y);
    expect(batchResetSource(x, [x, z])).toBeNull();
    expect(batchResetSource(y, [y])).toBeNull();
  });
  it("validates stamp shape and bounds", () => {
    expect(validBatchStamp(stamp)).toBe(true);
    for (const bad of [null, {}, { ...stamp, id: "" }, { ...stamp, id: "i".repeat(129) }, { ...stamp, label: "" }, { ...stamp, label: "l".repeat(257) }, { ...stamp, revision: -1 }, { ...stamp, revision: 1.5 }, { ...stamp, revision: "3" }])
      expect(validBatchStamp(bad)).toBe(false);
  });
});
