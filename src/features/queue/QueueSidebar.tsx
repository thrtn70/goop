import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { JobId, JobState } from "@/types";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { jobIdKey, useAppStore } from "@/store/appStore";
import QueueRow from "./QueueRow";
import SortableQueueRow from "./SortableQueueRow";

const MIN_WIDTH = 240;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 288;

function clampWidth(w: number): number {
  if (w < MIN_WIDTH) return MIN_WIDTH;
  if (w > MAX_WIDTH) return MAX_WIDTH;
  return Math.round(w);
}

/** Active = running or paused. Paused is in-flight (semaphore slot held)
 *  and the user can resume from this group. */
function isActive(s: JobState): boolean {
  return typeof s === "string" && (s === "running" || s === "paused");
}

function isQueued(s: JobState): boolean {
  return typeof s === "string" && s === "queued";
}

function isTerminal(s: JobState): boolean {
  if (typeof s === "string") return s === "done" || s === "cancelled";
  return "error" in s;
}

function formatEta(secs: number | null): string {
  if (secs == null || !Number.isFinite(secs) || secs <= 0) return "";
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export default function QueueSidebar() {
  const jobs = useAppStore((s) => s.jobs);
  const unseen = useAppStore((s) => s.unseenCompletions);
  const clearUnseen = useAppStore((s) => s.clearUnseen);
  const collapsed = useAppStore((s) => s.ui.queueCollapsed);
  const toggleCollapsed = useAppStore((s) => s.toggleQueueCollapsed);
  const persistedWidth = useAppStore((s) => s.settings?.queue_sidebar_width ?? DEFAULT_WIDTH);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const selectedIds = useAppStore((s) => s.ui.queueSelectedIds);
  const doneToday = useAppStore((s) => s.ui.doneToday);
  const reorderQueue = useAppStore((s) => s.reorderQueue);
  const cancelSelectedQueue = useAppStore((s) => s.cancelSelectedQueue);
  const clearQueueSelection = useAppStore((s) => s.clearQueueSelection);
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const progressById = useAppStore((s) => s.progressById);
  const [width, setWidth] = useState<number>(persistedWidth);
  const dragStartRef = useRef<{ x: number; w: number } | null>(null);
  // When non-null, the user has clicked "Cancel selected" once and is
  // looking at a confirm prompt. The number is the count being confirmed
  // — if the selection changes (add/remove), the confirm resets so we
  // don't act on a stale count.
  const [confirmingCount, setConfirmingCount] = useState<number | null>(null);

  useEffect(() => {
    if (dragStartRef.current === null) setWidth(persistedWidth);
  }, [persistedWidth]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragStart(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault();
    dragStartRef.current = { x: e.clientX, w: width };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function onDragMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (!dragStartRef.current) return;
    const delta = dragStartRef.current.x - e.clientX;
    setWidth(clampWidth(dragStartRef.current.w + delta));
  }

  function onDragEnd(e: React.PointerEvent<HTMLDivElement>): void {
    if (!dragStartRef.current) return;
    const finalWidth = clampWidth(width);
    dragStartRef.current = null;
    (e.target as Element).releasePointerCapture(e.pointerId);
    if (finalWidth !== persistedWidth) {
      void patchSettings({ queue_sidebar_width: finalWidth }).catch(() => {
        /* persistence is best-effort; the width still updates locally */
      });
    }
  }

  async function handleClearCompleted(): Promise<void> {
    try {
      await api.queue.clearCompleted();
      await useAppStore.getState().loadAll();
    } catch {
      /* ignore transient errors */
    }
  }

  function handleSortEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const queuedIds: string[] = queued.map((j) => jobIdKey(j.id));
    const oldIdx = queuedIds.indexOf(String(active.id));
    const newIdx = queuedIds.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const ordered = arrayMove(queuedIds, oldIdx, newIdx);
    const idMap = new Map(queued.map((j) => [jobIdKey(j.id), j.id]));
    const orderedJobIds: JobId[] = ordered
      .map((k) => idMap.get(k))
      .filter((v): v is JobId => v !== undefined);
    void reorderQueue(orderedJobIds);
  }

  const active = jobs.filter((j) => isActive(j.state));
  const queued = jobs.filter((j) => isQueued(j.state));
  const done = jobs.filter((j) => isTerminal(j.state));
  const activeCount = active.length + queued.length;
  const selectedQueuedCount = queued.filter((j) =>
    selectedIds.has(jobIdKey(j.id)),
  ).length;

  useEffect(() => {
    if (confirmingCount !== null && selectedQueuedCount !== confirmingCount) {
      setConfirmingCount(null);
    }
  }, [confirmingCount, selectedQueuedCount]);

  // Escape dismisses the destructive confirm — matches the pattern users
  // expect from confirm prompts elsewhere in the app.
  useEffect(() => {
    if (confirmingCount === null) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        setConfirmingCount(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmingCount]);

  async function handleConfirmCancel(): Promise<void> {
    setConfirmingCount(null);
    try {
      await cancelSelectedQueue();
    } catch (err) {
      enqueueToast({
        variant: "error",
        title: "Couldn't cancel selection",
        detail: formatError(err),
      });
    }
  }

  // Sum ETAs for in-flight jobs. Paused jobs have no meaningful ETA so
  // they're excluded; queued unknowns also not included.
  const totalEtaSecs = active.reduce((sum, j) => {
    if (j.state === "paused") return sum;
    const e = progressById[jobIdKey(j.id)]?.eta_secs ?? 0;
    return sum + (e > 0 ? e : 0);
  }, 0);

  if (collapsed) {
    return (
      <aside
        className="flex w-10 shrink-0 flex-col items-center gap-2 border-l border-subtle bg-surface-1 py-3 transition-[width] duration-normal ease-out"
        aria-label="Job queue (collapsed)"
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Expand queue sidebar"
          title="Expand queue (⌘⇧Q)"
          className="btn-press flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition duration-fast ease-out hover:bg-surface-2 hover:text-fg"
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="10,4 4,8 10,12" />
          </svg>
        </button>
        {activeCount > 0 && (
          <span
            aria-label={`${activeCount} active job${activeCount !== 1 ? "s" : ""}`}
            className="flex min-w-[1.25rem] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg"
          >
            {activeCount > 99 ? "99+" : activeCount}
          </span>
        )}
      </aside>
    );
  }

  return (
    <aside
      className="relative shrink-0 overflow-auto border-l border-subtle bg-surface-1 p-3"
      style={{ width: `${width}px` }}
      aria-label="Job queue"
    >
      <div
        role="separator"
        aria-label="Resize queue sidebar"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        aria-orientation="vertical"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className="absolute left-0 top-0 h-full w-1 select-none bg-transparent transition-colors duration-fast ease-out hover:bg-accent/40"
      />
      <div className="flex w-full items-center gap-2">
        <h3
          aria-live="polite"
          aria-atomic="true"
          className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted"
        >
          Queue ({activeCount})
        </h3>
        {unseen > 0 && (
          <button
            type="button"
            onClick={() => clearUnseen()}
            aria-label={`${unseen} new completion${unseen !== 1 ? "s" : ""}, click to clear`}
            className="btn-press inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
          >
            {unseen > 99 ? "99+" : unseen}
          </button>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Collapse queue sidebar"
          title="Collapse queue (⌘⇧Q)"
          className="btn-press ml-auto flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition duration-fast ease-out hover:bg-surface-2 hover:text-fg"
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6,4 12,8 6,12" />
          </svg>
        </button>
      </div>

      {(activeCount > 0 || doneToday > 0) && (
        <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-fg-muted">
          <span>
            {totalEtaSecs > 0 ? `~${formatEta(totalEtaSecs)} remaining` : ""}
          </span>
          <span>{doneToday > 0 ? `${doneToday} done today` : ""}</span>
        </div>
      )}

      {selectedQueuedCount > 0 && (
        <div
          className="mt-2 flex items-center justify-between rounded-md bg-accent-subtle px-2 py-1 text-xs text-accent"
          aria-live="polite"
          aria-atomic="true"
        >
          {confirmingCount !== null ? (
            <>
              <span>
                Cancel {confirmingCount} job{confirmingCount !== 1 ? "s" : ""}?
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleConfirmCancel()}
                  className="btn-press rounded px-1.5 py-0.5 text-error hover:bg-error-subtle"
                >
                  Yes, cancel
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingCount(null)}
                  className="btn-press rounded px-1.5 py-0.5 text-fg-secondary hover:bg-surface-3 hover:text-fg"
                >
                  No
                </button>
              </div>
            </>
          ) : (
            <>
              <span>
                {selectedQueuedCount} selected
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingCount(selectedQueuedCount)}
                  className="btn-press rounded px-1.5 py-0.5 hover:bg-error-subtle hover:text-error"
                >
                  Cancel selected
                </button>
                <button
                  type="button"
                  onClick={() => clearQueueSelection()}
                  className="text-fg-muted hover:text-fg"
                  aria-label="Clear selection"
                >
                  ✕
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="mt-2 space-y-1">
        {active.map((j, i) => (
          <QueueRow key={jobIdKey(j.id)} job={j} index={i} />
        ))}
      </div>
      {queued.length > 0 && (
        <DndContext sensors={sensors} onDragEnd={handleSortEnd}>
          <SortableContext
            items={queued.map((j) => jobIdKey(j.id))}
            strategy={verticalListSortingStrategy}
          >
            <div className="mt-1 space-y-1">
              {queued.map((j, i) => (
                <SortableQueueRow key={jobIdKey(j.id)} job={j} index={i + active.length} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      {done.length > 0 && (
        <>
          <div className="mt-6 flex items-center justify-between">
            <h3 className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Done ({done.length})
            </h3>
            <button
              type="button"
              className="btn-press text-xs text-fg-muted transition duration-fast ease-out hover:text-fg"
              onClick={() => void handleClearCompleted()}
            >
              clear
            </button>
          </div>
          <div className="mt-2 space-y-1">
            {done.map((j, i) => (
              <QueueRow key={jobIdKey(j.id)} job={j} index={i} />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
