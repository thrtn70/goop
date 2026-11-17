import { describe, expect, it } from "vitest";
import type { Job } from "@/types";
import {
  buildHandoff,
  handoffOutcome,
  intakeHandoff,
  HANDOFF_MAX_FILES,
  noHandoffMessage,
  planHandoff,
  readHandoff,
  tooManyMessage,
} from "../handoff";

const file = { id: "file-job", kind: "extract", state: "done", result: { output_path: "/movie.mp4", result_kind: "file" } } as unknown as Job;
const album = (id: string, files?: string[]) =>
  ({ id, kind: "extract", state: "done", result: { output_path: `/albums/${id}`, result_kind: "folder", files } }) as unknown as Job;
const failed = { ...file, id: "failed-job", state: { error: { message: "x", detail: null } }, result: null } as Job;
const cancelled = { ...file, id: "cancelled-job", state: "cancelled" } as Job;
const running = { ...file, id: "running-job", state: "running", result: null } as Job;
const pdfSplit = { ...album("split"), kind: "pdf" } as Job;
const none = { failed: 0, cancelled: 0, unfinished: 0, oldAlbum: 0, folder: 0, missing: 0 };

describe("planHandoff", () => {
  it("takes finished files and albums with a recorded list", () => {
    const plan = planHandoff([file, album("a", ["1.jpg", "2.jpg"])]);
    expect(plan).toEqual({
      kind: "ready",
      count: 3,
      candidates: [
        { sourceJobId: "file-job", source: { output_path: "/movie.mp4" } },
        { sourceJobId: "a", source: { output_path: "/albums/a", files: ["1.jpg", "2.jpg"] } },
      ],
      skipped: none,
    });
  });

  it("names why each other item is left out", () => {
    const plan = planHandoff([file, failed, cancelled, running, album("old"), album("empty", []), pdfSplit]);
    expect(plan.kind).toBe("ready");
    expect(plan.skipped).toEqual({ ...none, failed: 1, cancelled: 1, unfinished: 1, oldAlbum: 2, folder: 1 });
  });

  it("offers nothing when no item qualifies", () => {
    expect(planHandoff([failed, album("old")])).toEqual({ kind: "none", skipped: { ...none, failed: 1, oldAlbum: 1 } });
    expect(planHandoff([])).toEqual({ kind: "none", skipped: none });
  });

  it("refuses the whole handoff past the limit, all or nothing", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `${i}.jpg`);
    expect(planHandoff([album("full", names(HANDOFF_MAX_FILES))]).kind).toBe("ready");
    expect(planHandoff([album("big", names(640))])).toEqual({ kind: "too_many", count: 640, singleAlbum: true, skipped: none });
    expect(planHandoff([album("full", names(HANDOFF_MAX_FILES)), file])).toEqual({ kind: "too_many", count: 201, singleAlbum: false, skipped: none });
  });
});

describe("buildHandoff", () => {
  it("keeps each resolved path with its origin and counts the missing ones", () => {
    const plan = planHandoff([file, failed, album("a", ["1.jpg", "2.jpg"])]);
    if (plan.kind !== "ready") throw new Error("expected ready");
    const handoff = buildHandoff("convert", plan, [
      { paths: [], missing: 1 },
      { paths: ["/albums/a/1.jpg"], missing: 1 },
    ]);
    expect(handoff).toMatchObject({
      destination: "convert",
      items: [{ sourceJobId: "a", path: "/albums/a/1.jpg" }],
      skipped: { ...none, failed: 1, missing: 2 },
    });
    expect(handoff.id).not.toBe(buildHandoff("convert", plan, []).id);
  });
});

