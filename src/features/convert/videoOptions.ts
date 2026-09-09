import type { ConvertRequest, VideoConvertOptions, VideoFrameRate, VideoResize, VideoSettingsCapabilities } from "@/types";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
export const VIDEO_CONFLICT = "Explicit video settings cannot be combined with legacy quality, image, compression, GIF or subtitle settings";
export const VIDEO_CRF_ERROR = "Video CRF must be a whole number from 1 to 51";
export const VIDEO_BITRATE_ERROR = "Video bitrate must be a whole number from 100 to 200000 kbps";
export const VIDEO_DIMENSIONS_ERROR = "Video dimensions must be whole numbers from 2 to 32768 pixels";
export const VIDEO_WIDTH_ERROR = "Video width must be a whole number from 2 to 32768 pixels";
export const VIDEO_HEIGHT_ERROR = "Video height must be a whole number from 2 to 32768 pixels";
export const VIDEO_FRAME_RATE_ERROR = "Video frame rate must be one of the supported exact rates";

const VIDEO_FRAME_RATES = new Set([
  "24000/1001", "24/1", "25/1", "30000/1001", "30/1", "50/1", "60000/1001", "60/1",
]);

function cloneResize(value: VideoResize | null | undefined): VideoResize | null {
  return value == null ? null : { ...value };
}

function cloneFrameRate(value: VideoFrameRate | null | undefined): VideoFrameRate | null {
  return value == null ? null : { ...value };
}

export function cloneVideoOptions(value: VideoConvertOptions | null | undefined): VideoConvertOptions | null {
  if (value == null) return null;
  if (value.kind === "copy") return {kind:"copy"};
  return {kind:"encode",codec:value.codec,processor:value.processor,speed:value.speed,rate_control:{...value.rate_control},
    ...(value.resize === undefined ? {} : {resize:cloneResize(value.resize)}),
    ...(value.frame_rate === undefined ? {} : {frame_rate:cloneFrameRate(value.frame_rate)}),
  };
}

function validateResize(value: unknown): VideoResize | null {
  if (value == null) return null;
  if (!object(value)) throw new Error("video_options resize must specify Original or FitWithin dimensions");
  if (value.kind === "original" && only(value,["kind"])) return {kind:"original"};
  if (value.kind === "fit_within" && only(value,["kind","width","height"])) {
    if (!integer(value.width,2,32768) || !integer(value.height,2,32768)) throw new Error(VIDEO_DIMENSIONS_ERROR);
    return {kind:"fit_within",width:value.width,height:value.height};
  }
  throw new Error("video_options resize must specify Original or FitWithin dimensions");
}

function validateFrameRate(value: unknown): VideoFrameRate | null {
  if (value == null) return null;
  if (!object(value)) throw new Error("video_options frame rate must specify Preserve or a supported constant rate");
  if (value.kind === "preserve" && only(value,["kind"])) return {kind:"preserve"};
  if (value.kind === "constant" && only(value,["kind","numerator","denominator"]) &&
      integer(value.numerator,1,60000) && integer(value.denominator,1,1001) &&
      VIDEO_FRAME_RATES.has(`${value.numerator}/${value.denominator}`)) {
    return {kind:"constant",numerator:value.numerator,denominator:value.denominator};
  }
  throw new Error(VIDEO_FRAME_RATE_ERROR);
}
export function validateVideoOptions(value: unknown): VideoConvertOptions | null {
  if (value == null) return null;
  if (object(value) && value.kind === "copy" && only(value, ["kind"])) return {kind:"copy"};
  if (!object(value) || value.kind !== "encode" || !only(value,["kind","codec","processor","speed","rate_control","resize","frame_rate"]) ||
      (value.codec !== "h264" && value.codec !== "hevc") || value.processor !== "software" ||
      (value.speed !== "fast" && value.speed !== "medium" && value.speed !== "slow") || !object(value.rate_control)) {
    throw new Error("video_options must specify Copy or complete software encode settings");
  }
  const rate = value.rate_control;
  const resize = validateResize(value.resize);
  const frameRate = validateFrameRate(value.frame_rate);
  const extras = {
    ...(value.resize === undefined ? {} : {resize}),
    ...(value.frame_rate === undefined ? {} : {frame_rate:frameRate}),
  };
  if (rate.kind === "constant_quality" && only(rate,["kind","crf"])) {
    if (!integer(rate.crf,1,51)) throw new Error(VIDEO_CRF_ERROR);
    return {kind:"encode",codec:value.codec,processor:value.processor,speed:value.speed,rate_control:{kind:"constant_quality",crf:rate.crf},...extras};
  }
  if (rate.kind === "average_bitrate" && only(rate,["kind","kbps"])) {
    if (!integer(rate.kbps,100,200000)) throw new Error(VIDEO_BITRATE_ERROR);
    return {kind:"encode",codec:value.codec,processor:value.processor,speed:value.speed,rate_control:{kind:"average_bitrate",kbps:rate.kbps},...extras};
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
  if (options.kind === "encode" && options.resize != null && request.resolution_cap != null && request.resolution_cap !== "original") throw new Error("New video dimensions cannot be combined with a legacy resolution cap");
  return options;
}
export type VideoDraftText = Partial<Record<"crfDraft" | "bitrateDraft" | "appliedCrf" | "appliedBitrate" | "widthDraft" | "heightDraft" | "appliedWidth" | "appliedHeight", string>>;
export const videoDraftSlots = ["crfDraft","bitrateDraft","appliedCrf","appliedBitrate","widthDraft","heightDraft","appliedWidth","appliedHeight","savedCustom"].map(slot => `VideoOptionsPanel.${slot}`);
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
    if (options.resize?.kind === "fit_within") {
      const resize = options.resize;
      const dimension = (numeric: number, applied: string | undefined, typed: string | undefined, error: string) => {
        const value = applied == null || applied === String(numeric) ? typed ?? String(numeric) : String(numeric);
        if (!/^\d+$/.test(value) || !integer(Number(value),2,32768)) throw new Error(error);
        return Number(value);
      };
      options.resize = {kind:"fit_within",
        width:dimension(resize.width,raw?.appliedWidth,raw?.widthDraft,VIDEO_WIDTH_ERROR),
        height:dimension(resize.height,raw?.appliedHeight,raw?.heightDraft,VIDEO_HEIGHT_ERROR),
      };
    }
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
      if (options.resize != null && !caps?.resize?.available) return caps?.resize?.reason ?? "Video dimensions are unavailable for this source and target";
      if (options.frame_rate != null && !caps?.frame_rate?.available) return caps?.frame_rate?.reason ?? "Video frame rate is unavailable for this source and target";
      if (options.frame_rate?.kind === "constant") {
        const selectedFrameRate = options.frame_rate;
        if (!caps?.frame_rate?.constant_choices.some(choice => choice.frame_rate.kind === "constant" &&
          choice.frame_rate.numerator === selectedFrameRate.numerator && choice.frame_rate.denominator === selectedFrameRate.denominator)) {
          return VIDEO_FRAME_RATE_ERROR;
        }
      }
    }
    return null;
  } catch (error) { return error instanceof Error ? error.message : "Invalid video settings"; }
}
export function videoRequestOptions(file: VideoDraftFile): VideoConvertOptions | null {
  const error = videoOptionsError(file);
  if (error) throw new Error(error);
  return projected(file);
}
