import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { WorkspaceDraftProvider, clearWorkspaceDrafts, resetWorkspaceDrafts, useWorkspaceDraftState, withWorkspaceDrafts } from "../workspaceDrafts";
afterEach(() => { cleanup(); resetWorkspaceDrafts(); vi.unstubAllGlobals(); });
const scope = (tool: "convert" | "compress", source = "pdf") => ({ children }: { children: ReactNode }) => createElement(WorkspaceDraftProvider, { tool, scope: [source] }, children);
it("retains editable values across route unmount without running work", () => {
 const run = vi.fn();
 const first = renderHook(() => useWorkspaceDraftState("test.value", ""), { wrapper: scope("convert") });
 act(() => first.result.current[1]("unfinished")); first.unmount();
 const second = renderHook(() => useWorkspaceDraftState("test.value", ""), { wrapper: scope("convert") });
 expect(second.result.current[0]).toBe("unfinished"); expect(run).not.toHaveBeenCalled();
});
it("isolates tools and sources and applies functional setters to latest value", () => {
 const a=renderHook(()=>useWorkspaceDraftState("test.count",0),{wrapper:scope("convert")});
 const b=renderHook(()=>useWorkspaceDraftState("test.count",0),{wrapper:scope("compress")});
 const c=renderHook(()=>useWorkspaceDraftState("test.count",0),{wrapper:scope("convert","other.pdf")});
 act(()=>{a.result.current[1](n=>n+1);a.result.current[1](n=>n+1);});
 expect(a.result.current[0]).toBe(2);expect(b.result.current[0]).toBe(0);expect(c.result.current[0]).toBe(0);
});
it("explicit reset clears only its scope and ignores stale setters", () => {
 const a=renderHook(()=>useWorkspaceDraftState("test.value",""),{wrapper:scope("convert")});
 const b=renderHook(()=>useWorkspaceDraftState("test.value",""),{wrapper:scope("compress")});
 act(()=>{a.result.current[1]("a");b.result.current[1]("b");});
 const stale=a.result.current[1];
 act(()=>clearWorkspaceDrafts("convert",["pdf"]));
 act(()=>stale("late completion"));
 expect(a.result.current[0]).toBe("");expect(b.result.current[0]).toBe("b");
});
it("consumes each picker command only once across tool remounts", async () => {
 const { claimWorkspaceFilePicker } = await import("../workspaceDrafts");
 expect(claimWorkspaceFilePicker(1)).toBe(true);
 expect(claimWorkspaceFilePicker(1)).toBe(false);
 expect(claimWorkspaceFilePicker(2)).toBe(true);
});


it("retires completion authority when a source scope is recreated", () => {
  const parentDone = vi.fn();
  let complete: () => void = () => {};
  function Form({ onDone }: { onDone: () => void }) {
    const [value, setValue] = useWorkspaceDraftState("test.form", "");
    complete = onDone;
    return <input aria-label="draft" value={value} onChange={event => setValue(event.target.value)} />;
  }
  const ScopedForm = withWorkspaceDrafts(Form, "image", () => ["source", "/a.png"]);
  const sibling = renderHook(() => useWorkspaceDraftState("test.value", "sibling"), { wrapper: scope("convert", "other.pdf") });
  const first = render(<ScopedForm onDone={parentDone} />);
  const stale = complete;
  first.unmount();
  act(() => clearWorkspaceDrafts("image", ["source", "/a.png"]));
  render(<ScopedForm onDone={parentDone} />);
  fireEvent.change(screen.getByLabelText("draft"), { target: { value: "new edit" } });
  act(() => stale());
  expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("new edit");
  expect(parentDone).not.toHaveBeenCalled();
  expect(sibling.result.current[0]).toBe("sibling");
  act(() => complete());
  expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("");
  expect(parentDone).toHaveBeenCalledTimes(1);
  expect(sibling.result.current[0]).toBe("sibling");
});

