import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { Job, JobState, TargetFormat } from "@/types";
import { api } from "@/ipc/commands";
import { formatError, parseIpcError } from "@/ipc/error";
import { jobIdKey, useAppStore } from "@/store/appStore";
import { useSpringValue } from "@/hooks/useSpringValue";

type StateName = "queued" | "running" | "paused" | "done" | "cancelled" | "error";

/**
 * Phase G: image targets are NOT pausable (ImageMagick runs in-process via
 * the `image` crate — no child PID to signal). yt-dlp downloads are also
 * not pausable (long pauses can drop the connection). Mirrors
 * `TargetFormat::is_image` in `crates/goop-core/src/convert.rs`.
 */
const IMAGE_TARGETS: ReadonlySet<TargetFormat> = new Set<TargetFormat>([
  "png",
  "jpeg",
  "webp",
  "bmp",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPausable(job: Job): boolean {
  if (!isPlainObject(job.payload)) return false;
  if (job.kind === "pdf") {
    return job.payload.kind === "compress";
  }
  if (job.kind === "convert") {
    const target = job.payload.target;
    return typeof target === "string" && !IMAGE_TARGETS.has(target as TargetFormat);
  }
  return false;
}

/**
 * Names emitted by the converter when ffmpeg uses a hardware encoder.
 * Mirrors the list in `crates/goop-converter/src/encoders.rs::KNOWN_HW_ENCODERS`.
 * Kept inline so the queue row doesn't pull in a larger encoder utility.
 */
const HW_ENCODER_NAMES = new Set([
  "h264_videotoolbox",
  "hevc_videotoolbox",
  "h264_nvenc",
  "hevc_nvenc",
  "h264_qsv",
  "hevc_qsv",
  "h264_amf",
  "hevc_amf",
]);

function isHardwareEncoder(name: string | null): boolean {
  return name !== null && HW_ENCODER_NAMES.has(name);
}

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
    case "paused":
      return { glyph: "⏸", label: "Paused" };
    case "done":
      return { glyph: "\u2713", label: "Completed" };
    case "error":
      return { glyph: "!", label: "Failed" };
    case "cancelled":
      return { glyph: "\u00D7", label: "Cancelled" };
  }
}

/**
 * Backend signals the PID-registration race as `IpcError::Queue` with
 * message "job_not_running". All other errors propagate immediately.
 */
function isPidRaceError(err: unknown): boolean {
  const ipc = parseIpcError(err);
  return ipc?.code === "queue" && ipc.message === "job_not_running";
}

/**
 * Pause IPC can race with the worker's PID registration in the ~1ms window
 * between scheduler->Running and `register_pid`. Retry briefly on the race
 * error only — surface every other error immediately.
 */
