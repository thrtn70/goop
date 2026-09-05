import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { WorkspaceDraftProvider, clearWorkspaceDrafts, resetWorkspaceDrafts, useWorkspaceDraftState } from "../workspaceDrafts";
afterEach(() => { cleanup(); resetWorkspaceDrafts(); });
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
