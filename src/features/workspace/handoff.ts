import type { Job } from "@/types";
export type HandoffDestination = "convert" | "compress";
export interface Handoff {
  id: string;
  sourceJobId: string;
  path: string;
  destination: HandoffDestination;
}
export function createHandoff(job: Job, destination: HandoffDestination): Handoff | null {
  const path = job.result?.output_path;
  if (job.state !== "done" || job.result?.result_kind === "folder" || !path) return null;
  return {id:crypto.randomUUID(),sourceJobId:String(job.id),path,destination};
}
export function readHandoff(state: unknown, destination: HandoffDestination): Handoff | null {
  if (!state || typeof state !== "object" || !("handoff" in state)) return null;
  const value = state.handoff;
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<Handoff>;
  return typeof v.id === "string" && typeof v.sourceJobId === "string" && typeof v.path === "string" && v.path.length > 0 && v.destination === destination ? v as Handoff : null;
}
