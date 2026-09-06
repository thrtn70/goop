import type { JobResult } from "@/types";

/** Measured results only; old history entries do not imply zero source bytes. */
export function outputSummary(result: JobResult | null | undefined): string | null {
  if (!result || result.bytes == null) return null;
  const output = Number(result.bytes);
  const source = result.source_bytes == null ? null : Number(result.source_bytes);
  const target = result.target_bytes == null ? null : Number(result.target_bytes);
  if (!Number.isSafeInteger(output) || output < 0) return null;
  const facts: string[] = [];
  if (source != null && Number.isSafeInteger(source) && source > 0) {
    const percent = Math.abs((source - output) / source * 100);
    facts.push(output === source ? "Same size as source" : `${Number(percent.toFixed(1))}% ${output < source ? "smaller" : "larger"} than source`);
  }
  if (target != null && Number.isSafeInteger(target) && target > 0) {
    facts.push(output <= target ? "Target met" : "Target missed");
  }
  if (result.reencoded === false) facts.push("Stream copied");
  return facts.length ? facts.join(" · ") : null;
}
