import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "a[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Keeps Tab inside `container`: wraps from the last control to the first and back, and pulls focus
 * in when the container itself (tabIndex -1) holds it. Call from the container's onKeyDown.
 */
export function trapTab(event: ReactKeyboardEvent<HTMLElement>, container: HTMLElement): void {
  if (event.key !== "Tab") return;
  const controls = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  if (controls.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  const active = document.activeElement;
  if (active === container || (event.shiftKey && active === first)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
