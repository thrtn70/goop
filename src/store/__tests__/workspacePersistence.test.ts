import { describe, expect, it } from "vitest";
import {
  admitDraftEntries,
  decodeDraftEntries,
  DRAFT_STORAGE_KEY,
  encodeDraftEntries,
  LEGACY_DRAFT_STORAGE_KEY,
  loadDraftEntries,
  loadDraftEntriesOutcome,
  persistDraftEntries,
  saveDraftEntries,
} from "../workspacePersistence";
import type { CausalOwner, ResponsivenessRecorder, SpanKind } from "@/performance/responsiveness";
import { NOOP_RESPONSIVENESS_RECORDER } from "@/performance/responsiveness";
import { armNextDraftWriteFailure } from "@/performance/responsivenessBootstrap";
const key = (slot: string) => JSON.stringify(["image", slot]);
// Every entry is admissible on its own; together they pass the 500-entry limit.
const overEntryLimit = Object.fromEntries(Array.from({ length: 501 }, (_, i) =>
  [JSON.stringify(["image", "source", `/photo-${i}.png`, "ImageRotateFlow.degrees"]), { value: "cw90" }]));

function recordingRecorder() {
  const calls: Array<readonly unknown[]> = [];
  const owner: CausalOwner = { kind: "setup", setup_id: 1 };
  let nextSpan = 1;
  const recorder = {
    startSetup: (targetId: string) => { calls.push(["startSetup", targetId]); return owner; },
    settleSetup: (actual: CausalOwner) => { calls.push(["settleSetup", actual]); },
    cancelSetup: (actual: CausalOwner) => { calls.push(["cancelSetup", actual]); },
    startSpan: ({ kind }: { kind: SpanKind }) => { calls.push(["startSpan", kind]); return nextSpan++; },
    endSpan: (spanId: number) => { calls.push(["endSpan", spanId]); },
    cancelSpan: (spanId: number) => { calls.push(["cancelSpan", spanId]); },
  } as unknown as ResponsivenessRecorder;
  return { calls, recorder, owner };
}