describe("readHandoff", () => {
  it("accepts only its destination and a well-formed list", () => {
    const handoff = { id: "h", destination: "compress", items: [{ sourceJobId: "a", path: "/a.mp4" }], skipped: none };
    expect(readHandoff({ handoff }, "compress")).toEqual(handoff);
    expect(readHandoff({ handoff }, "convert")).toBeNull();
    expect(readHandoff({ handoff: { ...handoff, items: [{ sourceJobId: "a", path: "" }] } }, "compress")).toBeNull();
    expect(readHandoff({ handoff: { ...handoff, items: "nope" } }, "compress")).toBeNull();
    expect(readHandoff({ handoff: { path: [] } }, "compress")).toBeNull();
    expect(readHandoff(null, "compress")).toBeNull();
  });

  it("still reads a single-path handoff made before the update", () => {
    const old = { id: "old", sourceJobId: "j", path: "/b.mp4", destination: "convert" };
    expect(readHandoff({ handoff: old }, "convert")).toEqual({
      id: "old",
      destination: "convert",
      items: [{ sourceJobId: "j", path: "/b.mp4" }],
      skipped: none,
    });
  });

  it("ignores skip counts that aren't counts", () => {
    const handoff = { id: "h", destination: "convert", items: [{ sourceJobId: "a", path: "/a.mp4" }], skipped: { failed: -1, missing: "2" } };
    expect(readHandoff({ handoff }, "convert")?.skipped).toEqual(none);
  });
});

describe("wording", () => {
  it("says what was added and what was skipped, once", () => {
    expect(handoffOutcome("convert", 12, 0, { ...none, failed: 1, missing: 1 })).toBe(
      "Added 12 files to Convert. Skipped 2: 1 failed, 1 missing file.",
    );
    expect(handoffOutcome("compress", 1, 0, none)).toBe("Added 1 file to Compress.");
    expect(handoffOutcome("convert", 2, 1, none)).toBe("Added 2 files to Convert. 1 was already there.");
    expect(handoffOutcome("convert", 0, 3, { ...none, oldAlbum: 2 })).toBe(
      "3 files were already in Convert. Skipped 2: 2 albums from before v0.3.9.",
    );
    expect(handoffOutcome("convert", 1, 0, { ...none, cancelled: 1, unfinished: 2, folder: 1, missing: 3 })).toBe(
      "Added 1 file to Convert. Skipped 7: 1 cancelled, 2 not finished, 1 folder, 3 missing files.",
    );
  });

  it("explains a refused or empty handoff", () => {
    expect(tooManyMessage("convert", { kind: "too_many", count: 640, singleAlbum: true, skipped: none })).toBe(
      "This album has 640 files; Convert takes up to 200 at a time. Use Show in Finder to pick some.",
    );
    expect(tooManyMessage("compress", { kind: "too_many", count: 201, singleAlbum: false, skipped: none })).toBe(
      "The selection has 201 files; Compress takes up to 200 at a time. Select fewer items.",
    );
    expect(noHandoffMessage("convert", { ...none, failed: 1, missing: 1 })).toEqual({
      title: "Nothing to add to Convert",
      detail: "Skipped 2: 1 failed, 1 missing file.",
    });
  });
});

describe("intakeHandoff", () => {
  const row = (id: string, path: string) => ({ id, path });
  const make = (path: string) => row(`new:${path}`, path);
  const items = (...paths: string[]) => paths.map(path => ({ sourceJobId: "j", path }));

  it("adds new rows after the drafts, keeps existing ones and selects the first added", () => {
    const result = intakeHandoff([row("1", "/a.mp4")], [], items("/a.mp4", "/b.mp4", "/c.png", "/b.mp4"), make);
    expect(result).toEqual({
      rows: [row("1", "/a.mp4"), make("/b.mp4"), make("/c.png")],
      pdfs: [],
      selectId: "new:/b.mp4",
      added: 2,
      existing: 1,
    });
  });

  it("sends PDFs to the PDF list and selects an existing row when nothing new was added", () => {
    const result = intakeHandoff([row("1", "/a.mp4")], ["/old.pdf"], items("/doc.PDF", "/old.pdf", "/a.mp4"), make);
    expect(result).toEqual({ rows: [row("1", "/a.mp4")], pdfs: ["/old.pdf", "/doc.PDF"], selectId: "1", added: 1, existing: 2 });
    expect(intakeHandoff([], [], items("/x.pdf"), make).selectId).toBeNull();
  });
});
