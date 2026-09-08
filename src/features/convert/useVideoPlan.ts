import { useEffect, useState } from "react";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { ConvertRequest, VideoExecutionSummary } from "@/types";

type State = { summary: VideoExecutionSummary | null; error: string | null; busy: boolean };
type Pending = { request: ConvertRequest; retired: boolean; deliver: (state: State) => void };
// Retirement cannot cancel the native probe. Keep its slot across route lifetimes.
let active = false;
let pending: Pending | null = null;
function drain() {
  if (active || !pending) return;
  const next = pending;
  pending = null;
  if (next.retired) return;
  active = true;
  void (async () => {
    try {
      const summary = await api.convert.videoPlan(next.request);
      if (!next.retired) next.deliver({ summary, error: null, busy: false });
    } catch (error) {
      if (!next.retired) next.deliver({ summary: null, error: formatError(error), busy: false });
    } finally {
      active = false;
      queueMicrotask(drain);
    }
  })();
}
const idle: State = { summary: null, error: null, busy: false };
/** Read-only planning: one native call and at most one latest pending snapshot. */
export function useVideoPlan(request: ConvertRequest | null, sourceIdentity?: string) {
  const key = request ? JSON.stringify({request, sourceIdentity}, (_key, value: unknown) => typeof value === "bigint" ? Number(value) : value) : null;
  const [result, setResult] = useState<{ key: string | null; state: State }>({ key: null, state: idle });
  const [selection, setSelection] = useState(key);
  if (selection !== key) {
    setSelection(key);
    setResult({key:null,state:idle});
  }
  useEffect(() => {
    if (!key) return;
    const record: Pending = { request: (JSON.parse(key) as {request:ConvertRequest}).request, retired: false, deliver: state => setResult({key,state}) };
    const timer = setTimeout(() => {
      if (pending) pending.retired = true;
      pending = record;
      drain();
    }, 250);
    return () => {
      clearTimeout(timer);
      record.retired = true;
      if (pending === record) pending = null;
    };
  }, [key]);
  // Never display an old reply for even the first render of a new selection.
  return key === null ? idle : result.key === key ? result.state : { ...idle, busy: true };
}