describe("durable editable drafts", () => {
  it("roundtrips editable source lists and app-icon sets", () => {
    const entries = { [key("ImagePage.files")]: {value:["/photo.png"]},
      [key("ImageAppIconFlow.selected")]: {value:new Set(["macos", "windows"])} };
    const restored = decodeDraftEntries(encodeDraftEntries(entries));
    expect(restored).toEqual(entries);
  });
  it("rejects corruption, unknown versions and oversized snapshots", () => {
    expect(decodeDraftEntries("{")).toEqual({});
    expect(decodeDraftEntries('{"version":99,"entries":{}}')).toEqual({});
    expect(decodeDraftEntries("x".repeat(524289))).toEqual({});
  });
  it("drops malformed file lists and unknown runtime slots independently", () => {
    const raw = JSON.stringify({version:1, entries:{
      [key("ImagePage.files")]:{value:[null]},
      [key("ImageRotateFlow.degrees")]:{value:"cw90"},
      [key("Runtime.promise")]:{value:{}},
    }});
    expect(decodeDraftEntries(raw)).toEqual({[key("ImageRotateFlow.degrees")]:{value:"cw90"}});
  });
  it("persists removal without resurrecting older files", () => {
    const values=new Map<string,string>();
    const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};
    expect(saveDraftEntries(storage,{[key("ImagePage.files")]:{value:["/a.png"]}})).toBe(true);
    expect(saveDraftEntries(storage,{})).toBe(true);
    expect(loadDraftEntries(storage)).toEqual({});
  });
  it("handles unavailable storage without losing in-memory state", () => {
    const storage={getItem:()=>{throw Error("unavailable");},setItem:()=>{throw Error("quota");}};
    expect(loadDraftEntries(storage)).toEqual({});
    expect(saveDraftEntries(storage,{})).toBe(false);
  });
  it("injects exactly one performance-mode write failure before restoring normal storage", () => {
    const writes: string[] = [];
    const storage = { getItem: () => null, setItem: (_key: string, value: string) => { writes.push(value); } };
    armNextDraftWriteFailure();

    expect(persistDraftEntries(storage, {}, NOOP_RESPONSIVENESS_RECORDER)).toEqual({ ok: false, phase: "write" });
    expect(writes).toHaveLength(0);
    expect(persistDraftEntries(storage, {}, NOOP_RESPONSIVENESS_RECORDER).ok).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("writes a version-2 envelope in a new namespace", () => {
    const entries = { [key("ImageRotateFlow.degrees")]: { value: "cw90" } };
    const raw = encodeDraftEntries(entries);
    expect(JSON.parse(raw)).toMatchObject({ version: 2, entries });
    expect(DRAFT_STORAGE_KEY).toBe("goop.workspace-drafts.v2");
    expect(LEGACY_DRAFT_STORAGE_KEY).toBe("goop.workspace-drafts.v1");
    expect(decodeDraftEntries(raw)).toEqual(entries);
  });

  it("migrates validated v1 once while retaining its exact bytes", () => {
    const oldSlot = JSON.stringify(["convert", "source", "/movie.mp4", "VideoOptionsPanel.savedCustom"]);
    const newSlot = JSON.stringify(["convert", "source", "/movie.mp4", "VideoOptionsPanel.savedSoftware"]);
    const software = { kind: "encode", codec: "h264", processor: "software", speed: "medium",
      rate_control: { kind: "constant_quality", crf: 23 } };
    const legacyRaw = JSON.stringify({ version: 1, entries: {
      [oldSlot]: { value: software },
      [key("ImageRotateFlow.degrees")]: { value: "cw90" },
    } });
    const values = new Map([[LEGACY_DRAFT_STORAGE_KEY, legacyRaw]]);
    const storage = {
      getItem: (storageKey: string) => values.get(storageKey) ?? null,
      setItem: (storageKey: string, value: string) => { values.set(storageKey, value); },
    };

    expect(loadDraftEntriesOutcome(storage)).toEqual({
      kind: "ready",
      entries: {
        [newSlot]: { value: software },
        [key("ImageRotateFlow.degrees")]: { value: "cw90" },
      },
    });
    expect(values.get(LEGACY_DRAFT_STORAGE_KEY)).toBe(legacyRaw);
    expect(decodeDraftEntries(values.get(DRAFT_STORAGE_KEY) ?? "")).toEqual({
      [newSlot]: { value: software },
      [key("ImageRotateFlow.degrees")]: { value: "cw90" },
    });
  });

  it("migrates an intentional null saved Custom value into null saved Software", () => {
    const oldSlot = JSON.stringify(["convert", "source", "/movie.mp4", "VideoOptionsPanel.savedCustom"]);
    const newSlot = JSON.stringify(["convert", "source", "/movie.mp4", "VideoOptionsPanel.savedSoftware"]);
    const legacyRaw = JSON.stringify({ version: 1, entries: { [oldSlot]: { value: null } } });
    const values = new Map([[LEGACY_DRAFT_STORAGE_KEY, legacyRaw]]);

    expect(loadDraftEntriesOutcome({
      getItem: storageKey => values.get(storageKey) ?? null,
      setItem: (storageKey, value) => { values.set(storageKey, value); },
    })).toEqual({ kind: "ready", entries: { [newSlot]: { value: null } } });
    expect(values.get(LEGACY_DRAFT_STORAGE_KEY)).toBe(legacyRaw);
    expect(decodeDraftEntries(values.get(DRAFT_STORAGE_KEY) ?? "")).toEqual({ [newSlot]: { value: null } });
  });

  it("reports a failed migration without changing v1 or claiming readiness", () => {
    const legacyRaw = JSON.stringify({ version: 1, entries: {
      [key("ImageRotateFlow.degrees")]: { value: "cw90" },
    } });
    const writes: string[] = [];
    const outcome = loadDraftEntriesOutcome({
      getItem: storageKey => storageKey === LEGACY_DRAFT_STORAGE_KEY ? legacyRaw : null,
      setItem: (_storageKey, value) => { writes.push(value); throw new Error("quota"); },
    });

    expect(outcome).toEqual({
      kind: "migration_pending",
      entries: { [key("ImageRotateFlow.degrees")]: { value: "cw90" } },
      legacy_raw: legacyRaw,
    });
    expect(writes).toHaveLength(1);
  });

  it.each([
    ["malformed", "{"],
    ["future", JSON.stringify({ version: 99, entries: {} })],
  ] as const)("protects %s v2 data and never falls back to stale v1", (reason, v2Raw) => {
    const reads: string[] = [];
    const outcome = loadDraftEntriesOutcome({
      getItem: storageKey => {
        reads.push(storageKey);
        if (storageKey === DRAFT_STORAGE_KEY) return v2Raw;
        return JSON.stringify({ version: 1, entries: { [key("ImageRotateFlow.degrees")]: { value: "cw90" } } });
      },
      setItem: () => { throw new Error("must not write"); },
    });
    expect(outcome).toEqual({ kind: "protected", reason });
    expect(reads).toEqual([DRAFT_STORAGE_KEY]);
  });

  const oversizedEntries = { [key("ImagePage.files")]: { value: ["x".repeat(600 * 1024)] } };
  it.each([
    ["a newer version first", DRAFT_STORAGE_KEY, JSON.stringify({ version: 3, entries: oversizedEntries }), "future"],
    ["a newer version first, over the limit only in bytes", DRAFT_STORAGE_KEY, JSON.stringify({ version: 3, entries: { [key("ImagePage.files")]: { value: ["€".repeat(200 * 1024)] } } }), "future"],
    ["a newer version after the entries", DRAFT_STORAGE_KEY, JSON.stringify({ entries: oversizedEntries, version: 3 }), "future"],
    ["a newer version in the older slot", LEGACY_DRAFT_STORAGE_KEY, JSON.stringify({ version: 2, entries: oversizedEntries }), "future"],
    ["the current version too far from the start", DRAFT_STORAGE_KEY, `{${" ".repeat(64)}${JSON.stringify({ version: 2, entries: oversizedEntries }).slice(1)}`, "future"],
    ["no envelope", DRAFT_STORAGE_KEY, "x".repeat(600 * 1024), "future"],
    ["the current version first", DRAFT_STORAGE_KEY, JSON.stringify({ version: 2, entries: oversizedEntries }), "oversized"],
    ["an older version first", DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, entries: oversizedEntries }), "oversized"],
    ["the older version first in the older slot", LEGACY_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, entries: oversizedEntries }), "oversized"],
    ["more entries than a save holds", DRAFT_STORAGE_KEY, JSON.stringify({ version: 2, entries: overEntryLimit }), "oversized"],
    // Recovery reads such a save at its own version, where the limit still applies.
    ["more entries than a save holds at an older version", DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, entries: overEntryLimit }), "oversized"],
  ] as const)("protects saved drafts over the size limit that hold %s", (_label, storageKey, raw, reason) => {
    const outcome = loadDraftEntriesOutcome({
      getItem: candidate => candidate === storageKey ? raw : null,
      setItem: () => { throw new Error("must not write"); },
    });
    expect(outcome).toEqual({ kind: "protected", reason });
  });

  it("protects v2 when a known slot is invalid instead of silently erasing it", () => {
    const invalid = JSON.stringify({ version: 2, entries: {
      [key("ImageRotateFlow.degrees")]: { value: "cw90" },
      [JSON.stringify(["convert", "source", "/movie.mp4", "VideoOptionsPanel.savedSoftware"])]: {
        value: { kind: "hardware_encode", codec: "h264", hardware_policy: { kind: "required" },
          rate_control: { kind: "average_bitrate", kbps: 5000 } },
      },
    } });
    expect(loadDraftEntriesOutcome({ getItem: () => invalid, setItem: () => undefined }))
      .toEqual({ kind: "protected", reason: "malformed" });
  });

  it("restores a remembered Compress quality and protects one that is not a number", () => {
    const slot = JSON.stringify(["compress", "source", "/a.jpg", "CompressControls.lastQuality"]);
    const load = (value: unknown) => {
      const raw = JSON.stringify({ version: 2, entries: { [slot]: { value } } });
      return loadDraftEntriesOutcome({ getItem: () => raw, setItem: () => undefined });
    };
    expect(load(63)).toEqual({ kind: "ready", entries: { [slot]: { value: 63 } } });
    expect(load("63")).toEqual({ kind: "protected", reason: "malformed" });
    expect(load(null)).toEqual({ kind: "protected", reason: "malformed" });
  });

  it("restores PDF page drafts with the rotations page cards write and protects any other", () => {
    const slot = JSON.stringify(["compress", "pdf", "/doc.pdf", "PdfRotateFlow.pages"]);
    const load = (rotation: unknown) => {
      const raw = JSON.stringify({ version: 2, entries: { [slot]: { value: [{ originalPage: 1, deleted: false, rotation }] } } });
      return loadDraftEntriesOutcome({ getItem: () => raw, setItem: () => { throw new Error("strict v2 load must not write"); } });
    };
    for (const rotation of [null, "cw90", "cw180", "cw270"]) expect(load(rotation).kind).toBe("ready");
    // The old numeric degrees, an unknown turn, and a missing field (JSON drops undefined).
    for (const rotation of [0, 90, "cw45", undefined]) expect(load(rotation)).toEqual({ kind: "protected", reason: "malformed" });
  });

  it("does not inspect v1 when the v2 read itself fails", () => {
    const reads: string[] = [];
    const outcome = loadDraftEntriesOutcome({
      getItem: storageKey => {
        reads.push(storageKey);
        if (storageKey === DRAFT_STORAGE_KEY) throw new Error("disabled");
        return null;
      },
      setItem: () => undefined,
    });
    expect(outcome).toEqual({ kind: "protected", reason: "read_error" });
    expect(reads).toEqual([DRAFT_STORAGE_KEY]);
  });
});

