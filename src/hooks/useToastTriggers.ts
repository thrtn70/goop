import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import type { Job, JobKind, JobState } from "@/types";
import { jobIdKey, useAppStore } from "@/store/appStore";
import { canRetryKind, failureView } from "@/lib/jobFailure";

async function fireNativeNotification(title: string, body?: string): Promise<void> {
  if (typeof document !== "undefined" && document.hasFocus()) return;
  try {
    const granted = await isPermissionGranted();
    if (!granted) return;
    await sendNotification(body ? { title, body } : { title });
  } catch {
    // The in-app toast already informed the user — a follow-up "notification
    // failed" toast would be noisy and not actionable here.
  }
}

/**
 * Watches the queue store for job state transitions and fires toasts.
 *
 * Individual (non-batched) jobs get one toast each on completion.
 * Batched jobs (payload.batch_id set) are grouped: a single summary toast
 * fires once all jobs in the batch have settled (Phase 8 wires batch IDs
 * through the ConvertActionBar / CompressActionBar — until then, every
 * completion shows an individual toast).
 *
 * Also increments `unseenCompletions` when a job finishes while the user
 * is on a page that isn't History and isn't the job's own page.
 */
interface Batch {
  ids: Set<string>;
  done: number;
  failed: number;
  cancelled: number;
  lastOutputPath: string | null;
  kind: JobKind | null;
  /**
   * `label — reason` for the first few failures, so the toast can say what
   * went wrong rather than only how often. Capped at `MAX_FAILED_LABELS`:
   * a forty-item batch that fails wholesale must not paste forty lines
   * into a toast. `failed` still counts them all.
   */
  failedLabels: string[];
}

/** The fields this hook reads off a job's untyped payload. */
type JobPayload = { batch_id?: string; input_path?: string; url?: string };

const MAX_FAILED_LABELS = 3;

/**
 * And a length cap per line, not just a count cap.
 *
 * `failureView` already clips its headline, but this does not depend on that:
 * an error toast is sticky (`ttlMs: null`) and its `<pre>` grows the toast
 * upward from the bottom of the viewport, so enough text pushes the toast's
 * own dismiss button off the top of the screen and leaves it there. A count
 * cap alone does not prevent that — three unbounded dumps do it just as well
 * as thirty short ones.
 */
const MAX_LABEL_CHARS = 160;

function clampLabel(text: string): string {
  const oneLine = text.split("\n", 1)[0] ?? "";
  const clipped = oneLine.length !== text.length;
  if (oneLine.length <= MAX_LABEL_CHARS) return clipped ? `${oneLine}…` : oneLine;
  return `${oneLine.slice(0, MAX_LABEL_CHARS).trimEnd()}…`;
}

