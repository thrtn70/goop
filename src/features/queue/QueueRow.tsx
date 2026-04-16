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

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function shortLabel(job: Job): string {
  const payload = job.payload as PayloadShape | null;
  if (job.kind === "convert") {
    const name = payload?.input_path ? basename(payload.input_path) : "file";
    return `Convert · ${name}`;
  }
  const raw = payload?.url;
  if (!raw) return payload?.input_path ?? "job";
  try {
    const url = new URL(raw);
    return `${url.hostname}${url.pathname.slice(0, 24)}`;
  } catch {
    return raw.slice(0, 32);
  }
}

function stateInfo(name: StateName): { glyph: string; label: string } {
  switch (name) {
    case "running":
      return { glyph: "\u25B6", label: "Running" };
    case "queued":
      return { glyph: "\u25E6", label: "Waiting in queue" };
    case "done":
      return { glyph: "\u2713", label: "Completed" };
    case "error":
      return { glyph: "!", label: "Failed" };
    case "cancelled":
      return { glyph: "\u00D7", label: "Cancelled" };
  }
}

export default function QueueRow({ job, index }: { job: Job; index: number }) {
  const progress = useAppStore((s) => s.progressById[jobIdKey(job.id)] ?? null);
  const name = stateName(job.state);
  const pct = progress?.percent ?? 0;
  const outputPath = job.result?.output_path ?? null;

  return (
    <div
      className={clsx(
        "enter-stagger hover-lift rounded-md bg-surface-2 p-2 text-xs",
        name === "running" && "pulse-running",
      )}
      style={{ "--i": index } as React.CSSProperties}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={clsx("truncate font-medium", name === "running" ? "text-accent" : "text-fg-secondary")}
          title={shortLabel(job)}
        >
          <span title={stateInfo(name).label}>{stateInfo(name).glyph}</span> {shortLabel(job)}
        </span>
        {name === "running" && (
          <button
            type="button"
            onClick={() => void api.queue.cancel(job.id)}
            aria-label={`Cancel ${shortLabel(job)}`}
            className="btn-press shrink-0 rounded-md px-2 py-1 text-xs text-error transition duration-fast ease-out hover:bg-error-subtle hover:text-error/80"
          >
            cancel
          </button>
        )}
        {name === "done" && outputPath && (
          <button
            type="button"
            onClick={() => void api.queue.reveal(outputPath)}
            aria-label={`Reveal ${shortLabel(job)} in file manager`}
            className="btn-press shrink-0 rounded-md px-2 py-1 text-xs text-accent transition duration-fast ease-out hover:bg-accent-subtle hover:text-accent-hover"
          >
            reveal
          </button>
        )}
      </div>
      {name === "running" && (
        <>
          <div
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${shortLabel(job)} progress`}
            className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-3"
          >
            <div
              className="h-1 w-full origin-left rounded-full bg-accent"
              style={{
                transform: `scaleX(${pct / 100})`,
                transition: `transform var(--duration-normal) var(--ease-out)`,
              }}
            />
          </div>
          <div className="mt-1 flex justify-between tabular-nums text-xs text-fg-muted">
            <span>{pct.toFixed(1)}%</span>
            <span>{progress?.speed_hr ?? ""}</span>
            <span>{progress?.eta_secs != null ? `ETA ${progress.eta_secs}s` : ""}</span>
          </div>
        </>
      )}
    </div>
  );
}
