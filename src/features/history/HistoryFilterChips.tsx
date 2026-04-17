import type { HistoryCounts, JobKind } from "@/types";
import { useAppStore } from "@/store/appStore";

interface ChipProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function Chip({ label, count, active, onClick }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`btn-press shrink-0 rounded-full px-3 py-1 text-xs font-medium transition duration-fast ease-out ${
        active
          ? "bg-accent text-accent-fg"
          : "bg-surface-2 text-fg-secondary hover:text-fg"
      }`}
    >
      {label} <span className="ml-1 tabular-nums opacity-70">{count}</span>
    </button>
  );
}

/**
 * Single-select filter chips for the History page. Clicking a chip sets
 * the kind filter; clicking "All" clears it.
 */
export default function HistoryFilterChips() {
  const counts = useAppStore((s) => s.history.counts);
  const kind = useAppStore((s) => s.history.kind);
  const setKind = useAppStore((s) => s.setHistoryKind);

  const c: HistoryCounts = counts ?? { all: 0, extract: 0, convert: 0, pdf: 0 };
  const select = (k: JobKind | null) => setKind(k);

  return (
    <div className="flex flex-wrap gap-1.5">
      <Chip label="All" count={c.all} active={kind === null} onClick={() => select(null)} />
      <Chip
        label="Extract"
        count={c.extract}
        active={kind === "extract"}
        onClick={() => select("extract")}
      />
      <Chip
        label="Convert"
        count={c.convert}
        active={kind === "convert"}
        onClick={() => select("convert")}
      />
      <Chip
        label="PDF"
        count={c.pdf}
        active={kind === "pdf"}
        onClick={() => select("pdf")}
      />
    </div>
  );
}
