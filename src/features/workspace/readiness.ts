import type { ProbeState } from "@/hooks/useProbe";
import { imageOptionsProblem } from "@/features/convert/imageOptions";
import { subtitleForTarget } from "@/features/convert/FileRow";
import { imageColorPolicyProblem } from "@/features/metadata/ImageColorPolicyControl";
import { imageAlphaPolicyProblem } from "@/features/convert/imageAlphaPolicy";
import type { TargetFormat, CompressMode } from "@/types";
import type { FileEntry } from "@/features/convert/ConvertActionBar";
export function conversionProblem(
  entry: Pick<
    FileEntry,
    "target" | "optionsReady" | "qualityPreset" | "resolutionCap" | "subtitle" | "imageOptions" | "imageColorPolicy" | "imageAlphaPolicy"
  > & Partial<Pick<FileEntry, "gifOptions">>,
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
  const imageProblem = imageOptionsProblem(entry.imageOptions, target.image_settings);
  if (imageProblem) return imageProblem;
  const requiredImageColor = entry.imageOptions
    ? target.image_settings?.required_color_policy
    : null;
  if (requiredImageColor && (entry.imageColorPolicy ?? "preserve") !== requiredImageColor) {
    return requiredImageColor === "convert_to_srgb"
      ? "Convert this source to sRGB before using image settings."
      : "Confirm Assume sRGB before using image settings.";
  }
  const alphaProblem = imageAlphaPolicyProblem(entry.imageAlphaPolicy, target.image_alpha, entry.imageColorPolicy ?? "preserve", entry.target);
  if (alphaProblem) return alphaProblem;
  const colorProblem = imageColorPolicyProblem(entry.imageColorPolicy ?? "preserve", target.image_color);
  if (colorProblem) return colorProblem;
  if (entry.imageOptions && entry.gifOptions) return "Remove GIF settings before using image settings.";
  if (entry.imageOptions && entry.subtitle) return "Remove subtitles before using image settings.";
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
