import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { usePdfPageDrafts } from "../usePdfPageDrafts";

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
