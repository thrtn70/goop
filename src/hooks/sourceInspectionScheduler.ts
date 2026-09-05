import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { ProbeState } from "./useProbe";

type Pending = {
  path: string;
  retired: boolean;
  deliver: (state: ProbeState) => void;
};
// One slot across route lifetimes: retiring a consumer cannot cancel native decoding.
let active = false;
let pending: Pending[] = [];
function drain() {
  if (active) return;
  const next = pending.shift();
  if (!next) return;
  if (next.retired) {
    drain();
    return;
  }
  active = true;
  void (async () => {
    let result: ProbeState;
    try {
      const inspection = await api.convert.inspect(next.path);
      result = { phase: "ready", ...inspection };
    } catch (error) {
      result = { phase: "error", message: formatError(error) };
    }
    try {
      if (!next.retired) next.deliver(result);
    } finally {
      active = false;
      queueMicrotask(drain);
    }
  })().catch((error) => {
    console.error("Inspection consumer failed", error);
  });
}
export function scheduleInspection(
  path: string,
  deliver: Pending["deliver"],
): () => void {
  const record = { path, deliver, retired: false };
  pending.push(record);
  queueMicrotask(drain);
  return () => {
    record.retired = true;
    pending = pending.filter((item) => item !== record);
  };
}
