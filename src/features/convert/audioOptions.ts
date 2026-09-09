import type {
  AudioBitrate,
  AudioChannels,
  AudioConvertOptions,
  AudioProbeDetails,
  AudioSampleRate,
  AudioSettingsCapabilities,
  GifOptions,
  ImageConvertOptions,
  QualityPreset,
  ResolutionCap,
  SubtitleOptions,
  TargetFormat,
  VideoConvertOptions,
} from "@/types";

export type { AudioBitrate, AudioChannels, AudioConvertOptions, AudioSampleRate };

export type AudioTarget = Extract<
  TargetFormat,
  "mp3" | "m4a" | "aac" | "wav" | "flac"
>;

export interface AudioAvailability {
  available: boolean;
  reason: string | null;
  copyAvailable: boolean;
  copyReason: string | null;
  encodeAvailable: boolean;
  encodeReason: string | null;
  targetCodec?: string;
  bitrateChoicesKbps?: readonly number[];
  defaultBitrateKbps?: number | null;
  defaultChannels?: AudioChannels | null;
  defaultSampleRate?: AudioSampleRate | null;
}

export interface AudioSourceFacts {
  audioStreamCount: number;
  sampleRateHz: number | null;
  channelCount: number | null;
  channelLayoutReported: boolean;
  hasNonAudioStreams: boolean;
}

export interface AudioDraftFile {
  target: TargetFormat;
  audioOptions?: AudioConvertOptions | null;
  audioAvailability?: AudioAvailability | null;
  audioSource?: AudioSourceFacts | null;
  audioBitrateDraft?: string;
  videoOptions?: VideoConvertOptions | null;
  imageOptions?: ImageConvertOptions | null;
  gifOptions?: GifOptions | null;
  compressMode?: unknown;
  subtitle?: SubtitleOptions | null;
  qualityPreset?: QualityPreset | null;
  resolutionCap?: ResolutionCap | null;
}

const AUDIO_TARGETS = new Set<TargetFormat>(["mp3", "m4a", "aac", "wav", "flac"]);
const MP3_BITRATES = [64, 96, 128, 160, 192, 256, 320] as const;
const AAC_BITRATES = [64, 96, 128, 160, 192, 256] as const;
const SAMPLE_RATES = new Set([44_100, 48_000]);
export const audioDraftSlots = ["AudioOptionsPanel.bitrateDraft"] as const;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

export function isAudioTarget(target: TargetFormat): target is AudioTarget {
  return AUDIO_TARGETS.has(target);
}

export function audioBitratesForTarget(target: TargetFormat): readonly number[] {
  if (target === "mp3") return MP3_BITRATES;
  if (target === "m4a" || target === "aac") return AAC_BITRATES;
  return [];
}

export function cloneAudioOptions(
  value: AudioConvertOptions | null | undefined,
): AudioConvertOptions | null {
  if (value == null) return null;
  if (value.kind === "copy") return { kind: "copy" };
  return {
    kind: "encode",
    bitrate: value.bitrate ? { ...value.bitrate } : null,
    channels: { ...value.channels },
    sample_rate: { ...value.sample_rate },
  };
}

export function defaultAudioOptions(
  target: TargetFormat,
  availability?: AudioAvailability | null,
): Extract<AudioConvertOptions, { kind: "encode" }> | null {
  if (!isAudioTarget(target)) return null;
  const choices = availability?.bitrateChoicesKbps ?? audioBitratesForTarget(target);
  return {
    kind: "encode",
    bitrate: choices.length ? { kind: "target", kbps: availability?.defaultBitrateKbps ?? 192 } : null,
    channels: { ...(availability?.defaultChannels ?? { kind: "preserve" }) },
    sample_rate: { ...(availability?.defaultSampleRate ?? { kind: "exact", hz: 48_000 }) },
  };
}

