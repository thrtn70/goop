import clsx from "clsx";
import type { Job, JobState } from "@/types";
import { api } from "@/ipc/commands";
import { jobIdKey, useAppStore } from "@/store/appStore";

type StateName = "queued" | "running" | "done" | "cancelled" | "error";

function stateName(state: JobState): StateName {
  if (typeof state === "string") return state;
  if ("error" in state) return "error";
  return "error";
}

type PayloadShape = {
  readonly url?: string;
  readonly input_path?: string;
};

function shortUrl(job: Job): string {
  const payload = job.payload as PayloadShape | null;
  const raw = payload?.url;
  if (!raw) return payload?.input_path ?? "job";
  try {
    const url = new URL(raw);
    return `${url.hostname}${url.pathname.slice(0, 24)}`;
  } catch {
    return raw.slice(0, 32);
  }
}

function stateGlyph(name: StateName): string {
  switch (name) {
    case "running":
      return "▶";
    case "queued":
      return "◦";
    case "done":
      return "✓";
    case "error":
      return "!";
    case "cancelled":
      return "×";
  }
}

export default function QueueRow({ job }: { job: Job }) {
  const progress = useAppStore((s) => s.progressById[jobIdKey(job.id)] ?? null);
  const name = stateName(job.state);
  const pct = progress?.percent ?? 0;
  const outputPath = job.result?.output_path ?? null;

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className={clsx("truncate font-medium", name === "running" && "text-sky-400")}>
          {stateGlyph(name)} {shortUrl(job)}
        </span>
        {name === "running" && (
          <button
            type="button"
            onClick={() => void api.queue.cancel(job.id)}
            className="shrink-0 text-red-400 hover:text-red-200"
          >
            cancel
          </button>
        )}
        {name === "done" && outputPath && (
          <button
            type="button"
            onClick={() => void api.queue.reveal(outputPath)}
            className="shrink-0 text-sky-400 hover:text-sky-200"
          >
            reveal
          </button>
        )}
      </div>
      {name === "running" && (
        <>
          <div className="mt-1 h-1 w-full rounded bg-neutral-800">
            <div className="h-1 rounded bg-sky-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-neutral-500">
            <span>{pct.toFixed(1)}%</span>
            <span>{progress?.speed_hr ?? ""}</span>
            <span>{progress?.eta_secs != null ? `ETA ${progress.eta_secs}s` : ""}</span>
          </div>
        </>
      )}
    </div>
  );
}
