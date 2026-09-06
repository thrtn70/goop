import { expect, it } from "vitest";
import { outputSummary } from "./outputSummary";
import type { JobResult } from "@/types";
const result = (fields: object) => ({bytes:100n,source_bytes:200n,...fields}) as JobResult;
it("reports actual savings, growth, and missing facts without invented savings", () => {
  expect(outputSummary(result({}))).toContain("50% smaller");
  expect(outputSummary(result({bytes:300n}))).toContain("50% larger");
  expect(outputSummary(result({source_bytes:null}))).toBeNull();
});
it("never presents a historical oversized output as meeting its target", () => {
  expect(outputSummary(result({target_bytes:80n}))).toContain("Target missed");
  expect(outputSummary(result({target_bytes:100n}))).toContain("Target met");
});