export function audioAvailability(
  settings: AudioSettingsCapabilities | null | undefined,
  targetAvailable: boolean,
  targetReason: string | null | undefined,
): AudioAvailability {
  return {
    available: targetAvailable && settings != null,
    reason: targetAvailable ? (settings ? null : "Explicit audio settings are unavailable for this output") : targetReason ?? "This output is unavailable for the source",
    copyAvailable: settings?.copy.available ?? false,
    copyReason: settings?.copy.reason ?? null,
    encodeAvailable: settings?.encode.available ?? false,
    encodeReason: settings?.encode.reason ?? null,
    targetCodec: settings?.target_codec,
    bitrateChoicesKbps: settings?.bitrate_choices_kbps,
    defaultBitrateKbps: settings?.default_bitrate_kbps ?? null,
    defaultChannels: settings?.default_channels ?? null,
    defaultSampleRate: settings?.default_sample_rate ?? null,
  };
}

export function audioSourceFacts(
  details: AudioProbeDetails | null | undefined,
  fallbackAudioStreamCount = 0,
  fallbackHasNonAudioStreams = false,
): AudioSourceFacts {
  const stream = details?.streams[0];
  return {
    audioStreamCount: details?.streams.length ?? fallbackAudioStreamCount,
    sampleRateHz: stream?.sample_rate_hz?.kind === "exact"
      ? stream.sample_rate_hz.value
      : null,
    channelCount: stream?.channels?.kind === "exact" ? stream.channels.value : null,
    channelLayoutReported: Boolean(stream?.channel_layout),
    hasNonAudioStreams: details?.has_non_audio_streams ?? fallbackHasNonAudioStreams,
  };
}

export function audioOptionsForTarget(
  value: AudioConvertOptions | null | undefined,
  target: TargetFormat,
): AudioConvertOptions | null {
  if (!value || !isAudioTarget(target)) return null;
  if (value.kind === "copy") return { kind: "copy" };
  const choices = audioBitratesForTarget(target);
  const bitrate = choices.length === 0
    ? null
    : value.bitrate && choices.includes(value.bitrate.kbps)
      ? { ...value.bitrate }
      : { kind: "target" as const, kbps: 192 };
  return { ...value, bitrate };
}

function validateChannels(value: unknown): AudioChannels {
  if (!object(value) || !only(value, ["kind"])) {
    throw new Error("Audio channels must be Preserve, Mono or Stereo");
  }
  if (value.kind === "preserve" || value.kind === "mono" || value.kind === "stereo") {
    return { kind: value.kind };
  }
  throw new Error("Audio channels must be Preserve, Mono or Stereo");
}

function validateSampleRate(value: unknown): AudioSampleRate {
  if (!object(value)) {
    throw new Error("Audio sample rate must be Preserve, 44.1 kHz or 48 kHz");
  }
  if (value.kind === "preserve" && only(value, ["kind"])) {
    return { kind: "preserve" };
  }
  if (
    value.kind === "exact" &&
    only(value, ["kind", "hz"]) &&
    typeof value.hz === "number" &&
    Number.isSafeInteger(value.hz) &&
    SAMPLE_RATES.has(value.hz)
  ) {
    return { kind: "exact", hz: value.hz };
  }
  throw new Error("Audio sample rate must be Preserve, 44.1 kHz or 48 kHz");
}

export function validateAudioOptions(value: unknown): AudioConvertOptions | null {
  if (value == null) return null;
  if (object(value) && value.kind === "copy" && only(value, ["kind"])) {
    return { kind: "copy" };
  }
  if (
    !object(value) ||
    value.kind !== "encode" ||
    !only(value, ["kind", "bitrate", "channels", "sample_rate"])
  ) {
    throw new Error("Audio options must specify Automatic, Copy or complete Custom encode settings");
  }
  let bitrate: AudioBitrate | null = null;
  if (value.bitrate != null) {
    if (
      !object(value.bitrate) ||
      value.bitrate.kind !== "target" ||
      !only(value.bitrate, ["kind", "kbps"]) ||
      typeof value.bitrate.kbps !== "number" ||
      !Number.isSafeInteger(value.bitrate.kbps)
    ) {
      throw new Error("Audio bitrate must be one of the target's supported choices");
    }
    bitrate = { kind: "target", kbps: value.bitrate.kbps };
  }
  return {
    kind: "encode",
    bitrate,
    channels: validateChannels(value.channels),
    sample_rate: validateSampleRate(value.sample_rate),
  };
}

