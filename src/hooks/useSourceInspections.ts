import { useEffect, useRef, useState, useCallback } from "react";
import {
  scheduleInspection,
  type RetireInspection,
} from "./sourceInspectionScheduler";
import type { ProbeState } from "./useProbe";
import type { EntryIdentity } from "@/features/workspace/entries";
export const PROBING: ProbeState = { phase: "probing" };
export function useSourceInspections(
  entries: (EntryIdentity & { path: string })[],
) {
  const [byId, setById] = useState<Record<string, ProbeState>>({});
  const records = useRef(new Map<string, RetireInspection>());
  const [retries, setRetries] = useState<Record<string, number>>({});
  const sources = JSON.stringify(
    entries
      .filter((e) => e.id)
      .map((e) => [e.id, e.path, retries[e.id ?? ""] ?? 0]),
  );
  useEffect(() => {
    const wanted = JSON.parse(sources) as [string, string, number][];
    const keys = new Set(wanted.map((source) => JSON.stringify(source)));
    for (const [key, retireInspection] of records.current) {
      if (!keys.has(key)) {
        retireInspection();
        records.current.delete(key);
      }
    }
    for (const source of wanted) {
      const [id, path] = source;
      const key = JSON.stringify(source);
      if (records.current.has(key)) continue;
      setById((previous) => ({ ...previous, [id]: PROBING }));
      const retireInspection = scheduleInspection(
        { sourceId: id, path },
        (state) => setById((previous) => ({ ...previous, [id]: state })),
      );
      records.current.set(key, retireInspection);
    }
    setById((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([id]) =>
          wanted.some((source) => source[0] === id),
        ),
      ),
    );
  }, [sources]);
  useEffect(() => {
    const current = records.current;
    return () => {
      current.forEach((retireInspection) => retireInspection());
      current.clear();
    };
  }, []);
  const retire = useCallback(
    (id: string, terminalCauseActionId?: number) => {
      for (const [key, retireInspection] of records.current) {
        if ((JSON.parse(key) as string[])[0] !== id) continue;
        retireInspection(terminalCauseActionId);
        records.current.delete(key);
      }
    },
    [],
  );
  const retry = useCallback((id: string) => {
    retire(id);
    setById((previous) => ({ ...previous, [id]: PROBING }));
    setRetries((previous) => ({ ...previous, [id]: (previous[id] ?? 0) + 1 }));
  }, [retire]);
  return { byId, retry, retire };
}
