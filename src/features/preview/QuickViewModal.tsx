import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { Job } from "@/types";
import { createHandoff, type HandoffDestination } from "@/features/workspace/handoff";
import PreviewContent from "./PreviewContent";

interface QuickViewModalProps {
  job: Job | null;
  onClose: () => void;
}

const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "a[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Quick Look-style overlay. Backdrop click dismisses; the keyboard
 * handlers live in `useQuickView` so they survive backdrop focus changes.
 */
export default function QuickViewModal({ job, onClose }: QuickViewModalProps) {
  const nav = useNavigate();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (job) {
      if (!openerRef.current && document.activeElement instanceof HTMLElement) {
        openerRef.current = document.activeElement;
      }
      dialogRef.current?.focus();
      return;
    }
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && document.contains(opener)) opener.focus();
  }, [job]);

  useEffect(
    () => () => {
      const opener = openerRef.current;
      if (opener && document.contains(opener)) opener.focus();
    },
    [],
  );

  if (!job) return null;

  function handleHandoff(j: Job, destination: HandoffDestination) {
    const handoff = createHandoff(j, destination);
    if (!handoff) return;
    nav("/" + destination, { state: { handoff } });
    onClose();
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
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

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Quick view"
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      className="fixed inset-0 z-40 flex items-center justify-center bg-scrim/55 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="enter-up w-[680px] max-w-full overflow-hidden rounded-xl bg-surface-1 shadow-2xl">
        <PreviewContent
          job={job}
          variant="modal"
          onConvertAgain={job => handleHandoff(job, "convert")}
          onCompress={job => handleHandoff(job, "compress")}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