async function pauseWithRetry(jobId: Job["id"]): Promise<void> {
  const delays = [0, 100, 200];
  let lastErr: unknown = null;
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      await api.queue.pause(jobId);
      return;
    } catch (err) {
      if (!isPidRaceError(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

export default function QueueRow({ job, index }: { job: Job; index: number }) {
  const progress = useAppStore((s) => s.progressById[jobIdKey(job.id)] ?? null);
  const isSelected = useAppStore((s) =>
    s.ui.queueSelectedIds.has(jobIdKey(job.id)),
  );
  const toggleSelection = useAppStore((s) => s.toggleQueueSelection);
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const name = stateName(job.state);
  const pct = progress?.percent ?? 0;
  // Spring-settle the ETA so it doesn't jitter "12s … 11s … 13s" on
  // every progress event. Pause settles too — when paused the underlying
  // value is null, which the hook surfaces as null without trying to
  // interpolate between unknown and a number.
  const targetEta =
    name === "paused" ? null : progress?.eta_secs != null ? progress.eta_secs : null;
  const settledEta = useSpringValue(targetEta);
  const outputPath = job.result?.output_path ?? null;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  async function handlePauseClick(): Promise<void> {
    try {
      await pauseWithRetry(job.id);
    } catch (err) {
      enqueueToast({
        variant: "error",
        title: "Couldn't pause",
        detail: formatError(err),
      });
    }
  }

  async function handleResumeClick(): Promise<void> {
    try {
      await api.queue.resume(job.id);
    } catch (err) {
      enqueueToast({
        variant: "error",
        title: "Couldn't resume",
        detail: formatError(err),
      });
    }
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onClickOutside(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [menuOpen]);

  function handleContextMenu(e: React.MouseEvent): void {
    if (name !== "queued") return;
    e.preventDefault();
    setMenuOpen(true);
  }

  async function handleMoveToTop(): Promise<void> {
    setMenuOpen(false);
    try {
      await api.queue.moveToTop(job.id);
      const jobs = await api.queue.list();
      useAppStore.setState({ jobs });
    } catch (err) {
      enqueueToast({
        variant: "error",
        title: "Couldn't move to top",
        detail: formatError(err),
      });
    }
  }

  async function handleCancel(): Promise<void> {
    try {
      await api.queue.cancel(job.id);
    } catch (err) {
      enqueueToast({
        variant: "error",
        title: "Couldn't cancel",
        detail: formatError(err),
      });
    }
  }

  async function handleCancelFromMenu(): Promise<void> {
    setMenuOpen(false);
    await handleCancel();
  }

  return (
    <div
      onContextMenu={handleContextMenu}
      className={clsx(
        "group enter-stagger hover-lift relative rounded-md bg-surface-2 p-2 text-xs",
        name === "running" && "pulse-running",
        isSelected && "ring-1 ring-accent",
      )}
      style={{ "--i": index } as React.CSSProperties}
    >
      <div className="flex items-center justify-between gap-2">
        {name === "queued" && (
          <button
            type="button"
            role="checkbox"
            aria-checked={isSelected}
            onClick={(e) => {
              e.stopPropagation();
              toggleSelection(job.id);
            }}
            aria-label={isSelected ? `Deselect ${shortLabel(job)}` : `Select ${shortLabel(job)}`}
            className={clsx(
              "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border text-[9px] transition duration-fast ease-out",
              isSelected
                ? "border-accent bg-accent text-accent-fg"
                : "border-subtle bg-surface-1/70 text-fg-muted opacity-0 group-hover:opacity-100 hover:opacity-100",
            )}
          >
            {isSelected ? "✓" : ""}
          </button>
        )}
        <span
          className={clsx(
            "truncate font-medium",
            name === "running" && "text-accent",
            name === "paused" && "text-fg-muted",
            name !== "running" && name !== "paused" && "text-fg-secondary",
          )}
          title={shortLabel(job)}
        >
          <span title={stateInfo(name).label}>{stateInfo(name).glyph}</span> {shortLabel(job)}
        </span>
        {name === "running" && (
          <div className="flex shrink-0 items-center gap-1">
            {isPausable(job) && (
              <button
                type="button"
                onClick={() => void handlePauseClick()}
                aria-label={`Pause ${shortLabel(job)}`}
                className="btn-press rounded-md px-2 py-1 text-xs text-fg-secondary transition duration-fast ease-out hover:bg-surface-3 hover:text-fg"
              >
                pause
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleCancel()}
              aria-label={`Cancel ${shortLabel(job)}`}
              className="btn-press rounded-md px-2 py-1 text-xs text-error transition duration-fast ease-out hover:bg-error-subtle hover:text-error/80"
            >
              cancel
            </button>
          </div>
        )}
        {name === "paused" && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void handleResumeClick()}
              aria-label={`Resume ${shortLabel(job)}`}
              className="btn-press rounded-md px-2 py-1 text-xs text-accent transition duration-fast ease-out hover:bg-accent-subtle hover:text-accent-hover"
            >
              resume
            </button>
            <button
              type="button"
              onClick={() => void handleCancel()}
              aria-label={`Cancel ${shortLabel(job)}`}
              className="btn-press rounded-md px-2 py-1 text-xs text-error transition duration-fast ease-out hover:bg-error-subtle hover:text-error/80"
            >
              cancel
            </button>
          </div>
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
      {menuOpen && name === "queued" && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute left-2 top-full z-20 mt-1 min-w-[160px] overflow-hidden rounded-md border border-subtle bg-surface-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleMoveToTop()}
            className="block w-full px-3 py-1.5 text-left text-xs text-fg hover:bg-accent-subtle hover:text-accent"
          >
            Move to top
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleCancelFromMenu()}
            className="block w-full px-3 py-1.5 text-left text-xs text-error hover:bg-error-subtle"
          >
            Cancel
          </button>
        </div>
      )}
      {(name === "running" || name === "paused") && (
        <>
          <div className={clsx("mt-1 flex items-center gap-2", name === "paused" && "opacity-50")}>
            <div
              role="progressbar"
              aria-valuenow={Math.round(pct)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${shortLabel(job)} progress`}
              className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3"
            >
              <div
                className={clsx(
                  "relative h-1 w-full origin-left overflow-hidden rounded-full",
                  name === "paused" ? "bg-fg-muted" : "bg-accent",
                )}
                style={{
                  transform: `scaleX(${pct / 100})`,
                  transition: `transform var(--duration-normal) var(--ease-out)`,
                }}
              >
                {/* Wave-flow overlay: a soft lighter wash slides
                 *  continuously across the running fill, suggesting
                 *  motion. Skipped while paused (frozen feel) and on
                 *  reduced-motion via the global @media rule. */}
                {name === "running" && (
                  <span
                    aria-hidden="true"
                    className="progress-flow absolute inset-0 block"
                  />
                )}
              </div>
            </div>
            {name === "running" && isHardwareEncoder(progress?.encoder ?? null) && (
              <span
                className="pulse-glow rounded-full bg-accent-subtle px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent"
                title={`Hardware-accelerated encoder: ${progress?.encoder}`}
              >
                HW
              </span>
            )}
          </div>
          <div className="mt-1 flex justify-between tabular-nums text-xs text-fg-muted">
            {/* gallery-dl jobs emit stage like "downloaded 12 file(s)"
             *  with percent always 0; surface that count instead of a
             *  meaningless 0.0% reading. yt-dlp jobs keep the original
             *  percent + speed + ETA layout. The prefix-based check is
             *  intentional: the Rust side controls both ends of this
             *  contract, and adding a structured "is_indeterminate"
             *  flag for one consumer felt heavier than the prefix. */}
            {progress?.stage?.startsWith("downloaded ") ? (
              <span>{progress.stage}</span>
            ) : (
              <>
                <span>{pct.toFixed(1)}%</span>
                <span>{name === "paused" ? "" : progress?.speed_hr ?? ""}</span>
                <span>
                  {name === "paused"
                    ? "ETA —"
                    : settledEta != null
                      ? `ETA ${Math.max(0, Math.round(settledEta))}s`
                      : ""}
                </span>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