describe("write-side admission", () => {
  const valid = key("ImageRotateFlow.degrees");
  const refused = {
    unknownSlot: key("Runtime.promise"),
    tooManyKeyParts: JSON.stringify(["compress", "pdf", ...Array.from({ length: 18 }, (_, i) => `/doc-${i}.pdf`), "PdfFlow.op"]),
    longKeyPart: JSON.stringify(["extract", "source", "x".repeat(4097), "UrlHero.lastUrl"]),
    longList: key("ImagePage.files"),
    longText: JSON.stringify(["recognize", "RecognizePage.input"]),
    unsafeNumber: key("ImageResizeFlow.width"),
  };
  const entries = {
    [valid]: { value: "cw90" },
    [refused.unknownSlot]: { value: {} },
    [refused.tooManyKeyParts]: { value: "merge" },
    [refused.longKeyPart]: { value: "https://example.com/video" },
    [refused.longList]: { value: Array.from({ length: 1001 }, (_, i) => `/photo-${i}.png`) },
    [refused.longText]: { value: "x".repeat(65537) },
    [refused.unsafeNumber]: { value: 0x20_0000_0000_0000n },
  };

  it("names every entry a strict load would refuse and admits the rest", () => {
    const { admitted, skipped } = admitDraftEntries(entries);
    expect(admitted).toEqual({ [valid]: { value: "cw90" } });
    expect(skipped).toEqual(Object.values(refused));
  });

  it("saves only admissible entries, so the saved store always loads strictly", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
    expect(persistDraftEntries(storage, entries, NOOP_RESPONSIVENESS_RECORDER).ok).toBe(true);
    expect(loadDraftEntriesOutcome(storage)).toEqual({ kind: "ready", entries: { [valid]: { value: "cw90" } } });
  });

  it("drops a previously saved value once its entry becomes inadmissible", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
    const files = key("ImagePage.files");
    expect(saveDraftEntries(storage, { [files]: { value: ["/a.png"] } })).toBe(true);
    expect(saveDraftEntries(storage, { [files]: { value: Array.from({ length: 1001 }, (_, i) => `/p-${i}.png`) } })).toBe(true);
    expect(loadDraftEntriesOutcome(storage)).toEqual({ kind: "ready", entries: {} });
  });
});

