import { useEffect, useRef, useState, useCallback } from "react";
import { scheduleInspection } from "./sourceInspectionScheduler";
import type { ProbeState } from "./useProbe";
import type { EntryIdentity } from "@/features/workspace/entries";
export const PROBING: ProbeState = { phase: "probing" };
export function useSourceInspections(
  entries: (EntryIdentity & { path: string })[],
) {
  const [byId, setById] = useState<Record<string, ProbeState>>({});
  const records = useRef(new Map<string, () => void>());
  const [retries, setRetries] = useState<Record<string, number>>({});
  const sources = JSON.stringify(
    entries
      .filter((e) => e.id)
      .map((e) => [e.id, e.path, retries[e.id ?? ""] ?? 0]),
  );
  useEffect(() => {
    const wanted = JSON.parse(sources) as [string, string, number][];
    const keys = new Set(wanted.map((source) => JSON.stringify(source)));
    for (const [key, retire] of records.current) {
      if (!keys.has(key)) {
        retire();
        records.current.delete(key);
      }
    }
    for (const source of wanted) {
      const [id, path] = source;
      const key = JSON.stringify(source);
      if (records.current.has(key)) continue;
      setById((previous) => ({ ...previous, [id]: PROBING }));
      const retire = scheduleInspection(path, (state) =>
        setById((previous) => ({ ...previous, [id]: state })),
      );
      records.current.set(key, retire);
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
      current.forEach((retire) => retire());
      current.clear();
    };
  }, []);
  const retry = useCallback((id: string) => {
    for (const [key, retire] of records.current)
      if ((JSON.parse(key) as string[])[0] === id) {
        retire();
        records.current.delete(key);
      }
    setById((previous) => ({ ...previous, [id]: PROBING }));
    setRetries((previous) => ({ ...previous, [id]: (previous[id] ?? 0) + 1 }));
  }, []);
  return { byId, retry };
}
