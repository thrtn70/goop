import { useEffect, useId, useRef, useState } from "react";
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
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { modKeyLabel } from "@/lib/platform";
import { formatError } from "@/ipc/error";
import { jobIdKey, useAppStore } from "@/store/appStore";
import QueueRow from "./QueueRow";
import SortableQueueRow from "./SortableQueueRow";

/** Active = running or paused. Paused rows stay in this group so the
 *  user can resume them; whether the job still holds its concurrency
 *  slot while paused depends on the kind (suspended children do,
 *  gracefully-stopped downloads don't). */
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
  const selectedIds = useAppStore((s) => s.ui.queueSelectedIds);
  const doneToday = useAppStore((s) => s.ui.doneToday);
  const reorderQueue = useAppStore((s) => s.reorderQueue);
  const cancelSelectedQueue = useAppStore((s) => s.cancelSelectedQueue);
  const clearQueueSelection = useAppStore((s) => s.clearQueueSelection);
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const progressById = useAppStore((s) => s.progressById);
  const [preferredHeight, setPreferredHeight] = useState(240);
  const [availableHeight, setAvailableHeight] = useState(() => window.innerHeight - 48);
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const contentFocused = useRef(false);
  const contentId = useId();
  const dragStartRef = useRef<{ y: number; height: number; preferred: number } | null>(null);
  const maxHeight = Math.max(40, Math.min(360, Math.floor(availableHeight * 0.45)));
  const minHeight = Math.min(160, maxHeight);
  const clampHeight = (height: number) => Math.round(Math.max(minHeight, Math.min(maxHeight, height)));
  const height = clampHeight(preferredHeight);
  // When non-null, the user has clicked "Cancel selected" once and is
  // looking at a confirm prompt. The number is the count being confirmed
  // — if the selection changes (add/remove), the confirm resets so we
  // don't act on a stale count.
  const [confirmingCount, setConfirmingCount] = useState<number | null>(null);

  useEffect(() => {
    const parent = panelRef.current?.parentElement;
    function measure() {
      setAvailableHeight(parent?.getBoundingClientRect().height || window.innerHeight - 48);
    }
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (parent) observer?.observe(parent);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  useEffect(() => {
    if (collapsed && dragStartRef.current) {
      setPreferredHeight(dragStartRef.current.preferred);
      dragStartRef.current = null;
    }
    if (collapsed && contentFocused.current) {
      toggleRef.current?.focus();
      contentFocused.current = false;
    }
  }, [collapsed]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragStart(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault();
    dragStartRef.current = { y: e.clientY, height, preferred: preferredHeight };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onDragMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (!dragStartRef.current) return;
    setPreferredHeight(clampHeight(dragStartRef.current.height + dragStartRef.current.y - e.clientY));
  }

  function onDragEnd(e: React.PointerEvent<HTMLDivElement>): void {
    if (!dragStartRef.current) return;
    if (e.type !== "pointerup") setPreferredHeight(dragStartRef.current.preferred);
    dragStartRef.current = null;
    if (e.type !== "lostpointercapture" && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function onResizeKey(e: React.KeyboardEvent<HTMLDivElement>): void {
    const next = { ArrowUp: height + 16, ArrowDown: height - 16, Home: minHeight, End: maxHeight }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setPreferredHeight(clampHeight(next));
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

  const current = active.find(job => job.state === "running") ?? active[0];
  const currentProgress = current ? progressById[jobIdKey(current.id)] : undefined;
  const summary = current?.state === "paused" ? "Paused"
    : current ? currentProgress?.stage || "Starting"
    : queued.length ? `${queued.length} waiting` : "No active jobs";
  const percent = currentProgress?.percent;
  const showPercent = current?.state === "running" && percent != null && Number.isFinite(percent)
    && percent > 0 && !/^(downloaded |retrying)/.test(summary);

  return (
    <aside ref={panelRef} className="workspace-queue" style={{ height: collapsed ? 40 : height }} aria-label="Job queue">
      {!collapsed && <div role="separator" tabIndex={0} aria-label="Resize queue"
        aria-valuemin={minHeight} aria-valuemax={maxHeight} aria-valuenow={height} aria-orientation="horizontal"
        onFocus={() => { contentFocused.current = true; }}
        onBlur={() => { contentFocused.current = false; }}
        onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd} onLostPointerCapture={onDragEnd}
        onKeyDown={onResizeKey} className="workspace-queue-grip" />}
      <div className="workspace-queue-header">
        <button ref={toggleRef} type="button" onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand queue" : "Collapse queue"} aria-expanded={!collapsed} aria-controls={contentId}
          title={`${collapsed ? "Expand" : "Collapse"} queue (${modKeyLabel()}Shift+Q)`}
          className="workspace-queue-toggle">
          {collapsed ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          <span>Queue</span><span className="text-fg-muted tabular-nums">({activeCount})</span>
        </button>
        {unseen > 0 && <button type="button" onClick={() => clearUnseen()}
          aria-label={`${unseen} new completion${unseen !== 1 ? "s" : ""}, click to clear`}
          className="workspace-queue-unseen">{unseen > 99 ? "99+" : unseen}</button>}
        <span className="workspace-queue-summary">{summary}{showPercent && ` · ${Math.round(Math.min(100, percent))}%`}</span>
      </div>
      <div id={contentId} hidden={collapsed} className="workspace-queue-content"
        onFocusCapture={() => { contentFocused.current = true; }}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) contentFocused.current = false; }}>
      {(activeCount > 0 || doneToday > 0) && (
        <div className="mt-1 flex items-center justify-between text-xs tabular-nums text-fg-muted">
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
                  className="inline-flex items-center justify-center text-fg-muted hover:text-fg"
                  aria-label="Clear selection"
                >
                  <X size={12} strokeWidth={2.5} aria-hidden="true" />
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
            <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
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
        {jobs.length === 0 && <p className="py-5 text-center text-sm text-fg-muted">Your next task will appear here.</p>}
      </div>
    </aside>
  );
}