describe("instrumented draft persistence", () => {
  it("encodes and writes once with ordered bounded spans", () => {
    const { calls, recorder, owner } = recordingRecorder();
    const writes: Array<[string, string]> = [];
    const entries = { [key("ImagePage.files")]: { value: ["/a.png"] } };
    const result = persistDraftEntries(
      { getItem: () => null, setItem: (storageKey, value) => { writes.push([storageKey, value]); } },
      entries,
      recorder,
    );
    expect(result).toEqual({
      ok: true,
      encoded_bytes: new TextEncoder().encode(writes[0][1]).length,
    });
    expect(writes).toHaveLength(1);
    expect(decodeDraftEntries(writes[0][1])).toEqual(entries);
    expect(calls).toEqual([
      ["startSetup", "workspace_drafts"],
      ["startSpan", "draft_encode"],
      ["endSpan", 1],
      ["startSpan", "storage_write"],
      ["endSpan", 2],
      ["settleSetup", owner],
    ]);
  });

  it("reports encode failure without writing or retaining exception text", () => {
    const { calls, recorder, owner } = recordingRecorder();
    let writes = 0;
    const result = persistDraftEntries(
      { getItem: () => null, setItem: () => { writes += 1; } },
      overEntryLimit,
      recorder,
    );
    expect(result).toEqual({ ok: false, phase: "encode" });
    expect(writes).toBe(0);
    expect(JSON.stringify(result)).not.toContain("storage limit");
    expect(calls).toEqual([
      ["startSetup", "workspace_drafts"],
      ["startSpan", "draft_encode"],
      ["cancelSpan", 1],
      ["cancelSetup", owner],
    ]);
  });

  it("reports one failed write after a successful single encode", () => {
    const { calls, recorder, owner } = recordingRecorder();
    let writes = 0;
    const result = persistDraftEntries(
      { getItem: () => null, setItem: () => { writes += 1; throw new Error("private quota detail"); } },
      {},
      recorder,
    );
    expect(result).toEqual({ ok: false, phase: "write" });
    expect(writes).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private quota detail");
    expect(calls).toEqual([
      ["startSetup", "workspace_drafts"],
      ["startSpan", "draft_encode"],
      ["endSpan", 1],
      ["startSpan", "storage_write"],
      ["cancelSpan", 2],
      ["cancelSetup", owner],
    ]);
  });
});

