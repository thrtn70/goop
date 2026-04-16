import { useNavigate } from "react-router-dom";
import type { Job, JobState } from "@/types";
import { jobIdKey, useAppStore } from "@/store/appStore";
import { api } from "@/ipc/commands";

function isTerminal(s: JobState): boolean {
  if (typeof s === "string") return s === "done" || s === "cancelled";
  return "error" in s;
}

export default function HistoryPage() {
  const jobs = useAppStore((s) => s.jobs);
  const done = jobs.filter((j: Job) => isTerminal(j.state));
  const nav = useNavigate();

  return (
    <div className="p-6">
      <h2 className="mb-4 font-display text-lg font-semibold text-fg">History</h2>
      {done.length === 0 ? (
        <div className="enter-up flex flex-col items-center justify-center py-16 text-center">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-fg-muted/30">
            <circle cx="20" cy="20" r="14" />
            <path d="M20 12v8l5 3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="mt-3 text-sm text-fg-secondary">No finished jobs yet.</p>
          <p className="mt-1 text-xs text-fg-muted">Downloads and conversions show up here once they complete.</p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => nav("/extract")}
              className="btn-press rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
            >
              Download something
            </button>
            <button
              type="button"
              onClick={() => nav("/convert")}
              className="btn-press rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-secondary transition duration-fast ease-out hover:bg-surface-3"
            >
              Convert a file
            </button>
          </div>
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-fg-muted">
              <th className="pb-2">Type</th>
              <th className="pb-2">Output</th>
              <th className="pb-2">Size</th>
              <th className="pb-2">Time</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {done.map((j) => {
              const outputPath = j.result?.output_path ?? null;
              return (
                <tr key={jobIdKey(j.id)} className="border-t border-subtle">
                  <td className="py-2 text-fg-secondary">{String(j.kind)}</td>
                  <td className="max-w-xs truncate py-2 text-fg-secondary" title={outputPath ?? undefined}>
                    {outputPath ?? "\u2014"}
                  </td>
                  <td className="py-2 tabular-nums text-fg-secondary">
                    {j.result?.bytes != null
                      ? `${(Number(j.result.bytes) / 1024 / 1024).toFixed(1)} MB`
                      : "\u2014"}
                  </td>
                  <td className="py-2 tabular-nums text-fg-secondary">
                    {j.result != null
                      ? `${(Number(j.result.duration_ms) / 1000).toFixed(1)}s`
                      : "\u2014"}
                  </td>
                  <td className="py-2 text-right">
                    {outputPath && (
                      <button
                        type="button"
                        onClick={() => void api.queue.reveal(outputPath)}
                        className="btn-press text-xs text-accent transition duration-fast ease-out hover:text-accent-hover"
                      >
                        reveal
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
