import { useEffect, useState } from "react";
import { useAppStore } from "@/store/appStore";
import HistoryFilterChips from "./HistoryFilterChips";

const SEARCH_DEBOUNCE_MS = 150;

/**
 * Sticky toolbar at the top of History: search input, filter chips, and
 * the List/Grid view toggle. Search is debounced to avoid spamming
 * history_list over IPC on each keystroke.
 */
export default function HistoryToolbar() {
  const liveSearch = useAppStore((s) => s.history.search);
  const viewMode = useAppStore((s) => s.history.viewMode);
  const setSearch = useAppStore((s) => s.setHistorySearch);
  const toggleViewMode = useAppStore((s) => s.toggleHistoryViewMode);

  const [draft, setDraft] = useState(liveSearch);
  useEffect(() => {
    setDraft(liveSearch);
  }, [liveSearch]);

  useEffect(() => {
    if (draft === liveSearch) return;
    const handle = setTimeout(() => setSearch(draft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [draft, liveSearch, setSearch]);

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-subtle bg-surface-0 px-6 py-3">
      <input
        type="search"
        aria-label="Search history by filename"
        placeholder="Search by filename..."
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="min-w-[220px] max-w-xs flex-1 rounded-md bg-surface-2 px-3 py-1.5 text-sm text-fg transition duration-fast ease-out placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent"
      />
      <HistoryFilterChips />
      <div className="ml-auto flex gap-1 rounded-md bg-surface-2 p-1" role="group" aria-label="View mode">
        <button
          type="button"
          onClick={() => {
            if (viewMode !== "list") void toggleViewMode();
          }}
          aria-pressed={viewMode === "list"}
          className={`rounded px-2 py-1 text-xs transition duration-fast ease-out ${
            viewMode === "list" ? "bg-surface-1 text-fg" : "text-fg-muted hover:text-fg"
          }`}
        >
          ☰ List
        </button>
        <button
          type="button"
          onClick={() => {
            if (viewMode !== "grid") void toggleViewMode();
          }}
          aria-pressed={viewMode === "grid"}
          className={`rounded px-2 py-1 text-xs transition duration-fast ease-out ${
            viewMode === "grid" ? "bg-surface-1 text-fg" : "text-fg-muted hover:text-fg"
          }`}
        >
          ⊞ Grid
        </button>
      </div>
    </div>
  );
}