describe("JPEG draft persistence", () => {
  const fileKey = JSON.stringify(["convert", "ConvertPage.files"]);
  const file = { id: "photo-1", revision: 2, path: "/photo.jpg", sourceDir: "/", target: "jpeg",
    qualityPreset: "original", resolutionCap: "original", imageOptions: {
      jpeg_quality: 90, resize: { kind: "fit_within", width: 2048, height: 2048 } } };
  it("restores full options and partial numeric text under each file identity", () => {
    const entries = { [fileKey]: { value: [file] },
      [JSON.stringify(["convert", "file", "photo-1", "ImageOptionsPanel.widthDraft"])]: { value: "-" },
      [JSON.stringify(["convert", "file", "photo-1", "ImageOptionsPanel.heightDraft"])]: { value: "" },
      [JSON.stringify(["convert", "file", "photo-2", "ImageOptionsPanel.qualityDraft"])]: { value: "1e" },
      [JSON.stringify(["convert", "file", "photo-1", "ImageOptionsPanel.appliedWidth"])]: { value: "2048" } };
    expect(decodeDraftEntries(encodeDraftEntries(entries))).toEqual({
      ...entries,
      [fileKey]: { value: [{ ...file, metadataPolicy: "preserve", imageColorPolicy: "preserve" }] },
    });
  });
  it("drops malformed options instead of restoring an ineffective draft", () => {
    const entries = { [fileKey]: { value: [{ ...file, imageOptions: { jpeg_quality: -1, resize: { kind: "original" } } }] } };
    expect(decodeDraftEntries(encodeDraftEntries(entries))).toEqual({});
  });
  it("continues restoring legacy drafts without image options", () => {
    const entries = { [fileKey]: { value: [{ ...file, imageOptions: undefined }] } };
    const { imageOptions: _imageOptions, ...withoutImageOptions } = file;
    expect(decodeDraftEntries(encodeDraftEntries(entries))[fileKey]).toEqual({
      value: [{ ...withoutImageOptions, metadataPolicy: "preserve", imageColorPolicy: "preserve" }],
    });
  });
  it.each([true, undefined])("normalizes legacy metadata absence to Preserve when optionsReady is %s", (optionsReady) => {
    const legacy = { ...file, optionsReady };
    delete (legacy as { metadataPolicy?: unknown }).metadataPolicy;
    const entries = { [fileKey]: { value: [legacy] } };
    const restored = decodeDraftEntries(encodeDraftEntries(entries));
    expect((restored[fileKey].value as Array<{ metadataPolicy: string }>)[0].metadataPolicy).toBe("preserve");
  });
  it("restores remove-personal intent for both Convert and Compress", () => {
    const compressKey = JSON.stringify(["compress", "CompressPage.files"]);
    const entries = {
      [fileKey]: { value: [{ ...file, metadataPolicy: "remove_personal" }] },
      [compressKey]: { value: [{
        ...file,
        imageOptions: null,
        metadataPolicy: "remove_personal",
        mode: { kind: "target_size_bytes", value: 2000n },
      }] },
    };
    const restored = decodeDraftEntries(encodeDraftEntries(entries));
    expect(restored).toEqual(Object.fromEntries(Object.entries(entries).map(([key, entry]) => [
      key,
      { value: (entry.value as Array<Record<string, unknown>>).map(file => ({ ...file, imageColorPolicy: "preserve" })) },
    ])));
    const files = restored[compressKey].value as Array<{ mode: { kind: string; value: unknown } }>;
    expect(typeof files[0].mode.value).toBe("bigint");
  });
  it("rejects compression drafts carrying meaningful image options", () => {
    const entries = { [JSON.stringify(["compress", "CompressPage.files"])]: {
      value: [{ ...file, mode: { kind: "quality", value: 75 } }] } };
    expect(decodeDraftEntries(encodeDraftEntries(entries))).toEqual({});
  });

  it("round-trips an exact custom alpha background without seeding absent policy", () => {
    const alpha = { kind: "flatten", background: { red: 17, green: 34, blue: 51 } };
    const entries = { [fileKey]: { value: [{ ...file, imageColorPolicy: "assume_srgb", imageAlphaPolicy: alpha }] } };
    const restored = decodeDraftEntries(encodeDraftEntries(entries));
    expect(restored[fileKey].value).toEqual([expect.objectContaining({ imageAlphaPolicy: alpha })]);
    const restoredAlpha = (restored[fileKey].value as Array<{imageAlphaPolicy: typeof alpha}>)[0].imageAlphaPolicy;
    expect(restoredAlpha).not.toBe(alpha);
    expect(restoredAlpha.background).not.toBe(alpha.background);

    const absent = decodeDraftEntries(encodeDraftEntries({ [fileKey]: { value: [file] } }));
    expect((absent[fileKey].value as Array<Record<string, unknown>>)[0]).not.toHaveProperty("imageAlphaPolicy");
  });

  it("retains exact alpha intent while its target or color selection is temporarily incompatible", () => {
    const alpha = { kind: "flatten", background: { red: 17, green: 34, blue: 51 } };
    const rows = [
      {...file,imageColorPolicy:"preserve",imageAlphaPolicy:alpha},
      {...file,id:"photo-2",target:"png",imageColorPolicy:"assume_srgb",imageAlphaPolicy:alpha},
    ];
    const restored = decodeDraftEntries(encodeDraftEntries({[fileKey]:{value:rows}}));
    expect(restored[fileKey].value).toEqual(rows.map(row => ({...row,metadataPolicy:"preserve"})));
  });

  it.each([
    { kind: "flatten", background: { red: -1, green: 0, blue: 0 } },
    { kind: "flatten", background: { red: 0, green: 256, blue: 0 } },
    { kind: "flatten", background: { red: 0, green: 0, blue: 0 }, extra: true },
    { kind: "flatten", background: { red: "0", green: 0, blue: 0 } },
    { kind: "flatten", background: { red: null, green: 0, blue: 0 } },
    { kind: "flatten", background: [] },
  ])("drops malformed alpha policy drafts: %j", (imageAlphaPolicy) => {
    const entries = { [fileKey]: { value: [{ ...file, imageAlphaPolicy }] } };
    expect(decodeDraftEntries(encodeDraftEntries(entries))).toEqual({});
  });
  it("keeps a well-formed batch stamp through a strict v2 restart", () => {
    const stamped = { ...file, batch: { id: "s1", label: "Web Image", revision: 2 } };
    const values = new Map<string, string>();
    const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
    expect(saveDraftEntries(storage as Storage, { [fileKey]: { value: [stamped] } })).toBe(true);
    const outcome = loadDraftEntriesOutcome(storage as Storage);
    expect(outcome.kind).toBe("ready");
    expect((outcome as { entries: Record<string, { value: Array<{ batch?: unknown }> }> }).entries[fileKey].value[0].batch).toEqual(stamped.batch);
  });
  it("drops only a malformed batch stamp and keeps the file and the store", () => {
    for (const batch of [{ id: "", label: "x", revision: 1 }, { id: "s", label: "l".repeat(257), revision: 1 }, { id: "s", label: "x", revision: -1 }, "stamp"]) {
      const values = new Map<string, string>();
      const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
      values.set(DRAFT_STORAGE_KEY, encodeDraftEntries({ [fileKey]: { value: [{ ...file, batch }] } }));
      const outcome = loadDraftEntriesOutcome(storage as Storage);
      expect(outcome.kind).toBe("ready");
      const restored = (outcome as { entries: Record<string, { value: Array<Record<string, unknown>> }> }).entries[fileKey].value[0];
      expect("batch" in restored).toBe(false);
      expect(restored.imageOptions).toEqual(file.imageOptions);
    }
  });
  it("adds no batch key to an entry that never had one", () => {
    const restored = decodeDraftEntries(encodeDraftEntries({ [fileKey]: { value: [file] } }))[fileKey].value as Array<Record<string, unknown>>;
    expect("batch" in restored[0]).toBe(false);
  });
});