it("preserves completion authority across route unmount and sibling clearing", () => {
  let complete: () => void = () => {};
  const parentDone = vi.fn();
  function Form({ onDone }: { onDone: () => void }) {
    useWorkspaceDraftState("test.form", "draft");
    complete = onDone;
    return null;
  }
  const ScopedForm = withWorkspaceDrafts(Form, "image", () => ["source", "/a.png"]);
  const first = render(<ScopedForm onDone={parentDone} />);
  const pendingCompletion = complete;
  first.unmount();
  act(() => clearWorkspaceDrafts("image", ["source", "/b.png"]));
  render(<ScopedForm onDone={parentDone} />);
  act(() => pendingCompletion());
  expect(parentDone).toHaveBeenCalledTimes(1);
  act(() => pendingCompletion());
  expect(parentDone).toHaveBeenCalledTimes(1);
});

it("owns nested video draft settings independently of caller objects", () => {
  const value = {kind:"encode" as const,codec:"h264" as const,processor:"software" as const,speed:"medium" as const,rate_control:{kind:"constant_quality" as const,crf:23},resize:{kind:"fit_within" as const,width:1920,height:1080},frame_rate:{kind:"constant" as const,numerator:24000,denominator:1001}};
  const saved = renderHook(() => useWorkspaceDraftState("VideoOptionsPanel.savedCustom",value),{wrapper:scope("convert","video")});
  value.rate_control.crf=44;
  value.resize.width=640;
  value.frame_rate.numerator=60;
  expect(saved.result.current[0].rate_control.crf).toBe(23);
  expect(saved.result.current[0].resize.width).toBe(1920);
  expect(saved.result.current[0].frame_rate.numerator).toBe(24000);
  const next = {...value,rate_control:{kind:"constant_quality" as const,crf:30},resize:{...value.resize,width:1280},frame_rate:{...value.frame_rate,numerator:30000}};
  act(() => saved.result.current[1](next));
  next.rate_control.crf=50;
  next.resize.width=320;
  next.frame_rate.numerator=25;
  expect(saved.result.current[0].rate_control.crf).toBe(30);
  expect(saved.result.current[0].resize.width).toBe(1280);
  expect(saved.result.current[0].frame_rate.numerator).toBe(30000);
});

it("owns selected track identity independently of caller objects", () => {
  const trackOptions = {kind:"audio" as const,stream_index:1,source:{version:1,canonical_path:"/movie.mkv",size_bytes:"4096",modified_unix_ns:"1700000000000000000",inventory:{version:1,streams:[{index:1,codec_type:"audio",codec_name:{kind:"value" as const,value:"aac"},container_stream_id:{kind:"missing" as const},language:{kind:"value" as const,value:"eng"},title:{kind:"value" as const,value:"Commentary"},disposition:{default:false,forced:false,attached_pic:false,other:{},malformed:false}}]}}};
  const files = [{path:"/movie.mkv",sourceDir:"/",target:"mp3",trackOptions}];
  const saved = renderHook(() => useWorkspaceDraftState("ConvertPage.files", files), {wrapper:scope("convert","movie")});
  trackOptions.source.inventory.streams[0].title.value = "Changed";
  (trackOptions.source.inventory.streams[0].disposition.other as Record<string, boolean>).commentary = true;
  const owned = saved.result.current[0][0].trackOptions;
  expect(owned.source.inventory.streams[0].title.value).toBe("Commentary");
  expect(owned.source.inventory.streams[0].disposition.other).toEqual({});
});

it("blocks autosave, Retry writes and ordinary reset after an unreadable v2 initialization", async () => {
  const reads: string[] = [];
  const writes: string[] = [];
  vi.stubGlobal("localStorage", {
    getItem: (storageKey: string) => {
      reads.push(storageKey);
      if (storageKey === "goop.workspace-drafts.v2") throw new Error("private read detail");
      return null;
    },
    setItem: (_storageKey: string, value: string) => { writes.push(value); },
  });
  vi.resetModules();
  const drafts = await import("../workspaceDrafts");
  const wrapper = ({ children }: { children: ReactNode }) => createElement(drafts.WorkspaceDraftProvider, { tool: "image" }, children);
  const failed = renderHook(() => drafts.useDraftPersistenceFailed());
  const edit = renderHook(() => drafts.useWorkspaceDraftState("ImageRotateFlow.degrees", "cw90"), { wrapper });

  expect(failed.result.current).toBe(true);
  act(() => edit.result.current[1]("ccw90"));
  expect(edit.result.current[0]).toBe("ccw90");
  act(() => drafts.retryDraftPersistence());
  expect(edit.result.current[0]).toBe("ccw90");
  act(() => drafts.resetWorkspaceDrafts());
  expect(writes).toEqual([]);
  expect(failed.result.current).toBe(true);
  expect(reads).toEqual(["goop.workspace-drafts.v2", "goop.workspace-drafts.v2"]);
});

