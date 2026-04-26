import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { jobIdKey } from "@/store/appStore";
import type { Job, JobState } from "@/types";

/**
 * Phase L (a11y): visually-hidden ARIA live region that screen readers
 * announce when a queued job transitions to a terminal state
 * (Done / Cancelled / Error). Uses `aria-live="polite"` so the
 * announcement queues behind any in-flight reading instead of
 * interrupting.
 *
 * Implementation: subscribes to the `jobs` slice of the store and
 * compares each render against the previous state map; when a job
 * transitions to a terminal state for the first time, the message is
 * updated. To force re-announcement of identical messages (e.g. two
 * jobs both finishing with the same name), the region is briefly
 * cleared via setTimeout — that gives screen readers a DOM mutation
 * to latch onto regardless of text-content equality.
 */
export default function JobStateAnnouncer() {
  const jobs = useAppStore((s) => s.jobs);
  const [message, setMessage] = useState("");
  const previousStates = useRef<Map<string, JobState>>(new Map());
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const next = new Map<string, JobState>();
    let announcement: string | null = null;
    for (const job of jobs) {
      const key = jobIdKey(job.id);
      next.set(key, job.state);
      const prev = previousStates.current.get(key);
      // First-time-seen jobs in a terminal state shouldn't fire an
      // announcement on initial load — only transitions count.
      if (prev === undefined) continue;
      if (statesEqual(prev, job.state)) continue;
      const label = announcementFor(job);
      if (label !== null) announcement = label;
    }
    previousStates.current = next;
    if (announcement !== null) {
      // Clear-then-set: setting the same string twice is a no-op for
      // most screen readers. Wiping to "" first guarantees a DOM
      // mutation that triggers a fresh announcement.
      if (clearTimer.current !== null) clearTimeout(clearTimer.current);
      setMessage("");
      const next = announcement;
      clearTimer.current = setTimeout(() => setMessage(next), 50);
    }
  }, [jobs]);

  // Clean up the pending re-announce timer on unmount so we don't
  // touch state after teardown.
  useEffect(() => {
    return () => {
      if (clearTimer.current !== null) clearTimeout(clearTimer.current);
    };
  }, []);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}

// Today `JobState`'s only object variant is `{ error: { message } }`. If
// a future variant is added, this comparator returns `false` for it and
// will cause a spurious re-announcement until the comparator is taught
// the new shape — acceptable for now, just be aware on enum changes.
function statesEqual(a: JobState, b: JobState): boolean {
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (typeof a === "object" && typeof b === "object") {
    return "error" in a && "error" in b && a.error.message === b.error.message;
  }
  return false;
}

function announcementFor(job: Job): string | null {
  const name = labelOf(job);
  if (typeof job.state === "string") {
    if (job.state === "done") return `${name} finished`;
    if (job.state === "cancelled") return `${name} cancelled`;
    return null;
  }
  if ("error" in job.state) {
    return `${name} failed: ${job.state.error.message}`;
  }
  return null;
}

function labelOf(job: Job): string {
  const out = job.result?.output_path;
  if (out) return basename(out);
  const payload = job.payload as { url?: string; input_path?: string } | null;
  if (payload?.input_path) return basename(payload.input_path);
  if (payload?.url) {
    try {
      return new URL(payload.url).hostname;
    } catch {
      return payload.url.slice(0, 32);
    }
  }
  return "Job";
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}
