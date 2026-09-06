import type { ProbeState } from "@/hooks/useProbe";
import { subtitleForTarget } from "@/features/convert/FileRow";
import type { TargetFormat, CompressMode } from "@/types";
import type { FileEntry } from "@/features/convert/ConvertActionBar";
export function conversionProblem(
  entry: Pick<
    FileEntry,
    "target" | "optionsReady" | "qualityPreset" | "resolutionCap" | "subtitle"
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
  if (entry.subtitle && !subtitleForTarget(entry.subtitle, entry.target))
    return "Choose a supported subtitle mode or remove the subtitle before starting.";
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
  target?: TargetFormat,
): string | null {
  if (state.phase === "probing") return "Inspecting source…";
  if (state.phase === "error") return state.message;
  const output = state.capabilities.targets.find(c => c.target === target);
  if (target && !output?.available) return output?.reason ?? "Choose an available output format.";
  const caps = output?.compression ?? state.capabilities.compression;
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
