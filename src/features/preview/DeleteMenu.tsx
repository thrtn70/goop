import { useEffect, useRef, useState } from "react";
import type { Job } from "@/types";
import { useAppStore } from "@/store/appStore";
import { formatError } from "@/ipc/error";

interface DeleteMenuProps {
  job: Job;
  fullWidth?: boolean;
}

/**
 * Two-option dropdown for the Delete action. "Remove from history" drops
 * only the DB row; "Move to Trash" routes the file through the OS trash.
 * The explicit labels matter — users should never confuse disk removal
 * with history cleanup.
 */
export default function DeleteMenu({ job, fullWidth }: DeleteMenuProps) {
  const forgetJobs = useAppStore((s) => s.forgetJobs);
  const trashJobs = useAppStore((s) => s.trashJobs);
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const outputPath = job.result?.output_path ?? null;

  async function handleForget() {
    if (busy) return;
    setBusy(true);
    try {
      await forgetJobs([job.id]);
      enqueueToast({ variant: "info", title: "Removed from history" });
    } catch (e) {
      enqueueToast({ variant: "error", title: "Couldn't remove", detail: formatError(e) });
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  async function handleTrash() {
    if (busy || !outputPath) return;
    setBusy(true);
    try {
      await trashJobs([{ id: job.id, path: outputPath }]);
      enqueueToast({ variant: "info", title: "Moved to Trash" });
    } catch (e) {
      enqueueToast({ variant: "error", title: "Couldn't move to Trash", detail: formatError(e) });
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className={`relative ${fullWidth ? "w-full" : ""}`}>
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`btn-press rounded-md px-3 py-1.5 text-xs font-medium text-fg-muted transition duration-fast ease-out enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 ${
          fullWidth ? "w-full bg-surface-2" : ""
        }`}
      >
        Delete ▾
      </button>
      {open && (
        <div
          role="menu"
          className="enter-up absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-md border border-subtle bg-surface-1 shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleForget()}
            className="block w-full px-3 py-2 text-left text-xs text-fg transition duration-fast ease-out hover:bg-surface-2"
          >
            Remove from history
            <span className="ml-2 text-fg-muted">(keep file)</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!outputPath}
            onClick={() => void handleTrash()}
            className="block w-full px-3 py-2 text-left text-xs text-error transition duration-fast ease-out enabled:hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Move to Trash
            <span className="ml-2 text-fg-muted">(file + history)</span>
          </button>
        </div>
      )}
    </div>
  );
}
