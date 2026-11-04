import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

const V2 = "goop.workspace-drafts.v2";
const V1 = "goop.workspace-drafts.v1";
const BACKUP = "goop.workspace-drafts.v2.unreadable";
const savedKey = (i: number) => JSON.stringify(["image", "source", `/photo-${i}.png`, "ImageRotateFlow.degrees"]);
const savedEntries = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [savedKey(i), { value: "cw90" }]));
const savedRaw = (count: number, version = 2) => JSON.stringify({ version, entries: savedEntries(count) });
const editKey = JSON.stringify(["image", "ImageRotateFlow.degrees"]);
const largeFilesKey = JSON.stringify(["image", "ImagePage.files"]);
const largeFiles = Array.from({ length: 150 }, (_, i) => `/${i}-${"x".repeat(4000)}.png`);
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
const fullBackupSlots = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${BACKUP}.${i}`, `earlier backup ${i}`]));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetModules(); });

type StorageControl = { refuseWrite: (storageKey: string) => boolean; failReads: boolean };
async function boot(saved: Record<string, string>, control: StorageControl = { refuseWrite: () => false, failReads: false }) {
  vi.resetModules();
  const values = new Map<string, string>(Object.entries(saved));
  const writes: string[] = [];
  vi.stubGlobal("localStorage", {
    getItem: (storageKey: string) => {
      if (control.failReads) throw new Error("storage unavailable");
      return values.get(storageKey) ?? null;
    },
    setItem: (storageKey: string, value: string) => {
      writes.push(storageKey);
      if (control.refuseWrite(storageKey)) throw new Error("quota");
      values.set(storageKey, value);
    },
  });
  const drafts = await import("../workspaceDrafts");
  const persistence = await import("../workspacePersistence");
  const bootstrap = await import("@/performance/responsivenessBootstrap");
  function field<T>(scope: readonly string[], slot: string, initial: T) {
    const wrapper = ({ children }: { children: ReactNode }) => createElement(drafts.WorkspaceDraftProvider, { tool: "image", scope }, children);
    return renderHook(() => drafts.useWorkspaceDraftState<T>(slot, initial), { wrapper });
  }
  const status = renderHook(() => ({
    persistence: drafts.useDraftPersistence(),
    failed: drafts.useDraftPersistenceFailed(),
    forgetAvailable: drafts.useDraftForgetAvailable(),
    forgetFailure: drafts.useDraftForgetFailure(),
    entries: drafts.useWorkspaceDraftEntries(),
  }));
  const forget = () => {
    let saved = false;
    act(() => { saved = drafts.forgetEarlierDrafts(); });
    return saved;
  };
  const reload = () => persistence.loadDraftEntriesOutcome({
    getItem: storageKey => values.get(storageKey) ?? null,
    setItem: () => { throw new Error("a reload must not write"); },
  });
  return { values, writes, drafts, bootstrap, field, status, forget, reload };
}

describe("a full unfinished-edits store", () => {
  it("reports 500 saved entries plus one new edit as full with the counts, not as a failed write", async () => {
    const { field, status, values } = await boot({ [V2]: savedRaw(500) });
    expect(status.result.current.persistence).toEqual({ kind: "ok" });

    const edit = field([], "ImageRotateFlow.degrees", "cw180");
    act(() => edit.result.current[1]("cw90"));

    const attempted = { ...savedEntries(500), [editKey]: { value: "cw90" } };
    expect(status.result.current.persistence).toEqual({ kind: "full", entries: 501, bytes: utf8Bytes(JSON.stringify({ version: 2, entries: attempted })) });
    expect(status.result.current.failed).toBe(true);
    expect(status.result.current.forgetAvailable).toBe(true);
    expect(edit.result.current[0]).toBe("cw90");
    expect(values.get(V2)).toBe(savedRaw(500));
  });

  it("forgets earlier edits only after backing up the exact saved value in the first free slot, then saves this session's edits", async () => {
    const { field, status, values, forget, reload } = await boot({ [V2]: savedRaw(500), [`${BACKUP}.0`]: "earlier backup" });
    const onScreen = field(["source", "/photo-7.png"], "ImageRotateFlow.degrees", "cw180");
    const edit = field([], "ImageRotateFlow.degrees", "cw180");
    act(() => edit.result.current[1]("ccw90"));
    expect(status.result.current.persistence.kind).toBe("full");

    expect(forget()).toBe(true);

    expect(values.get(`${BACKUP}.0`)).toBe("earlier backup");
    expect(values.get(`${BACKUP}.1`)).toBe(savedRaw(500));
    expect(status.result.current.persistence).toEqual({ kind: "ok" });
    expect(status.result.current.forgetAvailable).toBe(false);
    expect(onScreen.result.current[0]).toBe("cw90");
    expect(edit.result.current[0]).toBe("ccw90");
    const sessionEntries = { [savedKey(7)]: { value: "cw90" }, [editKey]: { value: "ccw90" } };
    expect(status.result.current.entries).toEqual(sessionEntries);
    expect(reload()).toEqual({ kind: "ready", entries: sessionEntries });
  });

  it("restores exactly this session's edits after a restart", async () => {
    const first = await boot({ [V2]: savedRaw(500) });
    const edit = first.field([], "ImageRotateFlow.degrees", "cw180");
    act(() => edit.result.current[1]("ccw90"));
    first.forget();
    cleanup();

    const second = await boot(Object.fromEntries(first.values));
    const restored = second.field([], "ImageRotateFlow.degrees", "cw180");
    const forgotten = second.field(["source", "/photo-3.png"], "ImageRotateFlow.degrees", "cw180");
    expect(restored.result.current[0]).toBe("ccw90");
    expect(forgotten.result.current[0]).toBe("cw180");
    expect(second.status.result.current.persistence).toEqual({ kind: "ok" });
  });

  it("changes nothing and says why when every backup slot is taken", async () => {
    const { field, status, values, writes, forget } = await boot({ [V2]: savedRaw(500), ...fullBackupSlots });
    const edit = field([], "ImageRotateFlow.degrees", "cw180");
    act(() => edit.result.current[1]("ccw90"));
    const before = status.result.current.entries;

    expect(forget()).toBe(false);

    expect(status.result.current.forgetFailure).toBe("no_backup_room");
    expect(status.result.current.persistence.kind).toBe("full");
    expect(status.result.current.forgetAvailable).toBe(true);
    expect(status.result.current.entries).toBe(before);
    expect(values.get(V2)).toBe(savedRaw(500));
    expect(Object.fromEntries([...values].filter(([storageKey]) => storageKey.startsWith(BACKUP)))).toEqual(fullBackupSlots);
    expect(writes.some(storageKey => storageKey.startsWith(BACKUP))).toBe(false);
  });

  it("says so and offers nothing more when this session's own edits still do not fit, losing nothing", async () => {
    const { field, status, values, forget } = await boot({ [V2]: savedRaw(3) });
    const files = field([], "ImagePage.files", largeFiles);
    expect(status.result.current.persistence).toMatchObject({ kind: "full", entries: 4 });
    expect(status.result.current.forgetAvailable).toBe(true);

    expect(forget()).toBe(true);

    expect(values.get(`${BACKUP}.0`)).toBe(savedRaw(3));
    expect(status.result.current.persistence).toEqual({ kind: "full", entries: 1, bytes: utf8Bytes(JSON.stringify({ version: 2, entries: { [largeFilesKey]: { value: largeFiles } } })) });
    expect(status.result.current.forgetAvailable).toBe(false);
    expect(status.result.current.forgetFailure).toBeNull();
    expect(files.result.current[0]).toEqual(largeFiles);
    expect(values.get(V2)).toBe(savedRaw(3));
  });

  it("keeps a refused write a write failure, and Try again saves once storage works", async () => {
    const { field, status, drafts, bootstrap, reload } = await boot({});
    const edit = field([], "ImageRotateFlow.degrees", "cw180");
    bootstrap.armNextDraftWriteFailure();
    act(() => edit.result.current[1]("cw90"));

    expect(status.result.current.persistence).toEqual({ kind: "write_failed" });
    expect(status.result.current.forgetAvailable).toBe(false);

    act(() => drafts.retryDraftPersistence());
    expect(status.result.current.persistence).toEqual({ kind: "ok" });
    expect(reload()).toEqual({ kind: "ready", entries: { [editKey]: { value: "cw90" } } });
  });

  it("offers Forget for a saved copy too large to read at launch, backing it up before starting over from this session", async () => {
    const { field, status, values, writes, forget, reload } = await boot({ [V2]: savedRaw(501) });
    const edit = field([], "ImageRotateFlow.degrees", "cw180");
    act(() => edit.result.current[1]("ccw90"));
    expect(status.result.current.failed).toBe(true);
    expect(status.result.current.forgetAvailable).toBe(true);
    expect(writes).toEqual([]);

    expect(forget()).toBe(true);

    expect(values.get(`${BACKUP}.0`)).toBe(savedRaw(501));
    expect(status.result.current.persistence).toEqual({ kind: "ok" });
    expect(reload()).toEqual({ kind: "ready", entries: { [editKey]: { value: "ccw90" } } });
  });

  it("keeps this session's edits when a save too large at launch has since become readable, backing that save up first", async () => {
    const { field, status, values, writes, forget, reload } = await boot({ [V2]: savedRaw(501) });
    const edit = field([], "ImageRotateFlow.degrees", "cw180");
    act(() => edit.result.current[1]("cw90"));
    values.set(V2, savedRaw(2));

    forget();

    expect(edit.result.current[0]).toBe("cw90");
    expect(status.result.current.entries).toEqual({ [editKey]: { value: "cw90" } });
    expect(values.get(`${BACKUP}.0`)).toBe(savedRaw(2));
    expect(writes).toEqual([`${BACKUP}.0`, V2]);
    expect(status.result.current.persistence).toEqual({ kind: "ok" });
    expect(reload()).toEqual({ kind: "ready", entries: { [editKey]: { value: "cw90" } } });
  });

  it("keeps an unfinished migration's authority until the kept edits are saved, so Try again saves them instead of the old copy", async () => {
    const legacyRaw = savedRaw(500, 1);
    const control: StorageControl = { refuseWrite: storageKey => storageKey === V2, failReads: false };
    const { field, status, values, drafts, forget, reload } = await boot({ [V1]: legacyRaw }, control);
    expect(status.result.current.failed).toBe(true);
    const restored = field(["source", "/photo-0.png"], "ImageRotateFlow.degrees", "cw180");
    expect(restored.result.current[0]).toBe("cw90");
    act(() => restored.result.current[1]("ccw90"));
    const added = field([], "ImageRotateFlow.degrees", "cw180");
    control.refuseWrite = () => false;
    act(() => drafts.retryDraftPersistence());
    expect(status.result.current.persistence).toMatchObject({ kind: "full", entries: 501 });
    expect(status.result.current.forgetAvailable).toBe(true);

    control.refuseWrite = storageKey => storageKey === V2;
    forget();
    expect(values.get(`${BACKUP}.0`)).toBe(legacyRaw);
    expect(values.has(V2)).toBe(false);
    expect(status.result.current.persistence).toEqual({ kind: "write_failed" });

    control.refuseWrite = () => false;
    act(() => drafts.retryDraftPersistence());

    const kept = { [savedKey(0)]: { value: "ccw90" }, [editKey]: { value: "cw180" } };
    expect(restored.result.current[0]).toBe("ccw90");
    expect(added.result.current[0]).toBe("cw180");
    expect(status.result.current.entries).toEqual(kept);
    expect(status.result.current.persistence).toEqual({ kind: "ok" });
    expect(reload()).toEqual({ kind: "ready", entries: kept });
    expect(values.get(V1)).toBe(legacyRaw);
  });

  it("keeps a save too large at launch protected until the kept edits are saved", async () => {
    const control: StorageControl = { refuseWrite: () => false, failReads: false };
    const { field, status, values, forget, reload } = await boot({ [V2]: savedRaw(501) }, control);
    const edit = field([], "ImageRotateFlow.degrees", "cw180");
    act(() => edit.result.current[1]("ccw90"));

    control.refuseWrite = storageKey => storageKey === V2;
    expect(forget()).toBe(true);
    expect(values.get(`${BACKUP}.0`)).toBe(savedRaw(501));
    expect(status.result.current.persistence).toEqual({ kind: "write_failed" });
    expect(status.result.current.forgetAvailable).toBe(true);

    control.refuseWrite = () => false;
    act(() => edit.result.current[1]("cw270"));
    expect(values.get(V2)).toBe(savedRaw(501));

    expect(forget()).toBe(true);
    expect(status.result.current.persistence).toEqual({ kind: "ok" });
    expect(reload()).toEqual({ kind: "ready", entries: { [editKey]: { value: "cw270" } } });
  });

  it.each([
    ["newer format", JSON.stringify({ version: 3, entries: savedEntries(3) })],
    ["newer format too large to read", JSON.stringify({ version: 3, entries: { [largeFilesKey]: { value: ["x".repeat(600 * 1024)] } } })],
  ])("never offers Forget for a save in a %s, and never writes it", async (_label, raw) => {
    const { field, status, values, writes, drafts, forget } = await boot({ [V2]: raw });
    const edit = field([], "ImageRotateFlow.degrees", "cw180");
    act(() => edit.result.current[1]("ccw90"));
    expect(status.result.current.failed).toBe(true);
    expect(status.result.current.forgetAvailable).toBe(false);

    expect(forget()).toBe(false);
    act(() => drafts.retryDraftPersistence());

    expect(writes).toEqual([]);
    expect(values.get(V2)).toBe(raw);
  });

  it.each([
    ["a newer save", false],
    ["storage that cannot be read", true],
  ])("refuses over %s found when Forget runs, changing no edits and writing nothing", async (_label, failReads) => {
    const control: StorageControl = { refuseWrite: () => false, failReads: false };
    const { field, status, values, writes, forget } = await boot({ [V2]: savedRaw(500) }, control);
    const edit = field([], "ImageRotateFlow.degrees", "cw180");
    act(() => edit.result.current[1]("cw90"));
    expect(status.result.current.persistence.kind).toBe("full");
    const before = status.result.current.entries;
    const newer = JSON.stringify({ version: 3, entries: {} });
    values.set(V2, newer);
    control.failReads = failReads;
    writes.length = 0;

    expect(forget()).toBe(false);

    expect(writes).toEqual([]);
    expect(values.get(V2)).toBe(newer);
    expect(status.result.current.entries).toBe(before);
    expect(edit.result.current[0]).toBe("cw90");
    expect(status.result.current.forgetFailure).toBe("failed");
    expect(status.result.current.forgetAvailable).toBe(false);
  });
});
