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
      },
      ready,
    ),
  ).toBeTruthy();
});