describe("video draft persistence", () => {
  it("retains dormant Automatic quality, incompatible target, Custom settings and blank text", () => {
    const custom = {kind:"encode",codec:"h264",processor:"software",speed:"medium",rate_control:{kind:"constant_quality",crf:23},resize:{kind:"fit_within",width:1920,height:1080},frame_rate:{kind:"constant",numerator:24000,denominator:1001}};
    const entries = {
      [JSON.stringify(["convert","ConvertPage.files"])]:{value:[{path:"/v.mp4",sourceDir:"/",target:"webm",qualityPreset:"balanced",videoOptions:custom}]},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.crfDraft"])]:{value:""},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.bitrateDraft"])]:{value:"-"},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.widthDraft"])]:{value:""},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.heightDraft"])]:{value:"-"},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.appliedWidth"])]:{value:"1920"},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.appliedHeight"])]:{value:"1080"},
      [JSON.stringify(["convert","source","/v.mp4","id","VideoOptionsPanel.savedSoftware"])]:{value:custom},
    };
    expect(decodeDraftEntries(encodeDraftEntries(entries))).toEqual(entries);
  });

  it("retains active Hardware required intent, raw bitrate text and inactive Software settings only in v2", () => {
    const hardware = { kind: "hardware_encode", codec: "h264", hardware_policy: { kind: "required" },
      rate_control: { kind: "average_bitrate", kbps: 5000 }, resize: { kind: "original" }, frame_rate: { kind: "preserve" } };
    const software = { kind: "encode", codec: "h264", processor: "software", speed: "medium",
      rate_control: { kind: "constant_quality", crf: 23 } };
    const entries = {
      [JSON.stringify(["convert", "ConvertPage.files"])]: { value: [{
        path: "/v.mp4", sourceDir: "/", target: "mp4", qualityPreset: null, resolutionCap: null, videoOptions: hardware,
      }] },
      [JSON.stringify(["convert", "source", "/v.mp4", "id", "VideoOptionsPanel.hardwareBitrateDraft"])]: { value: "" },
      [JSON.stringify(["convert", "source", "/v.mp4", "id", "VideoOptionsPanel.savedSoftware"])]: { value: software },
    };
    const raw = encodeDraftEntries(entries);
    expect(JSON.parse(raw).version).toBe(2);
    expect(decodeDraftEntries(raw)).toEqual(entries);
  });

  it("retains an intentional null inactive Software value across a strict v2 restart", () => {
    const savedSoftware = JSON.stringify(["convert", "source", "/v.mp4", "id", "VideoOptionsPanel.savedSoftware"]);
    const entries = {
      [JSON.stringify(["convert", "ConvertPage.files"])]: { value: [{
        path: "/v.mp4", sourceDir: "/", target: "mp4", qualityPreset: "original", videoOptions: null,
      }] },
      [savedSoftware]: { value: null },
    };
    const raw = encodeDraftEntries(entries);
    const values = new Map([[DRAFT_STORAGE_KEY, raw]]);

    expect(loadDraftEntriesOutcome({
      getItem: storageKey => values.get(storageKey) ?? null,
      setItem: () => { throw new Error("strict v2 load must not write"); },
    })).toEqual({ kind: "ready", entries });
  });
});

