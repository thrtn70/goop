import type { JobState } from "@/types";
import { api } from "@/ipc/commands";
import { jobIdKey, useAppStore } from "@/store/appStore";
import QueueRow from "./QueueRow";

function isRunning(s: JobState): boolean {
  return typeof s === "string" && s === "running";
}

function isQueued(s: JobState): boolean {
  return typeof s === "string" && s === "queued";
}

function isTerminal(s: JobState): boolean {
  if (typeof s === "string") return s === "done" || s === "cancelled";
  return "error" in s;
}

export default function QueueSidebar() {
  const jobs = useAppStore((s) => s.jobs);
  const running = jobs.filter((j) => isRunning(j.state));
  const queued = jobs.filter((j) => isQueued(j.state));
  const done = jobs.filter((j) => isTerminal(j.state));

  async function handleClear(): Promise<void> {
    try {
      await api.queue.clearCompleted();
      await useAppStore.getState().loadAll();
    } catch {
      /* ignore transient errors */
    }
  }

  return (
    <aside className="w-72 overflow-auto border-l border-subtle bg-surface-1 p-3" aria-label="Job queue">
      <h3 aria-live="polite" aria-atomic="true" className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
        Queue ({running.length + queued.length})
      </h3>
      <div className="mt-2 space-y-1">
        {[...running, ...queued].map((j, i) => (
          <QueueRow key={jobIdKey(j.id)} job={j} index={i} />
        ))}
      </div>
      {done.length > 0 && (
        <>
          <div className="mt-6 flex items-center justify-between">
            <h3 className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Done ({done.length})
            </h3>
            <button
              type="button"
              className="btn-press text-xs text-fg-muted transition duration-fast ease-out hover:text-fg"
              onClick={() => void handleClear()}
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
