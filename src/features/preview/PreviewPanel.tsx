import { X } from "lucide-react";
import type { Job } from "@/types";
import { jobIdKey, useAppStore } from "@/store/appStore";
import type { HandoffDestination } from "@/features/workspace/handoff";
import { useHandoff } from "@/features/workspace/useHandoff";
import PreviewContent from "./PreviewContent";

/**
 * Right-side slide-out preview panel for the History page. Shows the
 * currently selected terminal-state job's thumbnail + metadata + actions.
 * Renders nothing when nothing is selected; the panel's width stays 0 so
 * the list reclaims the full width.
 */
export default function PreviewPanel() {
  const handoff = useHandoff();
  const selectedId = useAppStore((s) => s.history.previewSelectedId);
  const jobs = useAppStore((s) => s.history.jobs);
  const setPreview = useAppStore((s) => s.setHistoryPreview);

  const job = jobs.find((j) => jobIdKey(j.id) === selectedId) ?? null;
  if (!job) return null;

  function handleHandoff(j: Job, destination: HandoffDestination) {
    void handoff([j], destination);
  }
  return (
    <aside
      aria-label="Preview"
      className="w-[380px] shrink-0 overflow-y-auto border-l border-subtle bg-surface-1 p-5"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-fg-muted">Preview</span>
        <button
          type="button"
          aria-label="Close preview"
          onClick={() => setPreview(null)}
          className="inline-flex items-center justify-center text-fg-muted transition duration-fast ease-out hover:text-fg"
        >
          <X size={14} strokeWidth={2.5} aria-hidden="true" />
        </button>
      </div>
      <PreviewContent
        job={job}
        variant="panel"
        onConvertAgain={job => handleHandoff(job, "convert")}
        onCompress={job => handleHandoff(job, "compress")}
      />
    </aside>
  );
}
