import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { convertFileSrc } from "@tauri-apps/api/core";
import { GripVertical, RotateCw, RotateCcw, X } from "lucide-react";
import type { RotationDegrees } from "@/types";

export type PageCardMode = "reorder" | "delete" | "rotate";

export interface PageState {
  /** Original 1-indexed page number from the input PDF. Stable across
   *  reorders — drag changes the array position, not the originalPage. */
  originalPage: number;
  /** Absolute file path to the rendered thumbnail PNG. Null when
   *  thumbnails are unavailable (mutool failure, in-flight load); the
   *  card falls back to a numbered placeholder. */
  thumbPath: string | null;
  /** Reorder + delete state. Reorder doesn't toggle this; delete does. */
  deleted: boolean;
  /** Per-card composed rotation. None means no change vs original. */
  rotation: RotationDegrees | null;
}

interface PdfPageCardProps {
  state: PageState;
  mode: PageCardMode;
  onChange: (next: PageState) => void;
}

export default function PdfPageCard({ state, mode, onChange }: PdfPageCardProps) {
  const id = `page-${state.originalPage}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : state.deleted ? 0.35 : 1,
  };
  const thumbSrc = state.thumbPath ? convertFileSrc(state.thumbPath) : null;

  function rotateCw() {
    onChange({ ...state, rotation: composeRotation(state.rotation, 90) });
  }
  function rotateCcw() {
    onChange({ ...state, rotation: composeRotation(state.rotation, 270) });
  }
  function toggleDeleted() {
    onChange({ ...state, deleted: !state.deleted });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative flex flex-col overflow-hidden rounded-lg border text-xs ${
        state.deleted
          ? "border-error/40 bg-error-subtle"
          : "border-subtle bg-surface-1"
      }`}
    >
      {/* Drag handle — only the handle starts a drag, so the per-card
          buttons stay clickable. The card body shows the thumbnail. */}
      <div className="relative aspect-[3/4] w-full bg-surface-2">
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt={`Page ${state.originalPage}`}
            className="h-full w-full object-contain"
            style={
              state.rotation
                ? { transform: `rotate(${degForRotation(state.rotation)}deg)` }
                : undefined
            }
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center font-display text-lg text-fg-muted">
            {state.originalPage}
          </div>
        )}
        {mode === "reorder" && (
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Drag page ${state.originalPage}`}
            className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 cursor-grab items-center justify-center rounded-md bg-surface-1/85 text-fg-muted opacity-0 transition duration-fast ease-out group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <GripVertical size={14} strokeWidth={2.5} aria-hidden="true" />
          </button>
        )}
        {mode === "delete" && (
          <button
            type="button"
            onClick={toggleDeleted}
            aria-label={
              state.deleted
                ? `Restore page ${state.originalPage}`
                : `Delete page ${state.originalPage}`
            }
            aria-pressed={state.deleted}
            className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-surface-1/85 text-fg-muted hover:text-error focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <X size={14} strokeWidth={2.5} aria-hidden="true" />
          </button>
        )}
        {mode === "rotate" && (
          <div className="absolute right-1.5 top-1.5 flex gap-1">
            <button
              type="button"
              onClick={rotateCcw}
              aria-label={`Rotate page ${state.originalPage} counter-clockwise`}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-surface-1/85 text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <RotateCcw size={14} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={rotateCw}
              aria-label={`Rotate page ${state.originalPage} clockwise`}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-surface-1/85 text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <RotateCw size={14} strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between px-2 py-1.5 text-fg-muted">
        <span className="tabular-nums">Page {state.originalPage}</span>
        {state.rotation && (
          <span className="text-accent">{degForRotation(state.rotation)}°</span>
        )}
      </div>
    </div>
  );
}

function degForRotation(r: RotationDegrees): number {
  switch (r) {
    case "cw90":
      return 90;
    case "cw180":
      return 180;
    case "cw270":
      return 270;
  }
}

function composeRotation(
  current: RotationDegrees | null,
  addDeg: 90 | 180 | 270,
): RotationDegrees | null {
  const start = current ? degForRotation(current) : 0;
  const next = (start + addDeg) % 360;
  if (next === 0) return null;
  if (next === 90) return "cw90";
  if (next === 180) return "cw180";
  return "cw270";
}
