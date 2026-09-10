import type {
  TrackConvertOptions,
  TrackPresetPolicy,
  TrackPresetStreamPolicy,
  TrackStreamPolicy,
  VideoTrackSettingsCapabilities,
  TargetFormat,
  TrackSourceBinding,
} from "@/types";
import { cloneTrackOptions, cloneTrackSource, sameTrackSource } from "./trackOptions";

export type VideoTrackMode = "copy" | "custom";
export type VideoTrackFamily = "audio" | "subtitles";
export type VideoTrackPolicyDraft = { source: TrackSourceBinding; audio: TrackStreamPolicy; subtitles: TrackStreamPolicy };

export function cloneVideoTrackPolicyDraft(draft: VideoTrackPolicyDraft | null | undefined): VideoTrackPolicyDraft | null {
  if (!draft) return null;
  const clone = (policy: TrackStreamPolicy): TrackStreamPolicy => policy.kind === "choose"
    ? { kind: "choose", stream_indices: [...policy.stream_indices] }
    : { kind: policy.kind };
  return { source: cloneTrackSource(draft.source), audio: clone(draft.audio), subtitles: clone(draft.subtitles) };
}

export function completeVideoTrackOptions(draft: VideoTrackPolicyDraft): Extract<TrackConvertOptions, { kind: "video" }> | null {
  if ((draft.audio.kind === "choose" && draft.audio.stream_indices.length === 0)
    || (draft.subtitles.kind === "choose" && draft.subtitles.stream_indices.length === 0)) return null;
  return { kind: "video", ...cloneVideoTrackPolicyDraft(draft)! };
}

export function shouldOfferVideoTrackOptions({ target, explicit, enabled, settings, options, pendingPolicy }: {
  target: TargetFormat;
  explicit: boolean;
  enabled: boolean;
  settings: VideoTrackSettingsCapabilities | null | undefined;
  options: TrackConvertOptions | null | undefined;
  pendingPolicy: TrackPresetPolicy | null | undefined;
}): boolean {
  if (!explicit || !settings || !["mp4", "mov", "mkv"].includes(target)) return false;
  const retained = options?.kind === "video" || pendingPolicy?.kind === "video";
  const hasChoices = settings.audio_tracks.length > 1 || settings.subtitle_tracks.length > 0;
  return retained || (enabled && hasChoices);
}

export function cloneTrackPresetPolicy(policy: TrackPresetPolicy | null | undefined): TrackPresetPolicy | null {
  if (!policy) return null;
  return policy.kind === "audio"
    ? { kind: "audio", selection: { kind: "choose_per_file" } }
    : { kind: "video", audio: { kind: policy.audio.kind }, subtitles: { kind: policy.subtitles.kind } };
}

export function defaultVideoTrackOptions(
  settings: VideoTrackSettingsCapabilities,
): Extract<TrackConvertOptions, { kind: "video" }> {
  return {
    kind: "video",
    source: cloneTrackSource(settings.source),
    audio: { kind: "keep_all" },
    subtitles: { kind: "keep_all" },
  };
}

export function resolvedVideoTrackOptions(
  options: TrackConvertOptions | null | undefined,
  settings: VideoTrackSettingsCapabilities | null | undefined,
): Extract<TrackConvertOptions, { kind: "video" }> | null {
  if (options?.kind === "video") return cloneTrackOptions(options) as Extract<TrackConvertOptions, { kind: "video" }>;
  return settings ? defaultVideoTrackOptions(settings) : null;
}

