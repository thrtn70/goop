import { useNavigate } from "react-router-dom";
import type { Job } from "@/types";
import { api } from "@/ipc/commands";
import PreviewContent from "./PreviewContent";

interface QuickViewModalProps {
  job: Job | null;
  onClose: () => void;
}

/**
 * Quick Look-style overlay. Backdrop click dismisses; the keyboard
 * handlers live in `useQuickView` so they survive backdrop focus changes.
 */
export default function QuickViewModal({ job, onClose }: QuickViewModalProps) {
  const nav = useNavigate();
  if (!job) return null;

  function handleConvertAgain(j: Job) {
    const outputPath = j.result?.output_path;
    if (!outputPath) return;
    nav("/convert", { state: { prefill: { path: outputPath } } });
    onClose();
  }
  function handleReveal(path: string) {
    void api.queue.reveal(path);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quick view"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="enter-up w-[680px] max-w-full overflow-hidden rounded-xl bg-surface-1 shadow-2xl">
        <PreviewContent
          job={job}
          variant="modal"
          onConvertAgain={handleConvertAgain}
          onReveal={handleReveal}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
