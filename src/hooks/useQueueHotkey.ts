import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";

/**
 * Global hotkey: Cmd/Ctrl + Shift + Q toggles the QueueSidebar collapse
 * state. Registers at mount, cleans up at unmount. Ignores keydowns
 * originating from form controls so users typing in inputs aren't
 * interrupted.
 */
export function useQueueHotkey(): void {
  const toggleQueueCollapsed = useAppStore((s) => s.toggleQueueCollapsed);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key.toLowerCase() !== "q") return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      e.preventDefault();
      toggleQueueCollapsed();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleQueueCollapsed]);
}
