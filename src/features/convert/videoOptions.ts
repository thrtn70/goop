import type { ConvertRequest, VideoConvertOptions, VideoSettingsCapabilities } from "@/types";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
export const VIDEO_CONFLICT = "Explicit video settings cannot be combined with legacy quality, image, compression, GIF or subtitle settings";
export const VIDEO_CRF_ERROR = "Video CRF must be a whole number from 1 to 51";
export const VIDEO_BITRATE_ERROR = "Video bitrate must be a whole number from 100 to 200000 kbps";

export function cloneVideoOptions(value: VideoConvertOptions | null | undefined): VideoConvertOptions | null {
  if (value == null) return null;
  return value.kind === "copy" ? {kind:"copy"} : {kind:"encode",codec:value.codec,processor:value.processor,speed:value.speed,rate_control:{...value.rate_control}};
}
export function validateVideoOptions(value: unknown): VideoConvertOptions | null {
  if (value == null) return null;
  if (object(value) && value.kind === "copy" && only(value, ["kind"])) return {kind:"copy"};
  if (!object(value) || value.kind !== "encode" || !only(value,["kind","codec","processor","speed","rate_control"]) ||
      (value.codec !== "h264" && value.codec !== "hevc") || value.processor !== "software" ||
      (value.speed !== "fast" && value.speed !== "medium" && value.speed !== "slow") || !object(value.rate_control)) {
    throw new Error("video_options must specify Copy or complete software encode settings");
  }
  const rate = value.rate_control;
  if (rate.kind === "constant_quality" && only(rate,["kind","crf"])) {
    if (!integer(rate.crf,1,51)) throw new Error(VIDEO_CRF_ERROR);
    return {kind:"encode",codec:value.codec,processor:value.processor,speed:value.speed,rate_control:{kind:"constant_quality",crf:rate.crf}};
  }
  if (rate.kind === "average_bitrate" && only(rate,["kind","kbps"])) {
    if (!integer(rate.kbps,100,200000)) throw new Error(VIDEO_BITRATE_ERROR);
    return {kind:"encode",codec:value.codec,processor:value.processor,speed:value.speed,rate_control:{kind:"average_bitrate",kbps:rate.kbps}};
  }
  throw new Error("video_options rate_control must specify constant_quality CRF or average_bitrate kbps");
}
/** Structural wire validation, shared by presets and draft request projection. */
export function validateVideoRequest(request: Pick<ConvertRequest,"target"> & Partial<ConvertRequest>): VideoConvertOptions | null {
  const options = validateVideoOptions(request.video_options);
  if (!options) return null;
  if (!["mp4","mov","mkv"].includes(request.target)) throw new Error("Explicit video settings require MP4, MOV or MKV output");
  if (request.quality_preset != null || request.compress_mode != null || request.image_options != null || request.gif_options != null || request.subtitle != null) throw new Error(VIDEO_CONFLICT);
  if (options.kind === "copy" && request.resolution_cap != null && request.resolution_cap !== "original") throw new Error("Copy streams requires original resolution");
  return options;
}
export type VideoDraftText = Partial<Record<"crfDraft" | "bitrateDraft" | "appliedCrf" | "appliedBitrate", string>>;
export const videoDraftSlots = ["crfDraft","bitrateDraft","appliedCrf","appliedBitrate","savedCustom"].map(slot => `VideoOptionsPanel.${slot}`);
export interface VideoDraftFile {
  target: ConvertRequest["target"];
  videoOptions?: VideoConvertOptions | null;
  qualityPreset?: ConvertRequest["quality_preset"];
  resolutionCap?: ConvertRequest["resolution_cap"];
  imageOptions?: ConvertRequest["image_options"];
  gifOptions?: ConvertRequest["gif_options"];
  subtitle?: ConvertRequest["subtitle"];
  videoCapability?: VideoSettingsCapabilities | null;
  videoDraft?: VideoDraftText;
}
/** Raw text is authoritative while its applied numeric value still matches. */
function projected(file: VideoDraftFile): VideoConvertOptions | null {
  const options = validateVideoOptions(file.videoOptions);
  if (options?.kind === "encode") {
    const rate = options.rate_control;
    const crf = rate.kind === "constant_quality";
    const numeric = crf ? rate.crf : rate.kbps;
    const raw = file.videoDraft;
    const applied = crf ? raw?.appliedCrf : raw?.appliedBitrate;
    const typed = crf ? raw?.crfDraft : raw?.bitrateDraft;
    const text = applied == null || applied === String(numeric) ? typed ?? String(numeric) : String(numeric);
    if (!/^\d+$/.test(text) || !integer(Number(text),crf ? 1 : 100,crf ? 51 : 200000)) throw new Error(crf ? VIDEO_CRF_ERROR : VIDEO_BITRATE_ERROR);
    options.rate_control = crf ? {kind:"constant_quality",crf:Number(text)} : {kind:"average_bitrate",kbps:Number(text)};
  }
  return validateVideoRequest({target:file.target,video_options:options,quality_preset:null,resolution_cap:file.resolutionCap,image_options:file.imageOptions,gif_options:file.gifOptions,subtitle:file.subtitle});
}
export function videoOptionsError(file: VideoDraftFile): string | null {
  try {
    const options = projected(file);
    if (!options) return null;
    const caps = file.videoCapability;
    const mode = caps?.[options.kind];
    if (!mode?.available) return mode?.reason ?? "Video settings are unavailable for this source and target";
    if (options.kind === "encode") {
      const codec = caps?.codecs.find(codec => codec.codec === options.codec);
      if (!codec?.available) return codec?.reason ?? "Selected video encoder is unavailable";
      if (!caps?.speeds.includes(options.speed) || caps.processor !== options.processor) return "Selected video speed or processor is unavailable";
    }
    return null;
  } catch (error) { return error instanceof Error ? error.message : "Invalid video settings"; }
}
export function videoRequestOptions(file: VideoDraftFile): VideoConvertOptions | null {
  const error = videoOptionsError(file);
  if (error) throw new Error(error);
  return projected(file);
}
