import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import type { Job } from "@/types";
import { jobIdKey, useAppStore } from "@/store/appStore";
import { api } from "@/ipc/commands";
import PreviewContent from "./PreviewContent";

/**
 * Right-side slide-out preview panel for the History page. Shows the
 * currently selected terminal-state job's thumbnail + metadata + actions.
 * Renders nothing when nothing is selected; the panel's width stays 0 so
 * the list reclaims the full width.
 */
export default function PreviewPanel() {
  const nav = useNavigate();
  const selectedId = useAppStore((s) => s.history.previewSelectedId);
  const jobs = useAppStore((s) => s.history.jobs);
  const setPreview = useAppStore((s) => s.setHistoryPreview);

  const job = jobs.find((j) => jobIdKey(j.id) === selectedId) ?? null;
  if (!job) return null;

  function handleConvertAgain(j: Job) {
    const outputPath = j.result?.output_path;
    if (!outputPath) return;
    // Pre-fill Convert with the output file + a reasonable default target
    // (the prior target was part of the ConvertRequest payload; the fresh
    // Convert page will probe and pick a new default).
    nav("/convert", { state: { prefill: { path: outputPath } } });
  }

  function handleReveal(path: string) {
    void api.queue.reveal(path);
  }

  return (
    <aside
      aria-label="Preview"
      className="w-[380px] shrink-0 overflow-y-auto border-l border-subtle bg-surface-1 p-5"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-fg-muted">Preview</span>
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
        onConvertAgain={handleConvertAgain}
        onReveal={handleReveal}
      />
    </aside>
  );
}