it.each([
  ["malformed", "{"],
  ["future", JSON.stringify({ version: 99, entries: {} })],
] as const)("keeps %s v2 protected through edits, Retry and ordinary reset", async (_reason, raw) => {
  const writes: string[] = [];
  vi.stubGlobal("localStorage", {
    getItem: (storageKey: string) => storageKey === "goop.workspace-drafts.v2" ? raw : null,
    setItem: (_storageKey: string, value: string) => { writes.push(value); },
  });
  vi.resetModules();
  const drafts = await import("../workspaceDrafts");
  const wrapper = ({ children }: { children: ReactNode }) => createElement(drafts.WorkspaceDraftProvider, { tool: "image" }, children);
  const failed = renderHook(() => drafts.useDraftPersistenceFailed());
  const edit = renderHook(() => drafts.useWorkspaceDraftState("ImageRotateFlow.degrees", "cw90"), { wrapper });

  expect(failed.result.current).toBe(true);
  act(() => edit.result.current[1]("ccw90"));
  act(() => drafts.retryDraftPersistence());
  act(() => drafts.resetWorkspaceDrafts());
  expect(failed.result.current).toBe(true);
  expect(writes).toEqual([]);
});

it("retains immediate edits after a failed migration and retries only after re-reading exact v1", async () => {
  const legacyKey = "goop.workspace-drafts.v1";
  const v2Key = "goop.workspace-drafts.v2";
  const entryKey = JSON.stringify(["image", "ImageRotateFlow.degrees"]);
  const legacyRaw = JSON.stringify({ version: 1, entries: { [entryKey]: { value: "cw90" } } });
  const values = new Map([[legacyKey, legacyRaw]]);
  let failWrites = true;
  vi.stubGlobal("localStorage", {
    getItem: (storageKey: string) => values.get(storageKey) ?? null,
    setItem: (storageKey: string, value: string) => {
      if (failWrites) throw new Error("quota");
      values.set(storageKey, value);
    },
  });
  vi.resetModules();
  const drafts = await import("../workspaceDrafts");
  const persistence = await import("../workspacePersistence");
  const wrapper = ({ children }: { children: ReactNode }) => createElement(drafts.WorkspaceDraftProvider, { tool: "image" }, children);
  const failed = renderHook(() => drafts.useDraftPersistenceFailed());
  const edit = renderHook(() => drafts.useWorkspaceDraftState("ImageRotateFlow.degrees", "none"), { wrapper });

  expect(edit.result.current[0]).toBe("cw90");
  expect(failed.result.current).toBe(true);
  act(() => edit.result.current[1]("ccw90"));
  expect(values.get(legacyKey)).toBe(legacyRaw);
  expect(values.has(v2Key)).toBe(false);

  failWrites = false;
  act(() => drafts.retryDraftPersistence());
  expect(failed.result.current).toBe(false);
  expect(edit.result.current[0]).toBe("ccw90");
  expect(persistence.decodeDraftEntries(values.get(v2Key) ?? "")).toEqual({
    [entryKey]: { value: "ccw90" },
  });
  expect(values.get(legacyKey)).toBe(legacyRaw);
});

it("re-hydrates repaired protected v2 data before allowing persistence", async () => {
  const v2Key = "goop.workspace-drafts.v2";
  const entryKey = JSON.stringify(["image", "ImageRotateFlow.degrees"]);
  const values = new Map([[v2Key, "{"]]);
  const writes: string[] = [];
  vi.stubGlobal("localStorage", {
    getItem: (storageKey: string) => values.get(storageKey) ?? null,
    setItem: (storageKey: string, value: string) => { writes.push(value); values.set(storageKey, value); },
  });
  vi.resetModules();
  const drafts = await import("../workspaceDrafts");
  const persistence = await import("../workspacePersistence");
  const failed = renderHook(() => drafts.useDraftPersistenceFailed());
  expect(failed.result.current).toBe(true);

  const repaired = persistence.encodeDraftEntries({ [entryKey]: { value: "ccw90" } });
  values.set(v2Key, repaired);
  act(() => drafts.retryDraftPersistence());

  expect(failed.result.current).toBe(false);
  expect(writes).toEqual([]);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(drafts.WorkspaceDraftProvider, { tool: "image" }, children);
  const restored = renderHook(() => drafts.useWorkspaceDraftState("ImageRotateFlow.degrees", "none"), { wrapper });
  expect(restored.result.current[0]).toBe("ccw90");
});

