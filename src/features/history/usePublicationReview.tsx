import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import type { Job } from "@/types";
import { api, type PublicationReviewStatus } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { jobIdKey, useAppStore } from "@/store/appStore";

type MatchingPublication = Extract<
  PublicationReviewStatus,
  { kind: "observed_matching_output" }
>;

interface PublicationConfirmation extends MatchingPublication {
  jobId: Job["id"];
}

const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "a[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export interface PublicationReviewController {
  reviewableIds: Set<string>;
  reviewingId: string | null;
  feedback: Record<string, string>;
  confirmation: PublicationConfirmation | null;
  recovering: boolean;
  recoveryError: string | null;
  cancelButtonRef: RefObject<HTMLButtonElement>;
  dialogRef: RefObject<HTMLDivElement>;
  requestReview: (job: Job, opener: HTMLElement, fallback: HTMLElement | null) => Promise<void>;
  cancelRecovery: () => void;
  recoverPublication: () => Promise<void>;
  handleDialogKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

export function usePublicationReview(jobs: Job[]): PublicationReviewController {
  const enqueueToast = useAppStore((state) => state.enqueueToast);
  const loadHistory = useAppStore((state) => state.loadHistory);
  const refreshJobs = useAppStore((state) => state.refreshJobs);
  const refreshDoneToday = useAppStore((state) => state.refreshDoneToday);
  const [reviewableIds, setReviewableIds] = useState<Set<string>>(new Set());
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<PublicationConfirmation | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const fallbackRef = useRef<HTMLElement | null>(null);
  const assessmentInFlightRef = useRef(false);

  useEffect(() => {
    let active = true;
    void api.queue
      .reviewablePublicationIds()
      .then((ids) => {
        if (active) setReviewableIds(new Set(ids.map(jobIdKey)));
      })
      .catch((err) => {
        if (!active) return;
        enqueueToast({
          variant: "error",
          title: "Couldn't load publication reviews",
          detail: formatError(err),
        });
      });
    return () => {
      active = false;
    };
  }, [enqueueToast, jobs]);

  useEffect(() => {
    if (confirmation) {
      cancelButtonRef.current?.focus();
      return;
    }
    const opener = openerRef.current;
    const fallback = fallbackRef.current;
    openerRef.current = null;
    fallbackRef.current = null;
    if (opener && document.contains(opener)) opener.focus();
    else if (fallback && document.contains(fallback)) fallback.focus();
  }, [confirmation]);

  useEffect(
    () => () => {
      const opener = openerRef.current;
      if (opener && document.contains(opener)) opener.focus();
      else {
        const fallback = fallbackRef.current;
        if (fallback && document.contains(fallback)) fallback.focus();
      }
    },
    [],
  );

  async function requestReview(
    job: Job,
    opener: HTMLElement,
    fallback: HTMLElement | null,
  ): Promise<void> {
    if (assessmentInFlightRef.current) return;
    assessmentInFlightRef.current = true;
    const key = jobIdKey(job.id);
    openerRef.current = opener;
    fallbackRef.current = fallback;
    setReviewingId(key);
    setFeedback((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      const status = await api.queue.reviewPublication(job.id);
      if (status.kind === "observed_matching_output") {
        setRecoveryError(null);
        setConfirmation({ ...status, jobId: job.id });
      } else {
        setFeedback((current) => ({ ...current, [key]: status.reason }));
      }
    } catch (err) {
      setFeedback((current) => ({
        ...current,
        [key]: `Couldn't review this output: ${formatError(err)}`,
      }));
    } finally {
      assessmentInFlightRef.current = false;
      setReviewingId((current) => (current === key ? null : current));
    }
  }

  async function recoverPublication(): Promise<void> {
    if (!confirmation || recovering) return;
    setRecovering(true);
    setRecoveryError(null);
    try {
      await api.queue.recoverPublication(confirmation.jobId, confirmation.snapshot);
      const recoveredKey = jobIdKey(confirmation.jobId);
      setReviewableIds((current) => {
        const next = new Set(current);
        next.delete(recoveredKey);
        return next;
      });
      setConfirmation(null);
      const refreshed = await Promise.allSettled([
        loadHistory(),
        refreshJobs(),
        refreshDoneToday(),
      ]);
      const refreshFailure = refreshed.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (refreshFailure) {
        enqueueToast({
          variant: "warning",
          title: "Output recovered, but the view didn't refresh",
          detail: formatError(refreshFailure.reason),
        });
      } else {
        enqueueToast({
          variant: "success",
          title: "Completed output recovered",
        });
      }
    } catch (err) {
      setRecoveryError(formatError(err));
    } finally {
      setRecovering(false);
    }
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !recovering) {
      setConfirmation(null);
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
    );
    if (controls.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (active === dialog || (event.shiftKey && active === first)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return {
    reviewableIds,
    reviewingId,
    feedback,
    confirmation,
    recovering,
    recoveryError,
    cancelButtonRef,
    dialogRef,
    requestReview,
    cancelRecovery: () => setConfirmation(null),
    recoverPublication,
    handleDialogKeyDown,
  };
}

export function PublicationReviewDialog({
  review,
}: {
  review: PublicationReviewController;
}) {
  const confirmation = review.confirmation;
  if (!confirmation) return null;

  return (
    <div
      ref={review.dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="publication-recovery-title"
      aria-describedby="publication-recovery-description"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40"
      onClick={(event) => {
        if (event.target === event.currentTarget && !review.recovering) {
          review.cancelRecovery();
        }
      }}
      onKeyDown={review.handleDialogKeyDown}
    >
      <div className="w-[28rem] max-w-[calc(100vw-2rem)] rounded-lg bg-surface-1 p-5 shadow-xl">
        <h3
          id="publication-recovery-title"
          className="font-display text-sm font-semibold text-fg"
        >
          Recover completed output?
        </h3>
        <p id="publication-recovery-description" className="mt-2 text-xs text-fg-secondary">
          <strong className="font-semibold text-fg">{confirmation.output_name}</strong>{" "}
          ({formatBytes(confirmation.bytes)}) was observed at the destination during this check.
          This point-in-time check does not guarantee that the file is still available or
          unchanged. Recovering marks this History item complete without running the conversion
          again.
        </p>
        {review.recoveryError && (
          <p role="alert" className="mt-3 text-xs text-error">
            {review.recoveryError}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={review.cancelButtonRef}
            type="button"
            disabled={review.recovering}
            onClick={review.cancelRecovery}
            className="btn-press rounded-md px-3 py-1.5 text-xs text-fg-muted transition duration-fast ease-out enabled:hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={review.recovering}
            onClick={() => void review.recoverPublication()}
            className="btn-press rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-wait disabled:opacity-50"
          >
            {review.recovering ? "Recovering..." : "Recover completed output"}
          </button>
        </div>
      </div>
    </div>
  );
}
