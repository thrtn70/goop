import { render, renderHook, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import CompressControls from "../CompressControls";
import { resetWorkspaceDrafts, useWorkspaceDraftEntries, WorkspaceDraftProvider } from "@/store/workspaceDrafts";
import { DRAFT_STORAGE_KEY, encodeDraftEntries, loadDraftEntriesOutcome } from "@/store/workspacePersistence";
import type { ProbeResult } from "@/types";
afterEach(() => { cleanup(); resetWorkspaceDrafts(); });

it("persists every draft the controls write so a strict restart restores them", () => {
  const probe = { source_kind: "image", image_format: "jpeg", file_size: 1000, duration_ms: 0 } as unknown as ProbeResult;
  const drafts = renderHook(() => useWorkspaceDraftEntries());
  render(
    <WorkspaceDraftProvider tool="compress" scope={["source", "/a.jpg"]}>
      <CompressControls capabilities={{ quality: true, target_size: true, lossless: false, reason: null }} probe={probe} mode={{ kind: "quality", value: 63 }} onChange={() => {}} />
    </WorkspaceDraftProvider>,
  );
  const entries = drafts.result.current;
  expect(Object.keys(entries).some(key => key.includes("CompressControls.lastQuality"))).toBe(true);
  const raw = encodeDraftEntries(entries);
  expect(loadDraftEntriesOutcome({
    getItem: key => key === DRAFT_STORAGE_KEY ? raw : null,
    setItem: () => { throw new Error("strict v2 load must not write"); },
  })).toEqual({ kind: "ready", entries });
});
