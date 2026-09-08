import { describe, expect, it } from "vitest";
import { cloneVideoOptions, validateVideoOptions, videoOptionsError, videoRequestOptions } from "../videoOptions";
import type { VideoSettingsCapabilities } from "@/types";
const options = {kind:"encode",codec:"h264",processor:"software",speed:"medium",rate_control:{kind:"constant_quality",crf:23}} as const;
const capability: VideoSettingsCapabilities = {copy:{available:true},encode:{available:true},codecs:[{codec:"h264",encoder:"libx264",available:true,recommended_crf:23}],crf_min:1,crf_max:51,default_crf:23,bitrate_min_kbps:100,bitrate_max_kbps:200000,default_bitrate_kbps:5000,speeds:["fast","medium","slow"],default_speed:"medium",processor:"software",preview_available:false};
describe("video draft projection", () => {
  it("clones every nested level", () => {
    const copy = cloneVideoOptions(options);
    expect(copy).toEqual(options); expect(copy).not.toBe(options);
    if(copy?.kind === "encode") expect(copy.rate_control).not.toBe(options.rate_control);
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
});