type AudioRequest = {
  target: TargetFormat;
  audio_options?: unknown;
  video_options?: unknown;
  image_options?: unknown;
  gif_options?: unknown;
  compress_mode?: unknown;
  subtitle?: unknown;
  quality_preset?: unknown;
  resolution_cap?: unknown;
};

export function validateAudioRequest(request: AudioRequest): AudioConvertOptions | null {
  const options = validateAudioOptions(request.audio_options);
  if (!options) return null;
  if (!isAudioTarget(request.target)) {
    throw new Error("Explicit audio settings require MP3, M4A, AAC, WAV or FLAC output");
  }
  if (
    request.video_options != null ||
    request.image_options != null ||
    request.gif_options != null ||
    request.compress_mode != null ||
    request.subtitle != null ||
    request.quality_preset != null ||
    request.resolution_cap != null
  ) {
    throw new Error("Explicit audio settings cannot be combined with video, image, GIF, compression, subtitle, quality or resolution settings");
  }
  if (options.kind === "encode") {
    const choices = audioBitratesForTarget(request.target);
    if (choices.length === 0 && options.bitrate !== null) {
      throw new Error(`${request.target.toUpperCase()} Custom encode does not use a bitrate target`);
    }
    if (choices.length > 0 && (!options.bitrate || !choices.includes(options.bitrate.kbps))) {
      throw new Error(`${request.target.toUpperCase()} bitrate must be one of ${choices.join(", ")} kbps`);
    }
  }
  return cloneAudioOptions(options);
}

export function audioOptionsProblem(file: AudioDraftFile): string | null {
  if (!file.audioOptions) return null;
  try {
    validateAudioRequest({
      target: file.target,
      audio_options: file.audioOptions,
      video_options: file.videoOptions,
      image_options: file.imageOptions,
      gif_options: file.gifOptions,
      compress_mode: file.compressMode,
      subtitle: file.subtitle,
      quality_preset: file.qualityPreset,
      resolution_cap: file.resolutionCap,
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (file.audioOptions.kind === "encode" && audioBitratesForTarget(file.target).length > 0) {
    const raw = file.audioBitrateDraft ?? String(file.audioOptions.bitrate?.kbps ?? "");
    if (!/^\d+$/.test(raw) || !audioBitratesForTarget(file.target).includes(Number(raw))) {
      return `${file.target.toUpperCase()} bitrate must be one of ${audioBitratesForTarget(file.target).join(", ")} kbps`;
    }
  }
  if (file.audioSource && file.audioSource.audioStreamCount !== 1) {
    return "Explicit audio settings need exactly one audio track. Track selection is not available yet.";
  }
  if (file.audioAvailability) {
    if (!file.audioAvailability.available) {
      return file.audioAvailability.reason ?? "Audio settings are unavailable for this output";
    }
    if (file.audioOptions.kind === "copy" && !file.audioAvailability.copyAvailable) {
      return file.audioAvailability.copyReason ?? "Copy audio is unavailable for this source";
    }
    if (file.audioOptions.kind === "encode" && !file.audioAvailability.encodeAvailable) {
      return file.audioAvailability.encodeReason ?? "Custom audio encoding is unavailable for this source";
    }
  }
  if (
    file.audioOptions.kind === "encode" &&
    file.audioOptions.sample_rate.kind === "preserve" &&
    file.audioSource &&
    !SAMPLE_RATES.has(file.audioSource.sampleRateHz ?? 0)
  ) {
    return "Preserve sample rate requires a reported 44.1 or 48 kHz source. Choose an exact rate.";
  }
  return null;
}

export function audioRequestOptions(file: AudioDraftFile): AudioConvertOptions | null {
  const problem = audioOptionsProblem(file);
  if (problem) throw new Error(problem);
  return validateAudioRequest({
    target: file.target,
    audio_options: cloneAudioOptions(file.audioOptions),
    video_options: file.videoOptions,
    image_options: file.imageOptions,
    gif_options: file.gifOptions,
    compress_mode: file.compressMode,
    subtitle: file.subtitle,
    quality_preset: file.qualityPreset,
    resolution_cap: file.resolutionCap,
  });
}
