import { describe, expect, it } from "vitest";
import { useAppStore } from "@/store/appStore";

describe("player collapse", () => {
  it("starts expanded", () => {
    expect(useAppStore.getInitialState().ui.playerCollapsed).toBe(false);
  });

  it("togglePlayerCollapsed flips the flag and leaves the rest of ui alone", () => {
    const before = useAppStore.getState().ui;
    useAppStore.getState().togglePlayerCollapsed();
    const collapsed = useAppStore.getState().ui;
    expect(collapsed.playerCollapsed).toBe(!before.playerCollapsed);
    expect(collapsed.queueCollapsed).toBe(before.queueCollapsed);
    expect(collapsed.queueSelectedIds).toBe(before.queueSelectedIds);
    expect(collapsed).not.toBe(before);
    useAppStore.getState().togglePlayerCollapsed();
    expect(useAppStore.getState().ui.playerCollapsed).toBe(before.playerCollapsed);
  });
});
