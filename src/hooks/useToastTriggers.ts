import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import type { Job, JobKind, JobState } from "@/types";
import { jobIdKey, useAppStore } from "@/store/appStore";

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

  useEffect(() => {
    // Subscribe to store changes; on every update, walk through jobs and
    // compare prior vs current terminal state.
    const unsubscribe = useAppStore.subscribe((state, prevState) => {
      if (state.jobs === prevState.jobs) return;

      const prev = previousStatesRef.current;
      const { enqueueToast, incrementUnseen } = state;

      for (const job of state.jobs) {
        const key = jobIdKey(job.id);
        const currentTerm = terminalName(job.state);
        const prevTerm = prev.get(key) ?? null;

        if (currentTerm && currentTerm !== prevTerm) {
          // Transitioned into a terminal state.
          prev.set(key, currentTerm);

          const payload = job.payload as { batch_id?: string; input_path?: string; url?: string } | null;
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
            };
            batch.ids.add(key);
            if (currentTerm === "done") batch.done += 1;
            else if (currentTerm === "error") batch.failed += 1;
            else batch.cancelled += 1;
            if (outputPath) batch.lastOutputPath = outputPath;
            batch.kind = job.kind;
            batchesRef.current.set(batchId, batch);

            // The batch is considered "settled" when the number of seen
            // terminals equals the number of jobs with that batch_id. We
            // don't know the batch total up-front, so we settle when there
            // are no more running/queued jobs tagged with this batch.
            const stillOpen = state.jobs.some((j) => {
              const p = j.payload as { batch_id?: string } | null;
              return p?.batch_id === batchId && terminalName(j.state) === null;
            });
            if (!stillOpen) {
              emitBatchToast(enqueueToast, batch);
              batchesRef.current.delete(batchId);
            }
          } else {
            emitIndividualToast(enqueueToast, job.kind, currentTerm, sourceLabel, outputPath, errorMessage(job.state));
          }

          // Increment unseen-completions counter if the user isn't on a
          // page that corresponds to this job.
          if (currentTerm === "done") {
            const relevantPage = pageForKind(job.kind);
            const path = location.pathname;
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
    });
    return () => unsubscribe();
  }, [location.pathname]);
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

function errorMessage(state: JobState): string | undefined {
  if (typeof state === "string") return undefined;
  if ("error" in state) return state.error?.message ?? undefined;
  return undefined;
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
      outputPath: batch.lastOutputPath ?? undefined,
    });
  }
}
