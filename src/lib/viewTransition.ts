/**
 * Wrapper around `document.startViewTransition()` that no-ops when the
 * API is unavailable or when the user prefers reduced motion. Use it
 * to morph between two layouts that share an element identified by a
 * `view-transition-name` CSS property — see History card → preview.
 *
 * The callback runs synchronously regardless; if a transition is
 * actually animatable, the browser captures before/after snapshots
 * and tweens the matching `view-transition-name` pairs.
 */
function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Run `update` and, if supported, animate the visual diff between
 * before-and-after via the View Transitions API. Falls back to a
 * plain synchronous call when the API isn't available or the user
 * has reduced motion turned on.
 */
export function withViewTransition(update: () => void | Promise<void>): void {
  if (typeof document === "undefined") {
    void update();
    return;
  }
  const start = document.startViewTransition?.bind(document);
  if (!start || reducedMotion()) {
    void update();
    return;
  }
  start(() => Promise.resolve(update()));
}
