import { expect, it } from "vitest";
import {
  conversionProblem,
  compressionProblem,
} from "@/features/workspace/readiness";
import type { ProbeState } from "@/hooks/useProbe";
import type { ImageAlphaCapabilities, ImageSettingsCapabilities } from "@/types";
const ready = {
  phase: "ready",
  probe: { source_kind: "video" },
  capabilities: {
    targets: [{ target: "mp4", available: true }],
    compression: { quality: true, target_size: false, lossless: false },
  },
} as unknown as ProbeState;
it("requires current inspection even for previously initialized drafts", () => {
  expect(
    conversionProblem(
      {
        target: "mp4",
        optionsReady: true,
        qualityPreset: null,
        resolutionCap: null,
        subtitle: null,
      },
      { phase: "probing" },
    ),
  ).toBeTruthy();
  expect(
    conversionProblem(
      {
        target: "mp4",
        optionsReady: true,
        qualityPreset: null,
        resolutionCap: null,
        subtitle: null,
      },
      ready,
    ),
  ).toBeNull();
  expect(
    compressionProblem({ kind: "target_size_bytes", value: 1000n }, ready),
  ).toBeTruthy();
  expect(
    conversionProblem(
      {
        target: "gif",
        optionsReady: true,
        qualityPreset: "small",
        resolutionCap: null,
        subtitle: null,
      },
      ready,
    ),
  ).toBeTruthy();
});

it("uses the selected output compression capabilities for changed presets", () => {
  const state = {phase:"ready", probe:{source_kind:"image"}, capabilities:{
    compression:{quality:false,target_size:false,lossless:true},
    targets:[{target:"jpeg",available:true,compression:{quality:true,target_size:true,lossless:false}},
      {target:"png",available:true,compression:{quality:false,target_size:false,lossless:true}}],
  }} as unknown as ProbeState;
  expect(compressionProblem({kind:"quality",value:75},state,"jpeg")).toBeNull();
  expect(compressionProblem({kind:"quality",value:75},state,"png")).toBeTruthy();
  expect(compressionProblem({kind:"lossless_reoptimize"},state,"png")).toBeNull();
  expect(compressionProblem({kind:"quality",value:75},state,"mp4")).toBeTruthy();
});

it("surfaces the selected target's explicit color readiness error", () => {
  const state = {phase:"ready", probe:{source_kind:"image"}, capabilities:{
    compression:{quality:false,target_size:false,lossless:true},
    targets:[{target:"png",available:true,image_color:{
      preserve:{available:true,reason:null,summary:"Keep existing color behavior."},
      convert_to_srgb:{available:false,reason:"The embedded profile cannot be transformed.",summary:"Color conversion unavailable."},
      assume_srgb:{available:false,reason:"The source already has a profile.",summary:"Assumption unavailable."},
    }}],
  }} as unknown as ProbeState;

  expect(conversionProblem({
    target:"png",
    optionsReady:true,
    qualityPreset:null,
    resolutionCap:null,
    subtitle:null,
    imageColorPolicy:"convert_to_srgb",
  }, state)).toBe("The embedded profile cannot be transformed.");
});

it("uses engine alpha capabilities to block unresolved transparency", () => {
  const state = {phase:"ready", probe:{source_kind:"image"}, capabilities:{
    compression:{quality:false,target_size:false,lossless:false},
    targets:[{target:"jpeg",available:true,image_color:{
      preserve:{available:true,reason:null,summary:"Preserve."},
      convert_to_srgb:{available:false,reason:"No profile.",summary:"Unavailable."},
      assume_srgb:{available:true,reason:null,summary:"Assume sRGB."},
    },image_alpha:{
      source_has_alpha:true,
      flatten:{available:true,reason:null,summary:"Flatten transparency."},
      required_color_policy:"assume_srgb",
      suggested_background:{red:255,green:255,blue:255},
    } satisfies ImageAlphaCapabilities}],
  }} as unknown as ProbeState;
  const file = {
    target:"jpeg" as const, optionsReady:true, qualityPreset:null, resolutionCap:null,
    subtitle:null, imageColorPolicy:"assume_srgb" as const,
  };

  expect(conversionProblem(file, state)).toMatch(/choose.*background/i);
  expect(conversionProblem({
    ...file,
    imageAlphaPolicy:{kind:"flatten",background:{red:17,green:34,blue:51}},
  }, state)).toBeNull();
});

