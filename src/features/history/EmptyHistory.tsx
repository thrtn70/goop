import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/store/appStore";

interface EmptyHistoryProps {
  /** True when search / kind filter is active and could be cleared. */
  filtersActive: boolean;
}

/**
 * Two distinct empty states for History:
 *
 * - **First run** (no filters, zero finished jobs): an invitation
 *   to do anything. Short brand-voiced copy plus two routing chips
 *   that take the user to the most likely starting actions.
 * - **Filter empty** (at least one filter set, results filtered to
 *   zero): explain what's filtered and offer a one-click clear.
 *
 * Same outer dimensions both ways so toggling between the two doesn't
 * jolt the surrounding layout.
 */
export default function EmptyHistory({ filtersActive }: EmptyHistoryProps) {
  const nav = useNavigate();
  const clearFilters = useAppStore((s) => s.clearHistoryFilters);

  if (filtersActive) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
        <p className="text-sm text-fg-secondary">
          No finished jobs match those filters.
        </p>
        <button
          type="button"
          onClick={clearFilters}
          className="btn-press mt-3 rounded-md px-3 py-1.5 text-xs text-accent transition duration-fast ease-out hover:bg-accent-subtle hover:text-accent-hover"
        >
          Clear filters
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <Stamp />
      <p className="mt-5 font-display text-base font-semibold text-fg">
        Nothing finished yet.
      </p>
      <p className="mt-1.5 max-w-sm text-sm text-fg-secondary">
        Your downloads, conversions, and PDF jobs will land here as they
        complete — searchable, sortable, and easy to delete.
      </p>
      <div className="mt-5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => nav("/extract")}
          className="btn-press rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
        >
          Paste a link
        </button>
        <button
          type="button"
          onClick={() => nav("/convert")}
          className="btn-press rounded-md border border-subtle bg-surface-1 px-3 py-1.5 text-xs font-medium text-fg-secondary transition duration-fast ease-out hover:border-accent hover:text-accent"
        >
          Convert a file
        </button>
      </div>
    </div>
  );
}

/**
 * A small, abstract "stamp" graphic — three horizontal bars of
 * varying length suggesting a list/log entry. Subtle, on-brand,
 * not literal.
 */
function Stamp() {
  return (
    <svg
      width="72"
      height="56"
      viewBox="0 0 72 56"
      fill="none"
      role="presentation"
      aria-hidden
    >
      <rect
        x="2"
        y="6"
        width="68"
        height="44"
        rx="8"
        fill="oklch(var(--surface-2))"
        stroke="oklch(var(--border))"
        strokeWidth="1.5"
      />
      <rect x="14" y="18" width="44" height="3" rx="1.5" fill="oklch(var(--accent) / 0.65)" />
      <rect x="14" y="26" width="32" height="3" rx="1.5" fill="oklch(var(--fg-muted))" />
      <rect x="14" y="34" width="38" height="3" rx="1.5" fill="oklch(var(--fg-muted))" />
    </svg>
  );
}