describe("audio draft persistence", () => {
  const audio = {
    kind: "encode",
    bitrate: { kind: "target", kbps: 320 },
    channels: { kind: "mono" },
    sample_rate: { kind: "exact", hz: 44_100 },
  };
  const fileKey = JSON.stringify(["convert", "ConvertPage.files"]);

  it("restores independently owned per-file and saved Custom options", () => {
    const entries = {
      [fileKey]: { value: [{ path: "/song.wav", sourceDir: "/", target: "mp3", audioOptions: audio }] },
      [JSON.stringify(["convert", "source", "/song.wav", "id", "AudioOptionsPanel.savedCustom"])]: { value: audio },
    };
    const restored = decodeDraftEntries(encodeDraftEntries(entries));
    expect(restored).toEqual(entries);
    expect(restored[fileKey].value).not.toBe(entries[fileKey].value);
  });

  it("drops malformed audio options without affecting legacy files", () => {
    const malformed = { [fileKey]: { value: [{ path: "/song.wav", sourceDir: "/", target: "mp3", audioOptions: { ...audio, extra: true } }] } };
    expect(decodeDraftEntries(encodeDraftEntries(malformed))).toEqual({});
    const legacy = { [fileKey]: { value: [{ path: "/song.wav", sourceDir: "/", target: "mp3" }] } };
    expect(decodeDraftEntries(encodeDraftEntries(legacy))).toEqual(legacy);
  });
});

describe("selected audio track draft persistence", () => {
  const missing = { kind: "missing" };
  const source = {
    version: 1,
    canonical_path: "/media/movie.mkv",
    size_bytes: "4096",
    modified_unix_ns: "1700000000000000000",
    inventory: {
      version: 1,
      streams: [
        {
          index: 1,
          codec_type: "audio",
          codec_name: { kind: "value", value: "aac" },
          container_stream_id: missing,
          language: { kind: "value", value: "eng" },
          title: { kind: "value", value: "Commentary" },
          disposition: { default: false, forced: false, attached_pic: false, other: {}, malformed: false },
        },
      ],
    },
  };
  const trackOptions = { kind: "audio", source, stream_index: 1 };
  const fileKey = JSON.stringify(["convert", "ConvertPage.files"]);

  it("deep-copies a source-bound choice across restart without persisting readiness", () => {
    const entries = { [fileKey]: { value: [{
      path: "/media/movie.mkv", sourceDir: "/media", target: "mp3",
      qualityPreset: null, resolutionCap: null, audioOptions: { kind: "copy" },
      trackOptions,
    }] } };
    const restored = decodeDraftEntries(encodeDraftEntries(entries));
    expect(restored).toEqual(entries);
    expect(restored[fileKey].value).not.toBe(entries[fileKey].value);
    const restoredTrack = (restored[fileKey].value as Array<{trackOptions: typeof trackOptions}>)[0].trackOptions;
    expect(restoredTrack).not.toBe(trackOptions);
    expect(restoredTrack.source).not.toBe(source);
    expect(restoredTrack.source.inventory).not.toBe(source.inventory);
    expect(restoredTrack.source.inventory.streams).not.toBe(source.inventory.streams);
    expect((restored[fileKey].value as Array<Record<string, unknown>>)[0]).not.toHaveProperty("trackPlan");
  });

  it("rejects malformed nested identity without discarding an unrelated valid entry", () => {
    const badFile = { path: "/media/movie.mkv", sourceDir: "/media", target: "mp3",
      qualityPreset: null, resolutionCap: null, audioOptions: { kind: "copy" },
      trackOptions: { ...trackOptions, source: { ...source, inventory: {
        ...source.inventory,
        streams: [{ ...source.inventory.streams[0], index: 2, extra: true }],
      } } },
    };
    const validKey = JSON.stringify(["image", "ImageRotateFlow.degrees"]);
    const raw = JSON.stringify({ version: 1, entries: {
      [fileKey]: { value: [badFile] },
      [validKey]: { value: "cw90" },
    } });
    expect(decodeDraftEntries(raw)).toEqual({ [validKey]: { value: "cw90" } });
  });
});

