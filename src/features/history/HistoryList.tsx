import { ChevronDown, ChevronsUpDown, ChevronUp, Eye } from "lucide-react";
import type { HistorySort, Job, JobState } from "@/types";
import { jobIdKey, useAppStore } from "@/store/appStore";
import EmptyHistory from "@/features/history/EmptyHistory";

interface HistoryListProps {
  onPreview: (job: Job) => void;
  onQuickView: (job: Job) => void;
}

function basename(p: string | null): string {
  if (!p) return "—";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
}

function formatBytes(b: number | bigint | null | undefined): string {
  const n = b != null ? Number(b) : 0;
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function timeAgo(finished: bigint | null | undefined): string {
  if (finished == null) return "—";
  const then = Number(finished);
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function stateLabel(s: JobState): string {
  if (typeof s === "string") return s;
  return "error" in s ? "error" : "unknown";
}

function SortHeader({
  label,
  col,
  className = "",
}: {
  label: string;
  col: HistorySort;
  className?: string;
}) {
  const sort = useAppStore((s) => s.history.sort);
  const descending = useAppStore((s) => s.history.descending);
  const setHistorySort = useAppStore((s) => s.setHistorySort);
  const active = sort === col;
  return (
    <button
      type="button"
      onClick={() => setHistorySort(col)}
      className={`group flex items-center gap-1 text-left uppercase tracking-wide transition duration-fast ease-out hover:text-fg ${
        active ? "text-fg" : "text-fg-muted"
      } ${className}`}
    >
      {label}
      {active ? (
        descending ? (
          <ChevronDown size={12} strokeWidth={2.5} aria-hidden="true" />
        ) : (
          <ChevronUp size={12} strokeWidth={2.5} aria-hidden="true" />
        )
      ) : (
        <ChevronsUpDown
          size={12}
          strokeWidth={2.5}
          aria-hidden="true"
          className="opacity-0 transition-opacity duration-fast ease-out group-hover:opacity-60"
        />
      )}
    </button>
  );
}

/**
 * Table view of History. Rows are focusable (tabindex=0) so Space opens
 * Quick View. Click selects and opens the preview panel; checkbox toggles
 * the row's selection for batch actions.
 */
export default function HistoryList({ onPreview, onQuickView }: HistoryListProps) {
  const jobs = useAppStore((s) => s.history.jobs);
  const selectedIds = useAppStore((s) => s.history.selectedIds);
  const previewSelectedId = useAppStore((s) => s.history.previewSelectedId);
  const toggleSelection = useAppStore((s) => s.toggleHistorySelection);
  const search = useAppStore((s) => s.history.search);
  const kind = useAppStore((s) => s.history.kind);

  if (jobs.length === 0) {
    const filtersActive = search.trim() !== "" || kind !== null;
    return <EmptyHistory filtersActive={filtersActive} />;
  }

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] text-fg-muted">
            <th className="w-8 p-2 pl-6" />
            <th className="p-2 text-left">Type</th>
            <th className="p-2 text-left">
              <SortHeader label="Output" col="name" />
            </th>
            <th className="p-2 text-right">
              <SortHeader label="Size" col="size" className="justify-end" />
            </th>
            <th className="p-2 text-right">
              <SortHeader label="Date" col="date" className="justify-end" />
            </th>
            <th className="w-10 p-2 pr-6" />
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const key = jobIdKey(j.id);
            const selected = selectedIds.has(key);
            const previewing = previewSelectedId === key;
            return (
              <tr
                key={key}
                tabIndex={0}
                onClick={() => onPreview(j)}
                onKeyDown={(e) => {
                  if (e.key === " " || e.code === "Space") {
                    e.preventDefault();
                    onQuickView(j);
                  } else if (e.key === "Enter") {
                    onPreview(j);
                  }
                }}
                className={`cursor-pointer border-t border-subtle transition duration-fast ease-out hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                  previewing ? "bg-accent-subtle" : ""
                }`}
              >
                <td className="p-2 pl-6">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleSelection(j.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label="Select row"
                  />
                </td>
                <td className="p-2 text-xs text-fg-muted">{String(j.kind)}</td>
                <td className="p-2 truncate text-fg">
                  {basename(j.result?.output_path ?? null)}
                  {j.result?.result_kind === "folder" && j.result.file_count > 1 && (
                    <span className="ml-2 text-[10px] text-fg-muted">
                      ({j.result.file_count} files)
                    </span>
                  )}
                  {typeof j.state !== "string" && " error" in j.state && (
                    <span className="ml-2 text-[10px] uppercase text-error">{stateLabel(j.state)}</span>
                  )}
                </td>
                <td className="p-2 text-right tabular-nums text-xs text-fg-muted">
                  {formatBytes(j.result?.bytes)}
                </td>
                <td className="p-2 text-right text-xs text-fg-muted">
                  {timeAgo(j.finished_at)}
                </td>
                <td className="p-2 pr-6 text-right">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onQuickView(j);
                    }}
                    className="inline-flex items-center justify-center text-accent transition duration-fast ease-out hover:text-accent-hover"
                    aria-label="Quick view"
                    title="Quick View (Space)"
                  >
                    <Eye size={14} strokeWidth={2.5} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
