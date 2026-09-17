import { expect, it } from "vitest";
import type { Job } from "@/types";
import { createHandoff, readHandoff } from "../handoff";
const job = {id:"source-job",kind:"extract",state:"done",result:{output_path:"/movie.mp4",result_kind:"file"}} as unknown as Job;
it("hands a completed extract to either tool with its origin retained", () => {
  const first = createHandoff(job,"compress");
  const second = createHandoff(job,"compress");
  expect(first).toMatchObject({sourceJobId:"source-job",path:"/movie.mp4",destination:"compress"});
  expect(first?.id).not.toBe(second?.id);
  expect(createHandoff(job,"convert")?.destination).toBe("convert");
});
it("excludes failures, folders and absent paths", () => {
  expect(createHandoff({...job,state:"cancelled"},"convert")).toBeNull();
  expect(createHandoff({...job,result:{...job.result!,result_kind:"folder"}},"convert")).toBeNull();
  expect(createHandoff({...job,result:null},"convert")).toBeNull();
});
it("accepts only matching destinations and validates navigation state", () => {
  const handoff = createHandoff(job,"compress");
  expect(readHandoff({handoff},"compress")).toEqual(handoff);
  expect(readHandoff({handoff},"convert")).toBeNull();
  expect(readHandoff({handoff:{path:[]}},"compress")).toBeNull();
});
