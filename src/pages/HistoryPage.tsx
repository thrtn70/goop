import type { Job, JobState } from "@/types";
import { jobIdKey, useAppStore } from "@/store/appStore";

function isTerminal(s: JobState): boolean {
  if (typeof s === "string") return s === "done" || s === "cancelled";
  return "error" in s;
}

export default function HistoryPage() {
  const jobs = useAppStore((s) => s.jobs);
  const done = jobs.filter((j: Job) => isTerminal(j.state));

  return (
    <div className="p-6">
      <h2 className="mb-4 text-lg font-semibold">History</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-neutral-500">
            <th>Kind</th>
            <th>Output</th>
            <th>Size</th>
            <th>Dur</th>
          </tr>
        </thead>
        <tbody>
          {done.map((j) => (
            <tr key={jobIdKey(j.id)} className="border-t border-neutral-800">
              <td>{String(j.kind)}</td>
              <td>{j.result?.output_path ?? "—"}</td>
              <td>
                {j.result?.bytes != null
                  ? `${(Number(j.result.bytes) / 1024 / 1024).toFixed(1)} MB`
                  : "—"}
              </td>
              <td>
                {j.result != null
                  ? `${(Number(j.result.duration_ms) / 1000).toFixed(1)}s`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
