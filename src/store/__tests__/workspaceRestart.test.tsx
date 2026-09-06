import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DRAFT_STORAGE_KEY } from "../workspacePersistence";
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("loads editable intent into a fresh store and preserves subsequent clearing on another restart", async () => {
  const key = JSON.stringify(["image", "ImagePage.files"]);
  window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({version:1, entries:{[key]:{value:["/missing.png"]}}}));
  vi.resetModules();
  const first = await import("../workspaceDrafts");
  const wrapper=({children}:{children:ReactNode})=>createElement(first.WorkspaceDraftProvider,{tool:"image"},children);
  const draft=renderHook(()=>first.useWorkspaceDraftState<string[]>("ImagePage.files",[]),{wrapper});
  expect(draft.result.current[0]).toEqual(["/missing.png"]);
  act(()=>first.clearWorkspaceDrafts("image"));
  expect(draft.result.current[0]).toEqual([]);
  draft.unmount();
  vi.resetModules();
  const second=await import("../workspaceDrafts");
  const restored=renderHook(()=>second.useWorkspaceDraftState<string[]>("ImagePage.files",[]),{wrapper:({children}:{children:ReactNode})=>createElement(second.WorkspaceDraftProvider,{tool:"image"},children)});
  expect(restored.result.current[0]).toEqual([]);
});
