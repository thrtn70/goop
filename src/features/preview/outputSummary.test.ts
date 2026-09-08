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
it("uses actual per-stream execution facts and labels legacy video only with known job context", () => {
  const execution = {requested:{kind:"encode",codec:"hevc",rate_control:{kind:"average_bitrate",kbps:5000},speed:"slow",processor:"software"},encoder:"libx265",video_codec:"hevc",video_stream_index:0,audio_stream_index:1,audio_codec:"aac",audio_copied:false,width:854,height:480,notices:["Color tags are unspecified"]};
  const summary = outputSummary(result({video_execution:execution,reencoded:false}));
  expect(summary).toContain("libx265"); expect(summary).toContain("5000 kbps"); expect(summary).toContain("Slow"); expect(summary).toContain("AAC 192 kbps"); expect(summary).toContain("854 × 480"); expect(summary).not.toContain("Stream copied");
  expect(outputSummary(result({}),{kind:"convert",payload:{target:"mp4"}})).toContain("Detailed video configuration unavailable");
  expect(outputSummary(result({}),{kind:"convert",payload:{target:"jpeg"}})).not.toContain("video configuration");
});
it("keeps processing facts without byte measurements and never infers per-stream Copy from a legacy flag", () => {
  const legacy = outputSummary(result({bytes:null,reencoded:false}),{kind:"convert",payload:{target:"mp4"}});
  expect(legacy).toContain("Detailed video configuration unavailable");
  expect(legacy).not.toContain("Stream copied");
  const image = outputSummary(result({reencoded:false}),{kind:"convert",payload:{target:"jpeg"}});
  expect(image).not.toContain("Stream copied");
  expect(image).not.toContain("video configuration");
});
