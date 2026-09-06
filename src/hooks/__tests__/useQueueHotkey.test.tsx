import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QUEUE_SHORTCUT, useQueueHotkey } from "@/hooks/useQueueHotkey";
import { useAppStore } from "@/store/appStore";

const platform = vi.hoisted(() => ({ isMac: true }));

vi.mock("@/lib/platform", () => ({
  isMacPlatform: () => platform.isMac,
}));

function HotkeyHost(): null {
  useQueueHotkey();
  return null;
}

function pressQueueShortcut(
  init: KeyboardEventInit,
  target: HTMLElement | Window = window,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "j",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function expectCollapsed(value: boolean): void {
  expect(useAppStore.getState().ui.queueCollapsed).toBe(value);
}

beforeEach(() => {
  platform.isMac = true;
  useAppStore.setState((state) => ({
    ui: { ...state.ui, queueCollapsed: true },
  }));
});

afterEach(() => {
  cleanup();
});

describe("useQueueHotkey", () => {
  it("toggles once for Cmd+J on macOS", () => {
    render(<HotkeyHost />);

    const event = pressQueueShortcut({ metaKey: true });

    expectCollapsed(false);
    expect(event.defaultPrevented).toBe(true);
    expect(QUEUE_SHORTCUT.label()).toBe("⌘J");
  });

  it("toggles once for Ctrl+J on Windows", () => {
    platform.isMac = false;
    render(<HotkeyHost />);

    const event = pressQueueShortcut({ ctrlKey: true });

    expectCollapsed(false);
    expect(event.defaultPrevented).toBe(true);
    expect(QUEUE_SHORTCUT.label()).toBe("Ctrl+J");
  });

  it.each([
    ["Shift", { metaKey: true, shiftKey: true }],
    ["Alt", { metaKey: true, altKey: true }],
    ["Ctrl", { metaKey: true, ctrlKey: true }],
    ["the Windows modifier", { ctrlKey: true }],
  ])("ignores Cmd+J with %s on macOS", (_name, init) => {
    render(<HotkeyHost />);

    const event = pressQueueShortcut(init);

    expectCollapsed(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it.each([
    ["Shift", { ctrlKey: true, shiftKey: true }],
    ["Alt", { ctrlKey: true, altKey: true }],
    ["Meta", { ctrlKey: true, metaKey: true }],
    ["the macOS modifier", { metaKey: true }],
  ])("ignores Ctrl+J with %s on Windows", (_name, init) => {
    platform.isMac = false;
    render(<HotkeyHost />);

    const event = pressQueueShortcut(init);

    expectCollapsed(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores repeated and unrelated keydowns", () => {
    render(<HotkeyHost />);

    const repeated = pressQueueShortcut({ metaKey: true, repeat: true });
    const unrelated = pressQueueShortcut({ key: "k", metaKey: true });

    expectCollapsed(true);
    expect(repeated.defaultPrevented).toBe(false);
    expect(unrelated.defaultPrevented).toBe(false);
  });

  it.each([
    ["input", () => document.createElement("input")],
    ["textarea", () => document.createElement("textarea")],
    ["select", () => document.createElement("select")],
    ["contenteditable", () => {
      const editable = document.createElement("div");
      editable.setAttribute("contenteditable", "true");
      return editable;
    }],
  ])("ignores the shortcut from a %s", (_name, createTarget) => {
    render(<HotkeyHost />);
    const target = createTarget();
    document.body.appendChild(target);

    const event = pressQueueShortcut({ metaKey: true }, target);

    expectCollapsed(true);
    expect(event.defaultPrevented).toBe(false);
    target.remove();
  });
});
