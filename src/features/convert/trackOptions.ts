import type {
  AudioConvertOptions,
  AudioModeAvailability,
  TrackChoiceCapability,
  TrackConvertOptions,
  TrackSettingsCapabilities,
  TrackPresetPolicy,
  TrackSourceBinding,
  TrackTextFact,
  VideoTrackSettingsCapabilities,
} from "@/types";
import type { VideoTrackPolicyDraft } from "./videoTrackOptions";

export interface TrackDraftFile {
  audioOptions?: AudioConvertOptions | null;
  trackOptions?: TrackConvertOptions | null;
  trackSettings?: TrackSettingsCapabilities | null;
  videoTrackSettings?: VideoTrackSettingsCapabilities | null;
  pendingTrackPolicy?: TrackPresetPolicy | null;
  videoTrackOptionsEnabled?: boolean;
  videoTrackPolicyDraft?: VideoTrackPolicyDraft | null;
  trackSourceUnavailableReason?: string | null;
}
type AudioTrackOptions = Extract<TrackConvertOptions, { kind: "audio" }>;

function cloneTextFact(fact: TrackTextFact): TrackTextFact {
  return fact.kind === "value" ? { kind: "value", value: fact.value } : { kind: fact.kind };
}

export function cloneTrackSource(source: TrackSourceBinding): TrackSourceBinding {
  return {
    ...source,
    inventory: {
      ...source.inventory,
      streams: source.inventory.streams.map((track) => ({
        ...track,
        codec_name: cloneTextFact(track.codec_name),
        container_stream_id: cloneTextFact(track.container_stream_id),
        language: cloneTextFact(track.language),
        title: cloneTextFact(track.title),
        disposition: {
          ...track.disposition,
          other: { ...track.disposition.other },
        },
      })),
    },
  };
}

export function cloneTrackOptions(
  options: TrackConvertOptions | null | undefined,
): TrackConvertOptions | null {
  if (!options) return null;
  if (options.kind === "video") {
    return {
      kind: "video",
      source: cloneTrackSource(options.source),
      audio: options.audio.kind === "choose"
        ? { kind: "choose", stream_indices: [...options.audio.stream_indices] }
        : { kind: options.audio.kind },
      subtitles: options.subtitles.kind === "choose"
        ? { kind: "choose", stream_indices: [...options.subtitles.stream_indices] }
        : { kind: options.subtitles.kind },
    };
  }
  return {
    kind: "audio",
    source: cloneTrackSource(options.source),
    stream_index: options.stream_index,
  };
}

export function sameTrackSource(
  left: TrackSourceBinding,
  right: TrackSourceBinding,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function selectedTrackChoice(
  settings: TrackSettingsCapabilities | null | undefined,
  options: TrackConvertOptions | null | undefined,
): TrackChoiceCapability | null {
  if (!settings || options?.kind !== "audio" || !sameTrackSource(settings.source, options.source)) return null;
  return settings.audio_choices.find((choice) => choice.track.index === options.stream_index) ?? null;
}

export function resolvedTrackOptions(
  options: TrackConvertOptions | null | undefined,
  settings: TrackSettingsCapabilities | null | undefined,
): AudioTrackOptions | null {
  if (options?.kind === "audio") return cloneTrackOptions(options) as AudioTrackOptions;
  if (!settings || settings.audio_choices.length !== 1) return null;
  return {
    kind: "audio",
    source: cloneTrackSource(settings.source),
    stream_index: settings.audio_choices[0].track.index,
  };
}

/** A different canonical file is a new choice; same-path mutations stay visible as stale. */
export function trackOptionsAfterSourceReplacement(
  options: TrackConvertOptions | null | undefined,
  settings: Pick<TrackSettingsCapabilities, "source"> | null | undefined,
): TrackConvertOptions | null | undefined {
  if (!options || !settings) return options;
  return options.source.canonical_path === settings.source.canonical_path ? options : null;
}

export function selectedTrackAvailability(
  settings: TrackSettingsCapabilities | null | undefined,
  options: TrackConvertOptions | null | undefined,
  mode: "copy" | "encode",
): AudioModeAvailability {
  const choice = selectedTrackChoice(settings, options);
  if (!choice) return { available: false, reason: "Choose an audio track for this source" };
  const availability = choice[mode];
  return { available: availability.available, reason: availability.reason ?? null };
}

export function trackSelectionProblem(file: TrackDraftFile): string | null {
  if (!file.audioOptions) return null;
  const settings = file.trackSettings;
  if (!settings) {
    if (file.trackSourceUnavailableReason) return file.trackSourceUnavailableReason;
    if (file.trackOptions !== undefined) {
      return "Audio track selection requires a fresh source inspection. Reinspect the source or use Automatic.";
    }
    return null;
  }
  if (settings.audio_choices.length === 0) return "No selectable audio track was found in this source.";
  const requested = file.trackOptions;
  if (requested && !sameTrackSource(requested.source, settings.source)) {
    return "The source changed after track selection. Choose an audio track again.";
  }
  const resolved = resolvedTrackOptions(requested, settings);
  if (!resolved) return "Choose an audio track for this source before converting.";
  const choice = selectedTrackChoice(settings, resolved);
  if (!choice) return "The selected audio track is no longer present. Choose an audio track again.";
  const availability = file.audioOptions.kind === "copy" ? choice.copy : choice.encode;
  if (!availability.available) {
    return availability.reason
      ?? `${file.audioOptions.kind === "copy" ? "Copy audio" : "Custom encode"} is unavailable for the selected track.`;
  }
  return null;
}

export function trackRequestOptions(file: TrackDraftFile): TrackConvertOptions | null {
  const problem = trackSelectionProblem(file);
  if (problem) throw new Error(problem);
  if (!file.audioOptions) return null;
  return resolvedTrackOptions(file.trackOptions, file.trackSettings);
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  eng: "English",
  es: "Spanish",
  spa: "Spanish",
  fr: "French",
  fra: "French",
  fre: "French",
  de: "German",
  deu: "German",
  ger: "German",
  ja: "Japanese",
  jpn: "Japanese",
  ko: "Korean",
  kor: "Korean",
  zh: "Chinese",
  zho: "Chinese",
  chi: "Chinese",
};

export function trackFactText(
  fact: TrackTextFact,
  field: "language" | "title" | "codec" | "id",
): string {
  const label = field === "id" ? "Stream ID" : field[0].toUpperCase() + field.slice(1);
  if (fact.kind === "missing") return `${label} not reported`;
  if (fact.kind === "malformed") return `${label} malformed`;
  if (field === "language") {
    const normalized = fact.value.trim().toLowerCase();
    return LANGUAGE_NAMES[normalized] ?? fact.value;
  }
  if (field === "codec") return fact.value.toUpperCase();
  return fact.value;
}