it.each([
  ["malformed", "{", false],
  ["future", JSON.stringify({ version: 99, entries: {} }), false],
  ["read error", JSON.stringify({ version: 2, entries: {} }), true],
] as const)("enters protected mode when Retry discovers %s v2 after an ordinary write failure", async (_reason, protectedRaw, readError) => {
  const v2Key = "goop.workspace-drafts.v2";
  const entryKey = JSON.stringify(["image", "ImageRotateFlow.degrees"]);
  const values = new Map([[v2Key, JSON.stringify({ version: 2, entries: { [entryKey]: { value: "cw90" } } })]]);
  const writes: string[] = [];
  let failWrites = true;
  let failReads = false;
  vi.stubGlobal("localStorage", {
    getItem: (storageKey: string) => {
      if (failReads && storageKey === v2Key) throw new Error("unavailable");
      return values.get(storageKey) ?? null;
    },
    setItem: (storageKey: string, value: string) => {
      writes.push(value);
      if (failWrites) throw new Error("quota");
      values.set(storageKey, value);
    },
  });
  vi.resetModules();
  const drafts = await import("../workspaceDrafts");
  const wrapper = ({ children }: { children: ReactNode }) => createElement(drafts.WorkspaceDraftProvider, { tool: "image" }, children);
  const failed = renderHook(() => drafts.useDraftPersistenceFailed());
  const edit = renderHook(() => drafts.useWorkspaceDraftState("ImageRotateFlow.degrees", "none"), { wrapper });

  act(() => edit.result.current[1]("ccw90"));
  expect(failed.result.current).toBe(true);
  expect(writes).toHaveLength(1);
  values.set(v2Key, protectedRaw);
  failReads = readError;
  failWrites = false;
  act(() => drafts.retryDraftPersistence());
  act(() => edit.result.current[1]("rotate180"));
  act(() => drafts.resetWorkspaceDrafts());
  expect(failed.result.current).toBe(true);
  expect(writes).toHaveLength(1);
  expect(values.get(v2Key)).toBe(protectedRaw);
});

it("keeps a failed migration pending when its retained v1 disappears before Retry", async () => {
  const legacyKey = "goop.workspace-drafts.v1";
  const v2Key = "goop.workspace-drafts.v2";
  const entryKey = JSON.stringify(["image", "ImageRotateFlow.degrees"]);
  const values = new Map([[legacyKey, JSON.stringify({ version: 1, entries: { [entryKey]: { value: "cw90" } } })]]);
  const writes: string[] = [];
  let failWrites = true;
  vi.stubGlobal("localStorage", {
    getItem: (storageKey: string) => values.get(storageKey) ?? null,
    setItem: (storageKey: string, value: string) => {
      writes.push(value);
      if (failWrites) throw new Error("quota");
      values.set(storageKey, value);
    },
  });
  vi.resetModules();
  const drafts = await import("../workspaceDrafts");
  const wrapper = ({ children }: { children: ReactNode }) => createElement(drafts.WorkspaceDraftProvider, { tool: "image" }, children);
  const failed = renderHook(() => drafts.useDraftPersistenceFailed());
  const edit = renderHook(() => drafts.useWorkspaceDraftState("ImageRotateFlow.degrees", "none"), { wrapper });
  expect(failed.result.current).toBe(true);

  values.delete(legacyKey);
  failWrites = false;
  act(() => drafts.retryDraftPersistence());
  act(() => edit.result.current[1]("ccw90"));
  expect(failed.result.current).toBe(true);
  expect(values.has(v2Key)).toBe(false);
  expect(writes).toHaveLength(1);
});
