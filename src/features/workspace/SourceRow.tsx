import { File, X } from "lucide-react";
import type { ProbeState } from "@/hooks/useProbe";
export function sourceName(path: string) {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}
export default function SourceRow({
  path,
  selected,
  state,
  problem,
  edited,
  onSelect,
  onRemove,
  onRetry,
}: {
  path: string;
  selected: boolean;
  state: ProbeState;
  problem: string | null;
  edited?: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const p = state.phase === "ready" ? state.probe : null;
  const metadata = p
    ? [
        p.image_format ?? p.video_codec ?? p.audio_codec,
        p.width && p.height ? `${p.width} × ${p.height}` : null,
        Number(p.file_size)
          ? `${(Number(p.file_size) / 1048576).toFixed(1)} MB`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  return (
    <li
      className={`border-b border-subtle px-3 py-3 ${selected ? "bg-accent-subtle" : "hover:bg-surface-1"}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          aria-label={`Select ${sourceName(path)}`}
          aria-pressed={selected}
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-3 rounded text-left focus-visible:outline-accent"
        >
          <File
            size={24}
            aria-hidden="true"
            className="shrink-0 text-fg-secondary"
          />
          <span className="min-w-0">
            <span
              className="block truncate text-sm font-medium text-fg"
              title={path}
            >
              {sourceName(path)}
            </span>
            <span className="block text-xs text-fg-secondary">
              {metadata ??
                (state.phase === "probing"
                  ? "Inspecting source…"
                  : "Inspection failed")}
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-label={`Remove ${sourceName(path)}`}
          onClick={onRemove}
          className="rounded p-2 text-fg-secondary hover:text-error"
        >
          <X size={16} aria-hidden="true" />
          <span className="sr-only">Remove</span>
        </button>
      </div>
      {problem && <p className="mt-2 text-xs text-warning">{problem}</p>}
      {edited && (
        <p className="mt-2 text-xs text-fg-secondary">
          Earlier settings queued. Your newer edits are kept here.
        </p>
      )}
      {state.phase === "error" && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-xs text-accent underline"
        >
          Try again
        </button>
      )}
    </li>
  );
}