function terminalName(state: JobState): "done" | "error" | "cancelled" | null {
  if (typeof state === "string") {
    if (state === "done") return "done";
    if (state === "cancelled") return "cancelled";
    return null;
  }
  if ("error" in state) return "error";
  return null;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function pageForKind(kind: JobKind): string {
  if (kind === "extract") return "/extract";
  // Both Convert and Compress use JobKind::Convert; there's no clean way
  // to distinguish them here without a payload peek. Treat either page as
  // a "relevant page" for unseen-counter purposes by matching on both.
  return "/convert";
}

export function useToastTriggers(): void {
  const location = useLocation();
  const previousStatesRef = useRef<Map<string, string>>(new Map());
  const batchesRef = useRef<Map<string, Batch>>(new Map());
  const pathRef = useRef(location.pathname);

  // Keep pathRef in sync without re-subscribing to the store on every
  // navigation. The subscription below reads pathRef.current inside the
  // callback so it always sees the latest path.
  useEffect(() => {
    pathRef.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    const unsubscribe = useAppStore.subscribe((state, prevState) => {
      if (state.jobs === prevState.jobs) return;

      const prev = previousStatesRef.current;
      const { enqueueToast, incrementUnseen } = state;
      const notificationsEnabled = state.settings?.notifications_enabled === true;
      // Batches touched by this publish, flushed once the whole snapshot has
      // been folded in — see the loop below this one.
      const touchedBatches = new Set<string>();

      for (const job of state.jobs) {
        const key = jobIdKey(job.id);
        const currentTerm = terminalName(job.state);
        const prevTerm = prev.get(key) ?? null;

        // A retried job leaves its terminal state (error -> queued).
        // Clear the memo so a second failure toasts again; without this,
        // error -> queued -> error would be silently swallowed.
        if (!currentTerm && prevTerm) {
          prev.delete(key);
        }

        if (currentTerm && currentTerm !== prevTerm) {
          prev.set(key, currentTerm);

          const payload = job.payload as JobPayload | null;
          const batchId = payload?.batch_id ?? null;
          const sourceLabel = jobLabel(job, payload);
          const outputPath = job.result?.output_path ?? null;

          if (batchId) {
            const batch = batchesRef.current.get(batchId) ?? {
              ids: new Set<string>(),
              done: 0,
              failed: 0,
              cancelled: 0,
              lastOutputPath: null,
              kind: null,
              failedLabels: [],
            };
            // Count each job once per batch lifetime. A retried job
            // reaches a terminal state twice (error -> queued -> done);
            // recounting it would put it in two buckets. Batched kinds
            // don't expose Retry in the UI today, but the backend
            // command is kind-generic, so guard the invariant here.
            if (!batch.ids.has(key)) {
              batch.ids.add(key);
              if (currentTerm === "done") batch.done += 1;
              else if (currentTerm === "error") {
                batch.failed += 1;
                if (batch.failedLabels.length < MAX_FAILED_LABELS) {
                  const why = failureView(job.state, canRetryKind(job.kind))?.message;
                  batch.failedLabels.push(
                    why ? clampLabel(`${sourceLabel} — ${why}`) : sourceLabel,
                  );
                }
              } else batch.cancelled += 1;
            }
            if (outputPath) batch.lastOutputPath = outputPath;
            batch.kind = job.kind;
            batchesRef.current.set(batchId, batch);
            touchedBatches.add(batchId);
          } else {
            emitIndividualToast(enqueueToast, job.kind, currentTerm, sourceLabel, outputPath, errorMessage(job.state, job.kind));
            if (notificationsEnabled && currentTerm !== "cancelled") {
              void fireNativeNotification(
                individualNotificationTitle(job.kind, currentTerm, sourceLabel),
              );
            }
          }

          if (currentTerm === "done") {
            const relevantPage = pageForKind(job.kind);
            const path = pathRef.current;
            const onRelevantPage =
              path === relevantPage ||
              path === "/history" ||
              (job.kind !== "extract" && path === "/compress");
            if (!onRelevantPage) {
              incrementUnseen();
            }
          }
        }
      }

      // Flush only after the whole snapshot has been folded in. `state.jobs`
      // is one immutable snapshot, so a member's "is anyone still running?"
      // answer is the same no matter where in the loop it is asked — deciding
      // inside the loop just means the first terminal member of a
      // multi-terminal publish sees a settled batch, summarizes itself alone,
      // and drops the accumulator the rest would have joined. Wholesale
      // `api.queue.list()` refreshes deliver exactly that: several members
      // already terminal in a single publish.
      for (const batchId of touchedBatches) {
        const batch = batchesRef.current.get(batchId);
        if (!batch) continue;

        const stillOpen = state.jobs.some((j) => {
          const p = j.payload as JobPayload | null;
          return p?.batch_id === batchId && terminalName(j.state) === null;
        });
        if (stillOpen) continue;

        emitBatchToast(enqueueToast, batch);
        if (notificationsEnabled) {
          void fireNativeNotification(batchNotificationTitle(batch));
        }
        batchesRef.current.delete(batchId);
      }
    });
    return () => unsubscribe();
  }, []);
}

function jobLabel(
  _job: Job,
  payload: { input_path?: string; url?: string } | null,
): string {
  if (payload?.input_path) return basename(payload.input_path);
  if (payload?.url) {
    try {
      const url = new URL(payload.url);
      return `${url.hostname}${url.pathname.slice(0, 24)}`;
    } catch {
      return payload.url.slice(0, 32);
    }
  }
  return "job";
}

/**
 * Extract jobs are never batched, so this is THE surface for a single failed
 * download — the one that would otherwise show a bare "interrupted" or a raw
 * `[goop]` marker while the queue row beside it showed neither.
 */
function errorMessage(state: JobState, kind: JobKind): string | undefined {
  return failureView(state, canRetryKind(kind))?.message;
}

function emitIndividualToast(
  enqueueToast: (t: { variant: "success" | "error" | "cancelled"; title: string; detail?: string; outputPath?: string; ttlMs?: number | null }) => string,
  kind: JobKind,
  term: "done" | "error" | "cancelled",
  label: string,
  outputPath: string | null,
  detail: string | undefined,
) {
  const verb = kind === "extract" ? "Downloaded" : "Processed";
  if (term === "done") {
    enqueueToast({
      variant: "success",
      title: `${verb} ${label}`,
      outputPath: outputPath ?? undefined,
    });
  } else if (term === "error") {
    enqueueToast({
      variant: "error",
      title: `${label} failed`,
      detail,
      ttlMs: null, // sticky — user must dismiss errors explicitly
    });
  } else {
    enqueueToast({
      variant: "cancelled",
      title: `${label} cancelled`,
    });
  }
}

function individualNotificationTitle(
  kind: JobKind,
  term: "done" | "error",
  label: string,
): string {
  if (term === "error") return `${label} failed`;
  const verb = kind === "extract" ? "Downloaded" : "Processed";
  return `${verb} ${label}`;
}

function batchNotificationTitle(batch: {
  ids: Set<string>;
  done: number;
  failed: number;
  cancelled: number;
  kind: JobKind | null;
}): string {
  const total = batch.ids.size;
  const verb = batch.kind === "extract" ? "downloaded" : "processed";
  if (batch.failed === 0 && batch.cancelled === 0) {
    return `${total} file${total !== 1 ? "s" : ""} ${verb}`;
  }
  if (batch.done === 0 && batch.failed > 0) {
    return `${batch.failed} file${batch.failed !== 1 ? "s" : ""} failed`;
  }
  const parts: string[] = [];
  if (batch.done > 0) parts.push(`${batch.done} done`);
  if (batch.failed > 0) parts.push(`${batch.failed} failed`);
  if (batch.cancelled > 0) parts.push(`${batch.cancelled} cancelled`);
  return parts.join(" · ");
}

/**
 * The failure reasons behind a batch's count, for the toast's Details
 * expander. `undefined` rather than an empty string when there is nothing
 * to say — that is what keeps the expander from appearing at all.
 */
function failedDetail(batch: Batch): string | undefined {
  if (batch.failedLabels.length === 0) return undefined;
  const hidden = batch.failed - batch.failedLabels.length;
  const lines = [...batch.failedLabels];
  if (hidden > 0) lines.push(`…and ${hidden} more`);
  return lines.join("\n");
}

function emitBatchToast(
  enqueueToast: (t: { variant: "success" | "error" | "cancelled" | "info"; title: string; detail?: string; outputPath?: string; ttlMs?: number | null }) => string,
  batch: Batch,
) {
  const total = batch.ids.size;
  const verb = batch.kind === "extract" ? "downloaded" : "processed";

  if (batch.failed === 0 && batch.cancelled === 0) {
    enqueueToast({
      variant: "success",
      title: `${total} file${total !== 1 ? "s" : ""} ${verb}`,
      outputPath: batch.lastOutputPath ?? undefined,
    });
  } else if (batch.done === 0 && batch.failed > 0) {
    enqueueToast({
      variant: "error",
      title: `${batch.failed} file${batch.failed !== 1 ? "s" : ""} failed`,
      detail: failedDetail(batch),
      ttlMs: null,
    });
  } else {
    const parts: string[] = [];
    if (batch.done > 0) parts.push(`${batch.done} done`);
    if (batch.failed > 0) parts.push(`${batch.failed} failed`);
    if (batch.cancelled > 0) parts.push(`${batch.cancelled} cancelled`);
    enqueueToast({
      variant: "info",
      title: parts.join(" · "),
      // A partly-failed batch is the common outcome, and the reasons were
      // collected either way. Rendered inline rather than behind an
      // expander (Toast reserves that for the error variant), so the first
      // one shows and the rest are in History.
      detail: failedDetail(batch),
      outputPath: batch.lastOutputPath ?? undefined,
    });
  }
}
