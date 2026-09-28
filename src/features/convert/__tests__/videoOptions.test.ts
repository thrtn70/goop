import { describe, expect, it } from "vitest";
import { cloneVideoOptions, validateVideoOptions, videoOptionsError, videoRequestOptions } from "../videoOptions";
import type { VideoSettingsCapabilities } from "@/types";
const options = {kind:"encode",codec:"h264",processor:"software",speed:"medium",rate_control:{kind:"constant_quality",crf:23}} as const;
const transformed = {...options,
  resize:{kind:"fit_within",width:1920,height:1080},
  frame_rate:{kind:"constant",numerator:24000,denominator:1001},
} as const;
const hardware = {kind:"hardware_encode",codec:"h264",hardware_policy:{kind:"required"},rate_control:{kind:"average_bitrate",kbps:5000},
  resize:{kind:"fit_within",width:1920,height:1080},frame_rate:{kind:"constant",numerator:24000,denominator:1001}} as const;
const capability: VideoSettingsCapabilities = {copy:{available:true},encode:{available:true},codecs:[{codec:"h264",encoder:"libx264",available:true,recommended_crf:23}],crf_min:1,crf_max:51,default_crf:23,bitrate_min_kbps:100,bitrate_max_kbps:200000,default_bitrate_kbps:5000,speeds:["fast","medium","slow"],default_speed:"medium",processor:"software",
  resize:{available:true,min_dimension:2,max_dimension:32768,no_enlargement:true,default:{kind:"original"}},
  frame_rate:{available:true,default:{kind:"preserve"},constant_choices:[{label:"23.976",frame_rate:{kind:"constant",numerator:24000,denominator:1001}}]},preview_available:false,
  hardware:{available:true,codec:"h264",bitrate_min_kbps:100,bitrate_max_kbps:200000,default_bitrate_kbps:5000,
    resize:{available:true,min_dimension:2,max_dimension:32768,no_enlargement:true,default:{kind:"original"}},
    frame_rate:{available:true,default:{kind:"preserve"},constant_choices:[{label:"23.976",frame_rate:{kind:"constant",numerator:24000,denominator:1001}}]}},
} as VideoSettingsCapabilities;
describe("video draft projection", () => {
  it("clones every nested level", () => {
    const copy = cloneVideoOptions(transformed);
    expect(copy).toEqual(transformed); expect(copy).not.toBe(transformed);
    if(copy?.kind === "encode") {
      expect(copy.rate_control).not.toBe(transformed.rate_control);
      expect(copy.resize).not.toBe(transformed.resize);
      expect(copy.frame_rate).not.toBe(transformed.frame_rate);
    }
  });
  it("validates and deeply clones only the strict Hardware required wire", () => {
    expect(validateVideoOptions(hardware)).toEqual(hardware);
    const copy = cloneVideoOptions(hardware as never) as unknown as typeof hardware;
    expect(copy).toEqual(hardware);
    expect(copy).not.toBe(hardware);
    expect(copy.hardware_policy).not.toBe(hardware.hardware_policy);
    expect(copy.rate_control).not.toBe(hardware.rate_control);
    expect(copy.resize).not.toBe(hardware.resize);
    expect(copy.frame_rate).not.toBe(hardware.frame_rate);
    for (const invalid of [
      {...hardware,codec:"hevc"},
      {...hardware,hardware_policy:{kind:"preferred"}},
      {...hardware,hardware_policy:{kind:"required",fallback:true}},
      {...hardware,rate_control:{kind:"constant_quality",crf:23}},
      {...hardware,rate_control:{kind:"average_bitrate",kbps:99}},
      {...hardware,rate_control:{kind:"average_bitrate",kbps:200001}},
      {...hardware,speed:"medium"},
      {...hardware,processor:"software"},
      {...hardware,extra:null},
    ]) expect(() => validateVideoOptions(invalid)).toThrow();
  });
  it("keeps raw Hardware bitrate authoritative and blocks unavailable chosen intent", () => {
    const file = {target:"mp4" as const,videoOptions:hardware as never,videoCapability:capability,videoDraft:{hardwareBitrateDraft:"6000"}};
    expect(videoRequestOptions(file)).toMatchObject({kind:"hardware_encode",rate_control:{kind:"average_bitrate",kbps:6000}});
    expect(videoOptionsError({...file,videoDraft:{hardwareBitrateDraft:""}})).toMatch(/whole number from 100 to 200000/);
    expect(videoOptionsError({...file,videoCapability:{...capability,hardware:{...(capability as never as {hardware: object}).hardware,available:false,reason:"Hardware session unavailable"}} as never}))
      .toBe("Hardware session unavailable");
  });
  it("rejects unknown copy keys and fractional rates", () => {
    expect(() => validateVideoOptions({kind:"copy",speed:"fast"})).toThrow();
    expect(() => validateVideoOptions({...options,rate_control:{kind:"constant_quality",crf:23.1}})).toThrow();
  });
  it("blank active raw text blocks projection while Automatic settings remain dormant", () => {
    const file = {target:"mp4" as const,qualityPreset:"balanced" as const,videoOptions:options,videoCapability:capability,videoDraft:{crfDraft:""}};
    expect(videoOptionsError(file)).toMatch(/whole number from 1 to 51/);
    expect(() => videoRequestOptions(file)).toThrow(/whole number/);
    expect(videoRequestOptions({...file,videoDraft:{crfDraft:"31"}})?.kind).toBe("encode");
    expect(videoRequestOptions({...file,videoOptions:null})).toBeNull();
  });
  it("checks source admission and copy transforms", () => {
    expect(videoOptionsError({target:"mp4",videoOptions:options})).toMatch(/unavailable/);
    expect(videoOptionsError({target:"mp4",videoOptions:{kind:"copy"},resolutionCap:"r720p",videoCapability:capability})).toMatch(/original resolution/);
  });

  it("validates exact resize and frame-rate discriminated unions", () => {
    expect(validateVideoOptions(transformed)).toEqual(transformed);
    expect(validateVideoOptions({...options,resize:{kind:"original"},frame_rate:{kind:"preserve"}}))
      .toEqual({...options,resize:{kind:"original"},frame_rate:{kind:"preserve"}});
    expect(() => validateVideoOptions({...options,resize:{kind:"fit_within",width:1,height:1080}})).toThrow(/2 to 32768/);
    expect(() => validateVideoOptions({...options,resize:{kind:"original",width:1920}})).toThrow(/resize/);
    expect(() => validateVideoOptions({...options,frame_rate:{kind:"constant",numerator:48,denominator:1}})).toThrow(/frame rate/);
    expect(() => validateVideoOptions({...options,frame_rate:{kind:"preserve",numerator:24}})).toThrow(/frame rate/);
  });

  it("projects authoritative raw FitWithin dimensions without coupling frame rate", () => {
    const file = {target:"mp4" as const,videoOptions:transformed,videoCapability:capability,
      videoDraft:{widthDraft:"1280",heightDraft:"720",appliedWidth:"1920",appliedHeight:"1080"}};
    expect(videoRequestOptions(file)).toMatchObject({resize:{kind:"fit_within",width:1280,height:720},
      frame_rate:{kind:"constant",numerator:24000,denominator:1001}});
    expect(videoOptionsError({...file,videoDraft:{...file.videoDraft,widthDraft:""}})).toMatch(/2 to 32768/);
    expect(videoRequestOptions({...file,videoOptions:{...transformed,resize:{kind:"original"}},videoDraft:{widthDraft:""}}))
      .toMatchObject({resize:{kind:"original"},frame_rate:transformed.frame_rate});
  });

  it("keeps legacy resolution conflicts scoped to explicit resize", () => {
    expect(videoOptionsError({target:"mp4",videoOptions:transformed,resolutionCap:"r720p",videoCapability:capability}))
      .toMatch(/legacy resolution/);
    expect(videoOptionsError({target:"mp4",videoOptions:{...options,frame_rate:{kind:"preserve"}},resolutionCap:"r720p",videoCapability:capability}))
      .toBeNull();
  });

  it("scopes unavailable source timing to the FPS editor", () => {
    const withoutTiming = {...capability,frame_rate:{...capability.frame_rate!,available:false,reason:"Source timing is unavailable"}};
    expect(videoOptionsError({target:"mp4",videoOptions:{...options,resize:{kind:"original"}},videoCapability:withoutTiming})).toBeNull();
    expect(videoOptionsError({target:"mp4",videoOptions:{...options,frame_rate:{kind:"preserve"}},videoCapability:withoutTiming}))
      .toBe("Source timing is unavailable");
  });
});