function policyProblem(
  family: VideoTrackFamily,
  policy: TrackStreamPolicy,
  settings: VideoTrackSettingsCapabilities,
  mode: VideoTrackMode,
): string | null {
  const label = family === "audio" ? "audio" : "subtitle";
  const choices = family === "audio" ? settings.audio_tracks : settings.subtitle_tracks;
  const capabilities = family === "audio" ? settings.audio_policy : settings.subtitle_policy;
  const availability = capabilities[mode][policy.kind === "choose" ? "choose" : policy.kind];
  if (!availability.available) return availability.reason ?? `${policy.kind} is unavailable for ${label} streams`;
  if (policy.kind !== "choose") return null;
  if (policy.stream_indices.length === 0) return `Choose at least one ${label} stream, or select None.`;
  const wanted = new Set(policy.stream_indices);
  if (wanted.size !== policy.stream_indices.length) return `${label} choices cannot contain duplicates.`;
  const sourceOrder = choices.filter(choice => wanted.has(choice.track.index)).map(choice => choice.track.index);
  if (sourceOrder.length !== policy.stream_indices.length) return `A selected ${label} stream is no longer present.`;
  if (sourceOrder.some((index, position) => index !== policy.stream_indices[position])) return `${label} choices must stay in source order.`;
  for (const index of policy.stream_indices) {
    const choice = choices.find(candidate => candidate.track.index === index);
    const selected = choice?.[mode];
    if (!selected?.available) return selected?.reason ?? `Selected ${label} stream ${index} is unavailable.`;
  }
  return null;
}

export function videoTrackOptionsProblem({
  options,
  settings,
  mode,
  unavailableReason,
  pendingPolicy,
}: {
  options: TrackConvertOptions | null | undefined;
  settings: VideoTrackSettingsCapabilities | null | undefined;
  mode: VideoTrackMode;
  unavailableReason?: string | null;
  pendingPolicy?: TrackPresetPolicy | null;
}): string | null {
  if (pendingPolicy?.kind === "video" && (pendingPolicy.audio.kind === "choose_per_file" || pendingPolicy.subtitles.kind === "choose_per_file")) {
    return "Choose tracks for each source before converting.";
  }
  if (!settings) return unavailableReason ?? (options !== undefined
    ? "Video track selection requires a fresh source inspection. Reinspect the source."
    : null);
  const resolved = resolvedVideoTrackOptions(options, settings);
  if (!resolved) return "Video track settings are unavailable.";
  if (!sameTrackSource(resolved.source, settings.source)) return "The source changed after track selection. Choose the video tracks again.";
  return policyProblem("audio", resolved.audio, settings, mode)
    ?? policyProblem("subtitles", resolved.subtitles, settings, mode);
}

const portable = (policy: TrackStreamPolicy): TrackPresetStreamPolicy => policy.kind === "choose"
  ? { kind: "choose_per_file" }
  : { kind: policy.kind };

export function videoTrackPolicyForPreset(
  options: TrackConvertOptions | null | undefined,
): Extract<TrackPresetPolicy, { kind: "video" }> | null {
  if (options?.kind !== "video") return null;
  return { kind: "video", audio: portable(options.audio), subtitles: portable(options.subtitles) };
}

export function videoTrackOptionsFromPreset(
  policy: TrackPresetPolicy | null | undefined,
  settings: VideoTrackSettingsCapabilities | null | undefined,
): Extract<TrackConvertOptions, { kind: "video" }> | null {
  if (policy?.kind !== "video" || !settings) return null;
  if (policy.audio.kind === "choose_per_file" || policy.subtitles.kind === "choose_per_file") return null;
  return {
    kind: "video",
    source: cloneTrackSource(settings.source),
    audio: { kind: policy.audio.kind },
    subtitles: { kind: policy.subtitles.kind },
  };
}

export function appliedVideoTrackState({ policy, settings, preserved }: {
  policy: Extract<TrackPresetPolicy, { kind: "video" }>;
  settings: VideoTrackSettingsCapabilities | null | undefined;
  preserved?: TrackConvertOptions | null;
}): { trackOptions: TrackConvertOptions | null; pendingTrackPolicy: TrackPresetPolicy | null; videoTrackPolicyDraft: null } {
  const trackOptions = preserved?.kind === "video" ? cloneTrackOptions(preserved) : videoTrackOptionsFromPreset(policy, settings);
  return {
    trackOptions,
    pendingTrackPolicy: trackOptions ? null : cloneTrackPresetPolicy(policy),
    videoTrackPolicyDraft: null,
  };
}

export function withVideoTrackPolicy(
  options: Extract<TrackConvertOptions, { kind: "video" }>,
  family: VideoTrackFamily,
  policy: TrackStreamPolicy,
): Extract<TrackConvertOptions, { kind: "video" }> {
  return { ...options, [family]: policy.kind === "choose" ? { kind: "choose", stream_indices: [...policy.stream_indices] } : { kind: policy.kind } };
}
