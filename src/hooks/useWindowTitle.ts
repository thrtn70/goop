import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Job, JobState } from "@/types";
import { useAppStore } from "@/store/appStore";

const BASE_TITLE = "Goop";

function isActive(state: JobState): boolean {
  return state === "running" || state === "queued" || state === "paused";
}

function activeCount(jobs: readonly Job[]): number {
  return jobs.reduce((n, j) => (isActive(j.state) ? n + 1 : n), 0);
}

function titleFor(count: number): string {
  if (count <= 0) return BASE_TITLE;
  return `${BASE_TITLE} · ${count} ${count === 1 ? "job" : "jobs"}`;
}

export function useWindowTitle(): void {
  // Select the derived count, not the raw array — Zustand's default
  // equality check compares numbers, so the effect only re-fires when
  // the active count actually changes (not on every progress tick).
  const count = useAppStore((s) => activeCount(s.jobs));

  useEffect(() => {
    const next = titleFor(count);
    void getCurrentWindow()
      .setTitle(next)
      .catch(() => {
        // setTitle can fail in unusual window states (closed, transitioning).
        // The title is decorative — a failure isn't user-actionable, so swallow.
      });
  }, [count]);
}
