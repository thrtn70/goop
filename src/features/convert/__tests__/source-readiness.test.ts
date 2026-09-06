import { expect, it } from "vitest";
import {
  conversionProblem,
  compressionProblem,
} from "@/features/workspace/readiness";
import type { ProbeState } from "@/hooks/useProbe";
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
