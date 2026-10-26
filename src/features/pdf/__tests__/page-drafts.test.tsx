import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import { usePdfPageDrafts } from "../usePdfPageDrafts";
import { resetWorkspaceDrafts, useWorkspaceDraftEntries, WorkspaceDraftProvider } from "@/store/workspaceDrafts";
import { DRAFT_STORAGE_KEY, encodeDraftEntries, loadDraftEntriesOutcome } from "@/store/workspacePersistence";
afterEach(() => { cleanup(); resetWorkspaceDrafts(); });

it("restores page order, deletion and rotation but reloads thumbnail paths", () => {
  const first = renderHook(() => usePdfPageDrafts("test.pdf"));
  act(() => first.result.current.loadPages([
    { originalPage: 1, deleted: false, rotation: null, thumbPath: "/old/1.png" },
    { originalPage: 2, deleted: false, rotation: null, thumbPath: "/old/2.png" },
  ]));
  act(() => first.result.current.setPages(p => [{ ...p[1], rotation: "cw90" }, { ...p[0], deleted: true }]));
  first.unmount();
  const second = renderHook(() => usePdfPageDrafts("test.pdf"));
  expect(second.result.current.pages.map(p => p.thumbPath)).toEqual([null, null]);
  act(() => second.result.current.loadPages([
    { originalPage: 1, deleted: false, rotation: null, thumbPath: "/new/1.png" },
    { originalPage: 2, deleted: false, rotation: null, thumbPath: "/new/2.png" },
  ]));
  expect(second.result.current.pages).toEqual([
    { originalPage: 2, deleted: false, rotation: "cw90", thumbPath: "/new/2.png" },
    { originalPage: 1, deleted: true, rotation: null, thumbPath: "/new/1.png" },
  ]);
});

it.each(["PdfRotateFlow.pages", "PdfDeleteFlow.pages", "PdfReorderFlow.pages"])("persists %s so a strict restart restores it", slot => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WorkspaceDraftProvider tool="compress" scope={["pdf", "/doc.pdf"]}>{children}</WorkspaceDraftProvider>
  );
  const drafts = renderHook(() => usePdfPageDrafts(slot), { wrapper });
  act(() => drafts.result.current.loadPages([
    { originalPage: 1, deleted: false, rotation: null, thumbPath: "/1.png" },
    { originalPage: 2, deleted: false, rotation: null, thumbPath: "/2.png" },
  ]));
  act(() => drafts.result.current.setPages(p => [{ ...p[1], rotation: "cw270" }, { ...p[0], deleted: true }]));
  const entries = renderHook(() => useWorkspaceDraftEntries()).result.current;
  expect(entries[JSON.stringify(["compress", "pdf", "/doc.pdf", slot])]?.value).toEqual([
    { originalPage: 2, deleted: false, rotation: "cw270" },
    { originalPage: 1, deleted: true, rotation: null },
  ]);
  const raw = encodeDraftEntries(entries);
  expect(loadDraftEntriesOutcome({
    getItem: key => key === DRAFT_STORAGE_KEY ? raw : null,
    setItem: () => { throw new Error("strict v2 load must not write"); },
  })).toEqual({ kind: "ready", entries });
});
