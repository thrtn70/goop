import { resetExtractSession } from "@/store/extractSession";
beforeEach(resetExtractSession);
import { afterEach, beforeEach, expect } from "vitest";
import { resetWorkspaceDrafts, subscribeWorkspaceDraftEntries } from "@/store/workspaceDrafts";
import { admitDraftEntries } from "@/store/workspacePersistence";
beforeEach(resetWorkspaceDrafts);
// Every draft a feature writes during a test must be one a strict restart
// restores. Recorded on each change, so a test file's own reset cannot hide
// one. Slots named "test." exist only in tests. Tests that load a fresh store
// with vi.resetModules are outside this check.
const refusedDrafts = new Set<string>();
subscribeWorkspaceDraftEntries(entries => {
  for (const key of admitDraftEntries(entries).skipped) {
    if (!String((JSON.parse(key) as unknown[]).at(-1)).startsWith("test.")) refusedDrafts.add(key);
  }
});
beforeEach(() => { refusedDrafts.clear(); });
afterEach(() => { expect([...refusedDrafts], "drafts a strict restart would refuse").toEqual([]); });

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
