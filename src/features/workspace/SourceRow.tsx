import { useId } from "react";
import { File, X } from "lucide-react";
import type { ProbeState } from "@/hooks/useProbe";
import type { BatchState } from "./batchStamp";
import {
  claimResponsivenessAction,
  expectsResponsivenessAction,
  recordResponsivenessHandlerEnd,
  recordResponsivenessHandlerStart,
} from "@/performance/responsivenessRuntime";

export type SourceRowResponsivenessAction = {
  actionId: number;
  kind: "select" | "remove";
  sourceId: string;
};
export function sourceName(path: string) {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}
export default function SourceRow({
  path,
  sourceId,
  selected,
  state,
  problem,
  edited,
  summary,
  batchState,
  onSelect,
  onRemove,
  onRetry,
  onResponsivenessAction,
}: {
  path: string;
  sourceId?: string;
  selected: boolean;
  state: ProbeState;
  problem: string | null;
  edited?: boolean;
  /** What the row will become, e.g. "→ JPEG · Quality 80". */
  summary?: string | null;
  batchState?: BatchState;
  onSelect: () => void;
  onRemove: () => void;
  onRetry: () => void;
  onResponsivenessAction?: (action: SourceRowResponsivenessAction) => void;
}) {
  // The select button's aria-label replaces its content, so the probe facts,
  // tag and settings line are attached as its description instead.
  const factsId = useId();
  const summaryId = useId();
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
  const runAction = (
    kind: SourceRowResponsivenessAction["kind"],
    trusted: boolean,
    handler: () => void,
  ) => {
    const name = sourceName(path);
    const accessibleName = `${kind === "select" ? "Select" : "Remove"} ${name}`;
    const actionId = sourceId && expectsResponsivenessAction({ eventType: "click", targetRole: "button", accessibleName })
      ? claimResponsivenessAction({
          eventType: "click",
          targetRole: "button",
          accessibleName,
          trusted,
          priorValue: kind === "select" ? String(selected) : "present",
        })
      : null;
    if (actionId !== null) recordResponsivenessHandlerStart(actionId);
    try {
      handler();
    } finally {
      if (actionId !== null) {
        recordResponsivenessHandlerEnd(actionId);
        onResponsivenessAction?.({ actionId, kind, sourceId: sourceId! });
      }
    }
  };
  return (
    <li
      className={`border-b border-subtle px-3 py-3 ${selected ? "bg-accent-subtle" : "hover:bg-surface-1"}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          aria-label={`Select ${sourceName(path)}`}
          aria-pressed={selected}
          aria-describedby={summary ? `${factsId} ${summaryId}` : factsId}
          data-responsiveness-role={sourceId ? "button" : undefined}
          data-responsiveness-name={sourceId ? `Select ${sourceName(path)}` : undefined}
          onClick={(event) => runAction("select", event.nativeEvent.isTrusted, onSelect)}
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
            <span id={factsId} className="block text-xs text-fg-secondary">
              {metadata ??
                (state.phase === "probing"
                  ? "Inspecting source…"
                  : "Inspection failed")}
            </span>
            {summary && (
              <span id={summaryId} className="mt-1 flex min-w-0 items-center gap-2 text-xs text-fg-secondary">
                {batchState && (
                  <span className={batchState === "batch"
                    ? "shrink-0 rounded-full border border-accent/45 bg-accent-subtle px-1.5 font-semibold text-accent"
                    : "shrink-0 rounded-full border bg-surface-2 px-1.5 font-semibold text-fg-secondary"}>
                    {batchState === "batch" ? "Batch" : "Edited"}
                  </span>
                )}
                <span className="truncate" title={summary}>{summary}</span>
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          aria-label={`Remove ${sourceName(path)}`}
          data-responsiveness-role={sourceId ? "button" : undefined}
          data-responsiveness-name={sourceId ? `Remove ${sourceName(path)}` : undefined}
          onClick={(event) => runAction("remove", event.nativeEvent.isTrusted, onRemove)}
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
