import { useEffect } from "react";
import { isMacPlatform } from "@/lib/platform";
import { useAppStore } from "@/store/appStore";

type QueueShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "repeat" | "shiftKey"
>;

/** Shared keyboard binding used by the handler and every visible hint. */
export const QUEUE_SHORTCUT = {
  key: "j",
  label(isMac = isMacPlatform()): string {
    return `${isMac ? "⌘" : "Ctrl+"}${this.key.toUpperCase()}`;
  },
  matches(event: QueueShortcutEvent, isMac = isMacPlatform()): boolean {
    const hasPlatformModifier = isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;

    return (
      !event.repeat &&
      hasPlatformModifier &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === this.key
    );
  },
} as const;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;

  const editableRoot = target.closest("[contenteditable]");
  return (
    target.isContentEditable ||
    (editableRoot !== null &&
      editableRoot.getAttribute("contenteditable")?.toLowerCase() !== "false")
  );
}

/**
 * Cmd+J on macOS and Ctrl+J on Windows toggle the queue sidebar. The
 * listener ignores editable targets, repeated keydowns, and extra modifiers.
 */
export function useQueueHotkey(): void {
  const toggleQueueCollapsed = useAppStore((s) => s.toggleQueueCollapsed);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!QUEUE_SHORTCUT.matches(e) || isEditableTarget(e.target)) return;
      e.preventDefault();
      toggleQueueCollapsed();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleQueueCollapsed]);
}