describe("video track policy draft persistence", () => {
  const missing = { kind: "missing" as const };
  const identity = (index: number, codec_type: string) => ({
    index, codec_type, codec_name: { kind: "value" as const, value: codec_type === "video" ? "h264" : "aac" },
    container_stream_id: missing, language: missing, title: missing,
    disposition: { default: false, forced: false, attached_pic: false, other: {}, malformed: false },
  });
  const source = { version: 1 as const, canonical_path: "/media/movie.mkv", size_bytes: "4096", modified_unix_ns: "7",
    inventory: { version: 1 as const, streams: [identity(0, "video"), identity(1, "audio"), identity(2, "audio"), identity(3, "subtitle")] } };
  const trackOptions = { kind: "video" as const, source, audio: { kind: "choose" as const, stream_indices: [1, 2] }, subtitles: { kind: "none" as const } };
  const fileKey = JSON.stringify(["convert", "ConvertPage.files"]);

  it("roundtrips an independently owned exact source-bound policy", () => {
    const entries = { [fileKey]: { value: [{ path: "/media/movie.mkv", sourceDir: "/media", target: "mkv", videoOptions: { kind: "copy" }, trackOptions }] } };
    const restored = decodeDraftEntries(encodeDraftEntries(entries));
    expect(restored).toEqual(entries);
    const owned = (restored[fileKey].value as typeof entries[typeof fileKey]["value"])[0].trackOptions;
    expect(owned).not.toBe(trackOptions);
    expect(owned.audio.stream_indices).not.toBe(trackOptions.audio.stream_indices);
    expect(owned.source).not.toBe(source);
  });

  it.each([
    { ...trackOptions, audio: { kind: "choose", stream_indices: [] } },
    { ...trackOptions, audio: { kind: "choose", stream_indices: [2, 1] } },
    { ...trackOptions, subtitles: { kind: "choose", stream_indices: [1] } },
    { ...trackOptions, extra: true },
  ])("rejects malformed nested policy without erasing a valid sibling entry", (candidate) => {
    const goodKey = JSON.stringify(["image", "ImageRotateFlow.degrees"]);
    const raw = JSON.stringify({ version: 1, entries: {
      [fileKey]: { value: [{ path: "/media/movie.mkv", sourceDir: "/media", target: "mkv", videoOptions: { kind: "copy" }, trackOptions: candidate }] },
      [goodKey]: { value: "cw90" },
    } });
    expect(decodeDraftEntries(raw)).toEqual({ [goodKey]: { value: "cw90" } });
  });

  it("retains unresolved Choose per file intent across restart and rejects exact indices in it", () => {
    const pendingTrackPolicy = { kind: "video" as const, audio: { kind: "choose_per_file" as const }, subtitles: { kind: "keep_all" as const } };
    const entries = { [fileKey]: { value: [{ path: "/media/movie.mkv", sourceDir: "/media", target: "mkv", videoOptions: { kind: "copy" }, trackOptions: null, pendingTrackPolicy }] } };
    expect(decodeDraftEntries(encodeDraftEntries(entries))).toEqual(entries);
    const malformed = structuredClone(entries);
    (malformed[fileKey].value[0].pendingTrackPolicy.audio as Record<string, unknown>).stream_indices = [1];
    expect(decodeDraftEntries(encodeDraftEntries(malformed))).toEqual({});
  });

  it("retains a source-bound partial UI choice without treating it as wire options", () => {
    const pendingTrackPolicy = { kind: "video" as const, audio: { kind: "choose_per_file" as const }, subtitles: { kind: "choose_per_file" as const } };
    const videoTrackPolicyDraft = { source, audio: { kind: "choose" as const, stream_indices: [1] }, subtitles: { kind: "choose" as const, stream_indices: [] } };
    const entries = { [fileKey]: { value: [{ path: "/media/movie.mkv", sourceDir: "/media", target: "mkv", videoOptions: { kind: "copy" }, trackOptions: null, pendingTrackPolicy, videoTrackPolicyDraft }] } };
    expect(decodeDraftEntries(encodeDraftEntries(entries))).toEqual(entries);
  });
});
