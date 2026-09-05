import { createContext, createElement, useCallback, useContext, useEffect, useMemo, type ComponentType, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { create } from "zustand";

export type WorkspaceTool = "extract" | "convert" | "compress" | "image" | "metadata" | "recognize";
type DraftScope = { tool: WorkspaceTool; path: readonly string[] };
type DraftEntry = { value: unknown };
type DraftState = { entries: Record<string, DraftEntry>; epochs: Record<string, number> };
const useDraftStore = create<DraftState>(() => ({ entries: {}, epochs: {} }));
const ScopeContext = createContext<DraftScope>({ tool: "convert", path: [] });
const matches = (key: string, prefix: readonly string[]) => {
  const parts = JSON.parse(key) as string[];
  return prefix.every((part, i) => parts[i] === part);
};

/** Session only: source bytes, probes, previews and platform handles never belong here. */
export function WorkspaceDraftProvider({ tool, scope = [], children }: { tool?: WorkspaceTool; scope?: readonly string[]; children?: ReactNode }) {
  const parent = useContext(ScopeContext);
  const selectedTool = tool ?? parent.tool;
  const serialized = JSON.stringify(tool ? scope : [...parent.path, ...scope]);
  const value = useMemo(() => ({ tool: selectedTool, path: JSON.parse(serialized) as string[] }), [selectedTool, serialized]);
  return createElement(ScopeContext.Provider, { value }, children);
}

/** Wrap only the active component, adding data scope without another DOM node. */
export function withWorkspaceDrafts<P extends object>(Component: ComponentType<P>, tool?: WorkspaceTool, source?: (props: P) => readonly string[]) {
  return function WorkspaceScoped(props: P) {
    const parent = useContext(ScopeContext);
    const path = source?.(props) ?? [];
    const namespace = tool ?? parent.tool;
    const fullPath = tool ? path : [...parent.path, ...path];
    const onDone = "onDone" in props && typeof props.onDone === "function" ? props.onDone as () => void : null;
    const scopedProps = onDone ? { ...props, onDone: () => { clearWorkspaceDrafts(namespace, fullPath); onDone(); } } : props;
    return createElement(WorkspaceDraftProvider, { tool, scope: path }, createElement(Component, scopedProps));
  };
}

export function useWorkspaceDraftState<T>(slot: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const { tool, path } = useContext(ScopeContext);
  const key = JSON.stringify([tool, ...path, slot]);
  const epochKey = key;
  const epoch = useDraftStore(s => s.epochs[epochKey] ?? 0);
  const entry = useDraftStore(s => s.entries[key]);
  // A source change establishes new initial values; ordinary prop changes do
  // not overwrite an unfinished edit (same semantics as useState's initializer).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seed = useMemo(() => typeof initial === "function" ? (initial as () => T)() : initial, [key, epoch]);
  useEffect(() => {
    useDraftStore.setState(s => s.entries[key] ? s : { entries: { ...s.entries, [key]: { value: seed } } });
  }, [key, seed]);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    useDraftStore.setState(s => {
      if ((s.epochs[epochKey] ?? 0) !== epoch) return s;
      const current = s.entries[key] ? s.entries[key].value as T : seed;
      const value = typeof next === "function" ? (next as (value: T) => T)(current) : next;
      if (Object.is(current, value) && s.entries[key]) return s;
      return { entries: { ...s.entries, [key]: { value } } };
    });
  }, [epoch, epochKey, key, seed]);
  return [entry ? entry.value as T : seed, setValue];
}

export function clearWorkspaceDrafts(tool: WorkspaceTool, scope: readonly string[] = []) {
  useDraftStore.setState(s => ({
    entries: Object.fromEntries(Object.entries(s.entries).filter(([key]) => !matches(key, [tool, ...scope]))),
    // Only setters belonging to cleared slots are retired.
    epochs: Object.fromEntries([...new Set([...Object.keys(s.epochs), ...Object.keys(s.entries)])].map(key => [key, (s.epochs[key] ?? 0) + (matches(key, [tool, ...scope]) ? 1 : 0)])),
  }));
}

export function useClearWorkspaceScope() {
  const { tool, path } = useContext(ScopeContext);
  return useCallback(() => clearWorkspaceDrafts(tool, path), [tool, path]);
}

let consumedPickerToken = 0;
export function claimWorkspaceFilePicker(token: number) {
  if (token <= consumedPickerToken) return false;
  consumedPickerToken = token;
  return true;
}

export function resetWorkspaceDrafts() {
  consumedPickerToken = 0;
  useDraftStore.setState({ entries: {}, epochs: {} });
}

/** Explicit source removal retires its forms, including source-set batch scopes. */
export function forgetWorkspaceSource(tool: WorkspaceTool, source: string) {
  const keys = Object.keys(useDraftStore.getState().entries);
  for (const key of keys) {
    const parts = JSON.parse(key) as string[];
    if (parts[0] === tool && parts.slice(1, -1).includes(source)) {
      clearWorkspaceDrafts(tool, parts.slice(1, -1));
    }
  }
}
