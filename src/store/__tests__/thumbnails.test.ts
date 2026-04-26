import { beforeEach, describe, expect, it, vi } from "vitest";
import { jobIdKey, useAppStore } from "@/store/appStore";
import type { JobId } from "@/types";

vi.mock("@/ipc/commands", () => ({
  api: {
    queue: { list: vi.fn(), reveal: vi.fn(), cancel: vi.fn(), clearCompleted: vi.fn() },
    history: { list: vi.fn(), counts: vi.fn() },
    job: { forget: vi.fn(), forgetMany: vi.fn() },
    file: { moveToTrash: vi.fn() },
    settings: { set: vi.fn(), get: vi.fn() },
    thumbnail: { get: vi.fn() },
  },
}));

function makeId(uuid: string): JobId {
  return { 0: uuid } as unknown as JobId;
}

describe("thumbnail cache", () => {
  beforeEach(() => {
    useAppStore.setState({ thumbnailsById: {} });
  });

  it("invalidateThumbnail drops the entry", () => {
    const id = makeId("abc-123");
    const key = jobIdKey(id);
    useAppStore.setState({ thumbnailsById: { [key]: "/cache/abc.png" } });
    expect(useAppStore.getState().thumbnailsById[key]).toBe("/cache/abc.png");

    useAppStore.getState().invalidateThumbnail(id);
    expect(useAppStore.getState().thumbnailsById[key]).toBeUndefined();
  });

  it("invalidateThumbnail on a missing entry is a no-op", () => {
    const id = makeId("missing-id");
    const before = useAppStore.getState().thumbnailsById;
    useAppStore.getState().invalidateThumbnail(id);
    // Same reference when nothing changed (action short-circuits)
    expect(useAppStore.getState().thumbnailsById).toBe(before);
  });

  it("invalidateThumbnail preserves other entries", () => {
    const keep = makeId("keep-id");
    const drop = makeId("drop-id");
    useAppStore.setState({
      thumbnailsById: {
        [jobIdKey(keep)]: "/cache/keep.png",
        [jobIdKey(drop)]: "/cache/drop.png",
      },
    });
    useAppStore.getState().invalidateThumbnail(drop);
    expect(useAppStore.getState().thumbnailsById[jobIdKey(keep)]).toBe("/cache/keep.png");
    expect(useAppStore.getState().thumbnailsById[jobIdKey(drop)]).toBeUndefined();
  });
});

describe("ui state", () => {
  beforeEach(() => {
    useAppStore.setState({
      ui: { queueCollapsed: false, queueSelectedIds: new Set(), doneToday: 0 },
    });
  });

  it("toggleQueueCollapsed flips the flag", () => {
    expect(useAppStore.getState().ui.queueCollapsed).toBe(false);
    useAppStore.getState().toggleQueueCollapsed();
    expect(useAppStore.getState().ui.queueCollapsed).toBe(true);
    useAppStore.getState().toggleQueueCollapsed();
    expect(useAppStore.getState().ui.queueCollapsed).toBe(false);
  });
});
