import { useMemo, useState } from "react";
import type { Job } from "@/types";
import { jobIdKey, useAppStore } from "@/store/appStore";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { handoffEligibility, type HandoffDestination } from "@/features/workspace/handoff";
import { useHandoff } from "@/features/workspace/useHandoff";

/**
 * Pinned bottom bar shown when at least one History row is selected.
 * Provides "Convert…" and "Compress…" (when a selected item can be handed
 * off), "Reveal all", "Remove from history", and "Move to Trash" — the
 * latter two surface a confirm-in-toast pattern via the store actions, so
 * there's no modal.
 */
export default function HistoryBulkActions() {
  const selectedIds = useAppStore((s) => s.history.selectedIds);
  const jobs = useAppStore((s) => s.history.jobs);
  const clearSelection = useAppStore((s) => s.clearHistorySelection);
  const forgetJobs = useAppStore((s) => s.forgetJobs);
  const trashJobs = useAppStore((s) => s.trashJobs);
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [busy, setBusy] = useState(false);
  const handoff = useHandoff();

  const selectedJobs = useMemo(
    () => jobs.filter((j: Job) => selectedIds.has(jobIdKey(j.id))),
    [jobs, selectedIds],
  );

  if (selectedJobs.length === 0) return null;
  const canHandOff = selectedJobs.some((j: Job) => typeof handoffEligibility(j) !== "string");

  async function handleHandoff(destination: HandoffDestination) {
    setBusy(true);
    try {
      await handoff(selectedJobs, destination);
    } finally {
      setBusy(false);
    }
  }

  async function handleRevealAll() {
    for (const j of selectedJobs) {
      const p = j.result?.output_path;
      if (!p) continue;
      try {
        await api.queue.reveal(p);
      } catch {
        /* tolerate missing file */
      }
    }
  }

  async function handleForget() {
    setBusy(true);
    try {
      await forgetJobs(selectedJobs.map((j: Job) => j.id));
      enqueueToast({
        variant: "info",
        title: `${selectedJobs.length} removed from history`,
      });
    } catch (e) {
      enqueueToast({ variant: "error", title: "Couldn't remove", detail: formatError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function handleTrash() {
    setBusy(true);
    try {
      await trashJobs(
        selectedJobs
          .filter((j: Job) => j.result?.output_path)
          .map((j: Job) => ({ id: j.id, path: j.result!.output_path! })),
      );
      enqueueToast({
        variant: "info",
        title: `${selectedJobs.length} moved to Trash`,
      });
    } catch (e) {
      enqueueToast({ variant: "error", title: "Trash failed", detail: formatError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sticky bottom-0 z-10 flex items-center gap-3 border-t border-subtle bg-surface-1 px-6 py-2 text-xs">
      <span className="text-fg-muted">{selectedJobs.length} selected</span>
      <button
        type="button"
        onClick={clearSelection}
        className="text-fg-muted transition duration-fast ease-out hover:text-fg"
      >
        Clear
      </button>
      <div className="ml-auto flex gap-2">
        {canHandOff && (["convert", "compress"] as const).map((destination) => (
          <button
            key={destination}
            type="button"
            onClick={() => void handleHandoff(destination)}
            disabled={busy}
            className="btn-press rounded-md bg-surface-2 px-3 py-1.5 font-medium text-fg-secondary transition duration-fast ease-out enabled:hover:text-fg disabled:opacity-50"
          >
            {destination === "convert" ? "Convert…" : "Compress…"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void handleRevealAll()}
          disabled={busy}
          className="btn-press rounded-md bg-surface-2 px-3 py-1.5 font-medium text-fg-secondary transition duration-fast ease-out enabled:hover:text-fg disabled:opacity-50"
        >
          Reveal all
        </button>
        <button
          type="button"
          onClick={() => void handleForget()}
          disabled={busy}
          className="btn-press rounded-md bg-surface-2 px-3 py-1.5 font-medium text-fg-secondary transition duration-fast ease-out enabled:hover:text-fg disabled:opacity-50"
        >
          Remove from history
        </button>
        <button
          type="button"
          onClick={() => void handleTrash()}
          disabled={busy}
          className="btn-press rounded-md bg-surface-2 px-3 py-1.5 font-medium text-error transition duration-fast ease-out disabled:opacity-50"
        >
          Move to Trash
        </button>
      </div>
    </div>
  );
}
