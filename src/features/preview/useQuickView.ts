import { useCallback, useEffect, useState } from "react";
import { jobIdKey, useAppStore } from "@/store/appStore";
import type { Job, JobId } from "@/types";

interface UseQuickViewReturn {
  /** Currently shown job, or null when closed. */
  currentJob: Job | null;
  /** Open Quick View at the given job. Space on a focused row calls this. */
  open: (jobId: JobId) => void;
  /** Close with Space, Escape, or backdrop click. */
  close: () => void;
  /** Navigate to previous/next terminal job in the current filtered list. */
  stepPrev: () => void;
  stepNext: () => void;
  /** Derived index + total for the "N of M" header copy. */
  indexLabel: string;
}

/**
 * Owns Quick View state: open/close, keyboard navigation, and translation
 * between a selected `JobId` and the surrounding filtered list.
 *
 * Keyboard: Space toggles open/close when any History row is focused (the
 * Space handler lives in the list/grid components; this hook just exposes
 * the open function). While open, Escape closes, arrow keys navigate.
 */
export function useQuickView(): UseQuickViewReturn {
  const jobs = useAppStore((s) => s.history.jobs);
  const [currentKey, setCurrentKey] = useState<string | null>(null);

  const open = useCallback((jobId: JobId) => {
    setCurrentKey(jobIdKey(jobId));
  }, []);
  const close = useCallback(() => setCurrentKey(null), []);

  const currentIndex = currentKey
    ? jobs.findIndex((j) => jobIdKey(j.id) === currentKey)
    : -1;
  const currentJob = currentIndex >= 0 ? jobs[currentIndex] : null;

  const stepPrev = useCallback(() => {
    if (currentIndex <= 0) return;
    setCurrentKey(jobIdKey(jobs[currentIndex - 1].id));
  }, [currentIndex, jobs]);

  const stepNext = useCallback(() => {
    if (currentIndex < 0 || currentIndex >= jobs.length - 1) return;
    setCurrentKey(jobIdKey(jobs[currentIndex + 1].id));
  }, [currentIndex, jobs]);

  useEffect(() => {
    if (!currentKey) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " " || e.code === "Space") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepNext();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentKey, close, stepPrev, stepNext]);

  const indexLabel =
    currentIndex >= 0 ? `${currentIndex + 1} of ${jobs.length}` : "";

  return { currentJob, open, close, stepPrev, stepNext, indexLabel };
}
