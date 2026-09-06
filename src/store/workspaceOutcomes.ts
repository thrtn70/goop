import { useCallback, type Dispatch, type SetStateAction } from "react";
import { create } from "zustand";
import { getWorkspaceScopeLifetime, subscribeWorkspaceRetirement, useWorkspaceScope, useWorkspaceScopeLifetime } from "./workspaceDrafts";

type Scope = ReturnType<typeof useWorkspaceScope>;
type Entry = { value: unknown; scope: Scope; lifetime: string };
const useOutcomes = create<{ entries: Map<string, Entry> }>(() => ({ entries: new Map() }));
const operations = new Map<Scope, number>();
const scopeContains = (parent: Scope, child: Scope) => parent.tool === child.tool && parent.path.every((part, index) => child.path[index] === part);
const pinned = (entry: Entry) => [...operations.keys()].some(scope => scopeContains(scope, entry.scope));

/** Keep the submitted scope reachable until its Save/enqueue settles. */
export function pinWorkspaceOutcomes(scope: Scope) {
  operations.set(scope, (operations.get(scope) ?? 0) + 1);
  return () => {
    const count = (operations.get(scope) ?? 1) - 1;
    if (count) operations.set(scope, count); else operations.delete(scope);
  };
}
subscribeWorkspaceRetirement(event => {
  useOutcomes.setState(state => ({entries: new Map([...state.entries].filter(([, entry]) => {
    if (event.tool && event.tool !== entry.scope.tool) return true;
    if (event.source) return !entry.scope.sources.includes(event.source) && !entry.scope.path.includes(event.source);
    return event.scope ? !event.scope.every((part, index) => entry.scope.path[index] === part) : false;
  }))}));
});

/** Small transient outcomes only; text previews have their own session bound. */
export function useWorkspaceOutcomeState<T>(slot: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const scope = useWorkspaceScope();
  const key = JSON.stringify([scope.tool, ...scope.path, slot]);
  const lifetime = useWorkspaceScopeLifetime(scope);
  const entry = useOutcomes(state => state.entries.get(key));
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(next => {
    if (getWorkspaceScopeLifetime(scope) !== lifetime) return;
    useOutcomes.setState(state => {
      const existing = state.entries.get(key);
      const current = existing?.lifetime === lifetime ? existing.value as T : initial;
      const raw = typeof next === "function" ? (next as (value: T) => T)(current) : next;
      const value = typeof raw === "string" ? raw.slice(0, 8192) : raw;
      const entries = new Map(state.entries);
      if (!entries.has(key) && entries.size >= 100) {
        const oldest = [...entries].find(([, item]) => !pinned(item));
        if (!oldest) return state;
        entries.delete(oldest[0]);
      }
      entries.set(key, {value, scope, lifetime});
      return {entries};
    });
  }, [scope, key, lifetime, initial]);
  return [entry?.lifetime === lifetime ? entry.value as T : initial, setValue];
}
