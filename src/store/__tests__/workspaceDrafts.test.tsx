import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { WorkspaceDraftProvider, clearWorkspaceDrafts, resetWorkspaceDrafts, useWorkspaceDraftState, withWorkspaceDrafts } from "../workspaceDrafts";
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
