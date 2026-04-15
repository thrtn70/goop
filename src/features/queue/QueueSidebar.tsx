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
    <aside className="w-72 overflow-auto border-l border-neutral-800 bg-neutral-950 p-3">
      <h3 className="text-xs font-semibold uppercase text-neutral-500">
        Queue ({running.length + queued.length})
      </h3>
      <div className="mt-2 space-y-1">
        {[...running, ...queued].map((j) => (
          <QueueRow key={jobIdKey(j.id)} job={j} />
        ))}
      </div>
      {done.length > 0 && (
        <>
          <div className="mt-4 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase text-neutral-500">
              Done ({done.length})
            </h3>
            <button
              type="button"
              className="text-[10px] text-neutral-500 hover:text-white"
              onClick={() => void handleClear()}
            >
              clear
            </button>
          </div>
          <div className="mt-2 space-y-1">
            {done.map((j) => (
              <QueueRow key={jobIdKey(j.id)} job={j} />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