it("does not duplicate the source matrix when the engine refuses alpha flattening", () => {
  const state = {phase:"ready", probe:{source_kind:"image"}, capabilities:{
    compression:{quality:false,target_size:false,lossless:false},
    targets:[{target:"jpeg",available:true,image_color:{
      preserve:{available:true,reason:null,summary:"Preserve."},
      convert_to_srgb:{available:false,reason:"No profile.",summary:"Unavailable."},
      assume_srgb:{available:true,reason:null,summary:"Assume sRGB."},
    },image_alpha:{
      source_has_alpha:true,
      flatten:{available:false,reason:"Transparent WebP is not supported yet.",summary:"Unavailable."},
      required_color_policy:null,
      suggested_background:{red:255,green:255,blue:255},
    } satisfies ImageAlphaCapabilities}],
  }} as unknown as ProbeState;
  expect(conversionProblem({
    target:"jpeg",optionsReady:true,qualityPreset:null,resolutionCap:null,subtitle:null,
    imageColorPolicy:"assume_srgb",
    imageAlphaPolicy:{kind:"flatten",background:{red:255,green:255,blue:255}},
  }, state)).toBe("Transparent WebP is not supported yet.");
});

it("retains but blocks a saved alpha policy on a non-JPEG target", () => {
  const state = {phase:"ready", probe:{source_kind:"image"}, capabilities:{
    compression:{quality:false,target_size:false,lossless:true},
    targets:[{target:"png",available:true}],
  }} as unknown as ProbeState;
  expect(conversionProblem({
    target:"png",optionsReady:true,qualityPreset:null,resolutionCap:null,subtitle:null,
    imageColorPolicy:"assume_srgb",
    imageAlphaPolicy:{kind:"flatten",background:{red:255,green:255,blue:255}},
  }, state)).toMatch(/only to JPEG/i);
});

it("keeps explicit opaque alpha intent subject to engine and color admission", () => {
  const capability = {
    source_has_alpha:false,
    flatten:{available:true,reason:null,summary:"Portable background."},
    required_color_policy:"assume_srgb",
    suggested_background:{red:255,green:255,blue:255},
  } satisfies ImageAlphaCapabilities;
  const file = {
    target:"jpeg" as const,optionsReady:true,qualityPreset:null,resolutionCap:null,subtitle:null,
    imageColorPolicy:"preserve" as const,
    imageAlphaPolicy:{kind:"flatten" as const,background:{red:255,green:255,blue:255}},
  };
  const readyWith = (imageAlpha: ImageAlphaCapabilities) => ({phase:"ready",probe:{source_kind:"image"},capabilities:{
    compression:{quality:false,target_size:false,lossless:false},
    targets:[{target:"jpeg",available:true,image_alpha:imageAlpha}],
  }}) as unknown as ProbeState;

  expect(conversionProblem(file, readyWith(capability))).toMatch(/Assume sRGB/i);
  expect(conversionProblem(file, readyWith({
    ...capability,
    flatten:{available:false,reason:"This opaque source is not admitted.",summary:"Unavailable."},
  }))).toBe("This opaque source is not admitted.");
});

it("uses the image-settings required color fact without changing legacy JPEG admission", () => {
  const settings = (required_color_policy: ImageSettingsCapabilities["required_color_policy"]) => ({
    available:true,reason:null,quality_min:1,quality_max:100,default_quality:75,
    max_dimension:32768,max_output_pixels:100_000_000,fit_within:true,upscale:false,
    preview_original_available:true,preview_fit_within:false,preview_unavailable_reason:"Fit preview unavailable.",
    required_color_policy,
  } satisfies ImageSettingsCapabilities);
  const readyWith = (imageSettings: ImageSettingsCapabilities) => ({phase:"ready",probe:{source_kind:"image"},capabilities:{
    compression:{quality:false,target_size:false,lossless:false},
    targets:[{target:"jpeg",available:true,image_settings:imageSettings,image_color:{
      preserve:{available:true,reason:null,summary:"Preserve."},
      convert_to_srgb:{available:true,reason:null,summary:"Convert."},
      assume_srgb:{available:true,reason:null,summary:"Assume."},
    }}],
  }}) as unknown as ProbeState;
  const file = {
    target:"jpeg" as const,optionsReady:true,qualityPreset:null,resolutionCap:null,subtitle:null,
    imageOptions:{jpeg_quality:75,resize:{kind:"original" as const}},
  };

  expect(conversionProblem({...file,imageColorPolicy:"preserve"}, readyWith(settings("assume_srgb")))).toMatch(/Assume sRGB/i);
  expect(conversionProblem({...file,imageColorPolicy:"assume_srgb"}, readyWith(settings("assume_srgb")))).toBeNull();
  expect(conversionProblem({...file,imageColorPolicy:"convert_to_srgb"}, readyWith(settings("convert_to_srgb")))).toBeNull();
  expect(conversionProblem({...file,imageColorPolicy:"preserve"}, readyWith(settings(null)))).toBeNull();
});
