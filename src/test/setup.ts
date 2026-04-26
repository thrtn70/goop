// Vitest jsdom environment setup. Polyfills the few browser APIs that
// jsdom doesn't ship and our component dependencies require.

// cmdk uses ResizeObserver to track the listbox; jsdom doesn't implement it.
class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverPolyfill;
}

// cmdk calls scrollIntoView on the active item to keep it visible during
// keyboard navigation; jsdom's HTMLElement omits this method.
if (
  typeof Element !== "undefined" &&
  typeof (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView !== "function"
) {
  (Element.prototype as { scrollIntoView: () => void }).scrollIntoView = function () {
    /* no-op in jsdom */
  };
}
