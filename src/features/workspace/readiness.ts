import type { ProbeState } from "@/hooks/useProbe";
import type { CompressMode } from "@/types";
import type { FileEntry } from "@/features/convert/ConvertActionBar";
export function conversionProblem(
  entry: Pick<
    FileEntry,
    "target" | "optionsReady" | "qualityPreset" | "resolutionCap"
  >,
  state: ProbeState,
): string | null {
  if (state.phase === "probing") return "Inspecting source…";
  if (state.phase === "error") return state.message;
  if (!entry.optionsReady) return "Preparing settings…";
  const target = state.capabilities.targets.find(
    (c) => c.target === entry.target,
  );
  if (!target?.available)
    return target?.reason ?? "Choose an available output format.";
  const quality =
    state.probe.source_kind === "video" &&
    ["mp4", "mkv", "webm", "mov"].includes(entry.target);
  const resolution =
    quality || (state.probe.source_kind === "video" && entry.target === "avi");
  if (
    (!quality && entry.qualityPreset && entry.qualityPreset !== "original") ||
    (!resolution && entry.resolutionCap && entry.resolutionCap !== "original")
  )
    return "Clear video settings that do not apply to this output.";
  return null;
}
export function compressionProblem(
  mode: CompressMode,
  state: ProbeState,
): string | null {
  if (state.phase === "probing") return "Inspecting source…";
  if (state.phase === "error") return state.message;
  const caps = state.capabilities.compression;
  const allowed =
    mode.kind === "quality"
      ? caps.quality
      : mode.kind === "target_size_bytes"
        ? caps.target_size
        : caps.lossless;
  return allowed
    ? null
    : (caps.reason ?? "Choose a supported compression mode.");
}
