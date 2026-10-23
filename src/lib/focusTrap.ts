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
 * Marks a focus guard (leading or trailing) inside the container: it catches focus that Tab carried past
 * an end and hands it back, so it is never a stop of its own and the trap leaves it out of the control list.
 */
export const FOCUS_SENTINEL_ATTR = "data-focus-sentinel";

/**
 * A media element with native controls owns the Tab stops after it: the browser puts its controls in the
 * tab order right behind the host, and while one of them has focus the active element reads as the host.
 */
const hasNativeControls = (element: Element): boolean => element instanceof HTMLMediaElement && element.controls;

/** Whether a focus guard sits after `element` in the container, ready to catch focus that Tab carries past it. */
const guardFollows = (container: HTMLElement, element: Element): boolean =>
  Array.from(container.querySelectorAll(`[${FOCUS_SENTINEL_ATTR}]`)).some(
    (guard) => element.compareDocumentPosition(guard) & Node.DOCUMENT_POSITION_FOLLOWING,
  );

/**
 * Keeps Tab inside `container`: wraps from the last control to the first and back, and pulls focus
 * in when the container itself (tabIndex -1) holds it. Call from the container's onKeyDown.
 * A forward Tab from a last control that is a media element with native controls is left to the browser
 * so it can reach those controls, but only when a FOCUS_SENTINEL_ATTR element follows it to catch the
 * focus afterwards; without one the Tab wraps as usual, so focus can never leave the container.
 */
export function trapTab(event: ReactKeyboardEvent<HTMLElement>, container: HTMLElement): void {
  if (event.key !== "Tab") return;
  const controls = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (control) => !control.hasAttribute(FOCUS_SENTINEL_ATTR),
  );
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
  } else if (!event.shiftKey && active === last && !(hasNativeControls(last) && guardFollows(container, last))) {
    event.preventDefault();
    first.focus();
  }
}
