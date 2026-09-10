import { useEffect, useRef, useState } from "react";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { AudioExecutionSummary, ConvertRequest, VideoExecutionSummary } from "@/types";

type PlanSummary = VideoExecutionSummary | AudioExecutionSummary;
type State<T extends PlanSummary> = { summary: T | null; error: string | null; busy: boolean };
export type VideoPlanEntry = { id: string; request: ConvertRequest; sourceIdentity?: string };
export type AudioPlanEntry = VideoPlanEntry;
type Pending = {
  token: symbol;
  kind: "video" | "audio";
  key: string;
  request: ConvertRequest;
  retired: boolean;
  timer?: ReturnType<typeof setTimeout>;
  deliver: (state: State<PlanSummary>) => void;
};
// A retired consumer cannot cancel native probing. Its slot survives route changes.
let active = false;
const pending = new Map<symbol, Pending>();
function drain() {
  if (active) return;
  const next = pending.values().next().value as Pending | undefined;
  if (!next) return;
  pending.delete(next.token);
  if (next.retired) { drain(); return; }
  active = true;
  void (async () => {
    try {
      const summary = next.kind === "video"
        ? await api.convert.videoPlan(next.request)
        : await api.convert.audioPlan(next.request);
      if (!next.retired) next.deliver({ summary, error: null, busy: false });
    } catch (error) {
      if (!next.retired) next.deliver({ summary: null, error: formatError(error), busy: false });
    } finally {
      active = false;
      queueMicrotask(drain);
    }
  })();
}
function retire(record: Pending) {
  record.retired = true;
  clearTimeout(record.timer);
  pending.delete(record.token);
}
const idle: State<PlanSummary> = { summary: null, error: null, busy: false };
const waiting: State<PlanSummary> = { ...idle, busy: true };
const serialize = (value: unknown) => JSON.stringify(value, (_key, field: unknown) => typeof field === "bigint" ? Number(field) : field);
type Result = { record: Pending; state: State<PlanSummary> };

/** One native call; at most one latest pending snapshot per current explicit row. */
function usePlans<T extends PlanSummary>(
  entries: VideoPlanEntry[],
  kind: Pending["kind"],
): Record<string, State<T>> {
  const snapshot = serialize(entries);
  const records = useRef(new Map<string, Pending>());
  const [results, setResults] = useState<Record<string, Result>>({});
  useEffect(() => {
    const wanted = JSON.parse(snapshot) as VideoPlanEntry[];
    const keys = new Map(wanted.map(entry => [entry.id, serialize(entry)]));
    for (const [id, record] of records.current) {
      if (keys.get(id) !== record.key) {
        retire(record);
        records.current.delete(id);
      }
    }
    for (const entry of wanted) {
      if (records.current.has(entry.id)) continue;
      const record: Pending = {
        token: Symbol(entry.id), kind, key: serialize(entry), request: entry.request, retired: false,
        deliver: state => setResults(previous => ({ ...previous, [entry.id]: { record, state } })),
      };
      records.current.set(entry.id, record);
      record.timer = setTimeout(() => {
        pending.set(record.token, record);
        drain();
      }, 250);
    }
    setResults(previous => Object.fromEntries(wanted.map(({id}) => {
      const record = records.current.get(id)!;
      return [id, previous[id]?.record === record ? previous[id] : { record, state: waiting }];
    })));
  }, [snapshot, kind]);
  useEffect(() => {
    const current = records.current;
    return () => { current.forEach(retire); current.clear(); };
  }, []);
  // Match during render too: edits immediately hide old disclosures, including A→B→A.
  return Object.fromEntries(entries.map(entry => {
    const result = results[entry.id];
    const current = result && !result.record.retired && result.record.key === serialize(entry);
    return [entry.id, current ? result.state : waiting];
  })) as Record<string, State<T>>;
}

export function useVideoPlans(entries: VideoPlanEntry[]): Record<string, State<VideoExecutionSummary>> {
  return usePlans<VideoExecutionSummary>(entries, "video");
}

export function useAudioPlans(entries: AudioPlanEntry[]): Record<string, State<AudioExecutionSummary>> {
  return usePlans<AudioExecutionSummary>(entries, "audio");
}

/** Single-selection adapter; shares the same native concurrency bound as batches. */
export function useVideoPlan(request: ConvertRequest | null, sourceIdentity?: string) {
  const plans = useVideoPlans(request ? [{id:"selected", request, sourceIdentity}] : []);
  return plans.selected ?? idle as State<VideoExecutionSummary>;
}
