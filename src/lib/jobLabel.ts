import type { Job } from "@/types";

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
}

/**
 * Something distinguishable to call a job in an accessible name. A failed job
 * produced no file, so `basename(output_path)` is "—" for every one of them
 * and several failed rows would otherwise all read as the same button.
 *
 * Shared by the History table and the History grid: both label a per-row
 * Retry, and both would otherwise fall back to the same empty filename.
 */
export function rowLabel(job: Job): string {
  const out = job.result?.output_path;
  if (out) return basename(out);
  const payload = job.payload as { url?: string; input_path?: string } | null;
  if (payload?.input_path) return basename(payload.input_path);
  if (payload?.url) {
    try {
      const url = new URL(payload.url);
      return `${url.hostname}${url.pathname.slice(0, 24)}`;
    } catch {
      return payload.url.slice(0, 32);
    }
  }
  return "download";
}
