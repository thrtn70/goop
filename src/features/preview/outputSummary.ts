import type { Job, JobResult, VideoExecutionSummary } from "@/types";

export function videoExecutionText(summary: VideoExecutionSummary): string {
  const codec = summary.video_codec === "h264" ? "H.264" : "HEVC";
  const options = summary.requested;
  const facts = options.kind === "copy" ? ["Video copied (" + codec + ")"] : [
    codec + " · " + (summary.encoder ?? "Encoder unavailable"),
    options.rate_control.kind === "constant_quality" ? "CRF " + options.rate_control.crf : options.rate_control.kbps + " kbps",
    options.speed[0].toUpperCase() + options.speed.slice(1), "Software",
  ];
  facts.push(summary.width + " × " + summary.height + " px upright");
  facts.push(summary.audio_stream_index == null ? "No audio" : summary.audio_copied ? "Audio copied (" + (summary.audio_codec ?? "codec unavailable") + ")" : summary.audio_codec === "aac" ? "Audio: AAC 192 kbps" : "Audio: " + (summary.audio_codec ?? "codec unavailable"));
  return [...facts, ...summary.notices].join(" · ");
}

/** Measured results only; old history entries do not imply zero source bytes. */
export function outputSummary(result: JobResult | null | undefined, job?: Pick<Job, "kind" | "payload">): string | null {
  if (!result) return null;
  const output = result.bytes == null ? null : Number(result.bytes);
  const source = result.source_bytes == null ? null : Number(result.source_bytes);
  const target = result.target_bytes == null ? null : Number(result.target_bytes);
  const measured = output != null && Number.isSafeInteger(output) && output >= 0;
  const facts: string[] = [];
  if (measured && output != null && source != null && Number.isSafeInteger(source) && source > 0) {
    const percent = Math.abs((source - output) / source * 100);
    facts.push(output === source ? "Same size as source" : `${Number(percent.toFixed(1))}% ${output < source ? "smaller" : "larger"} than source`);
  }
  if (measured && output != null && target != null && Number.isSafeInteger(target) && target > 0) {
    facts.push(output <= target ? "Target met" : "Target missed");
  }
  if (result.video_execution) facts.push(videoExecutionText(result.video_execution));
  else {
    if (result.reencoded === false) facts.push("No re-encode reported");
    const payload = job?.payload;
    const target = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.target : null;
    if (job?.kind === "convert" && typeof target === "string" && ["mp4","mov","mkv","webm","avi"].includes(target)) facts.push("Detailed video configuration unavailable");
  }
  return facts.length ? facts.join(" · ") : null;
}
