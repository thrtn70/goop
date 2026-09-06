import { createContext, createElement, useCallback, useContext, useEffect, useMemo, type ComponentType, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { create } from "zustand";
import { loadBrowserDraftEntries, saveDraftEntries } from "./workspacePersistence";

export type WorkspaceTool = "extract" | "convert" | "compress" | "image" | "metadata" | "recognize";
type DraftScope = { tool: WorkspaceTool; path: readonly string[]; sources: readonly string[] };
type DraftEntry = { value: unknown };
type DraftState = { entries: Record<string, DraftEntry>; epochs: Record<string, number>; scopeEpochs: Record<string, number>; resetEpoch: number; revisions: Record<string, number>; persistenceFailed: boolean };
const useDraftStore = create<DraftState>(() => ({ entries: loadBrowserDraftEntries(), epochs: {}, scopeEpochs: {}, resetEpoch: 0, revisions: {}, persistenceFailed: false }));
useDraftStore.subscribe((state, previous) => {
  if (state.entries === previous.entries || typeof window === "undefined") return;
  let ok = false;
  try { ok = saveDraftEntries(window.localStorage, state.entries); } catch { /* Storage may be disabled. */ }
  if (state.persistenceFailed === ok) useDraftStore.setState({ persistenceFailed: !ok });
});
export function useDraftPersistenceFailed() { return useDraftStore(state => state.persistenceFailed); }
export function retryDraftPersistence() {
  try { useDraftStore.setState({ persistenceFailed: !saveDraftEntries(window.localStorage, useDraftStore.getState().entries) }); }
  catch { useDraftStore.setState({ persistenceFailed: true }); }
}
const ScopeContext = createContext<DraftScope>({ tool: "convert", path: [], sources: [] });
const matches = (key: string, prefix: readonly string[]) => {
  const parts = JSON.parse(key) as string[];
  return prefix.every((part, i) => parts[i] === part);
};

function scopeLifetime(state: DraftState, path: readonly string[]) {
  let epoch = 0;
  for (let length = 1; length <= path.length; length++) {
    epoch += state.scopeEpochs[JSON.stringify(path.slice(0, length))] ?? 0;
  }
  return `${state.resetEpoch}:${epoch}`;
}

/** Editable intent only: source bytes, probes, previews and platform handles never belong here. */
export function WorkspaceDraftProvider({ tool, scope = [], sourcePaths = [], children }: { tool?: WorkspaceTool; scope?: readonly string[]; sourcePaths?: readonly string[]; children?: ReactNode }) {
  const parent = useContext(ScopeContext);
  const selectedTool = tool ?? parent.tool;
  const serialized = JSON.stringify(tool ? scope : [...parent.path, ...scope]);
  const serializedSources = JSON.stringify([...new Set([...(tool ? [] : parent.sources), ...sourcePaths])]);
  const value = useMemo(() => ({ tool: selectedTool, path: JSON.parse(serialized) as string[], sources: JSON.parse(serializedSources) as string[] }), [selectedTool, serialized, serializedSources]);
  return createElement(ScopeContext.Provider, { value }, children);
}

/** Wrap only the active component, adding data scope without another DOM node. */
export function withWorkspaceDrafts<P extends object>(Component: ComponentType<P>, tool?: WorkspaceTool, source?: (props: P) => readonly string[]) {
  return function WorkspaceScoped(props: P) {
    const parent = useContext(ScopeContext);
    const path = source?.(props) ?? [];
    const namespace = tool ?? parent.tool;
    // Source callbacks return [scopeLabel, ...sourcePaths], not arbitrary nested labels.
    const sourcePaths = source ? path.slice(1) : [];
    const sources = [...new Set([...(tool ? [] : parent.sources), ...sourcePaths])];
    const fullPath = tool ? path : [...parent.path, ...path];
    const lifetimePath = [namespace, ...fullPath];
    const lifetime = useDraftStore(state => scopeLifetime(state, lifetimePath));
    const revisionKey = JSON.stringify(lifetimePath);
    const revision = useDraftStore(state => state.revisions[revisionKey] ?? 0);
    const sourceRevision = (state: DraftState) => JSON.stringify(sources.map(path => state.revisions[JSON.stringify(["source-edit", namespace, path])] ?? 0));
    const submittedSources = useDraftStore(sourceRevision);
    const onDone = "onDone" in props && typeof props.onDone === "function" ? props.onDone as () => void : null;
    const scopedProps = onDone ? { ...props, onDone: () => {
      // Removal/reset retires both cleanup and the parent callback, which may
      // itself remove sources. A route remount alone preserves this authority.
      const current = useDraftStore.getState();
      if (scopeLifetime(current, lifetimePath) !== lifetime || (current.revisions[revisionKey] ?? 0) !== revision || sourceRevision(current) !== submittedSources) return;
      clearWorkspaceDrafts(namespace, fullPath);
      onDone();
    } } : props;
    return createElement(WorkspaceDraftProvider, { tool, scope: path, sourcePaths }, createElement(Component, scopedProps));
  };
}

export function useWorkspaceDraftState<T>(slot: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const { tool, path, sources } = useContext(ScopeContext);
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
      const revisions = { ...s.revisions };
      const parts = JSON.parse(key) as string[];
      // A successful old callback may clear only the form values it submitted.
      // Seeds do not increment this counter; route restoration is not an edit.
      for (let length = 1; length < parts.length; length++) {
        const scopeKey = JSON.stringify(parts.slice(0, length));
        revisions[scopeKey] = (revisions[scopeKey] ?? 0) + 1;
      }
      for (const source of sources) {
        const sourceKey = JSON.stringify(["source-edit", tool, source]);
        revisions[sourceKey] = (revisions[sourceKey] ?? 0) + 1;
      }
      return { entries: { ...s.entries, [key]: { value } }, revisions };
    });
  }, [epoch, epochKey, key, seed, sources, tool]);
  return [entry ? entry.value as T : seed, setValue];
}

export function clearWorkspaceDrafts(tool: WorkspaceTool, scope: readonly string[] = []) {
  notifyRetirement({ tool, scope });
  const scopeKey = JSON.stringify([tool, ...scope]);
  useDraftStore.setState(s => ({
    scopeEpochs: { ...s.scopeEpochs, [scopeKey]: (s.scopeEpochs[scopeKey] ?? 0) + 1 },
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
  notifyRetirement({});
  consumedPickerToken = 0;
  useDraftStore.setState(state => ({ entries: {}, epochs: {}, scopeEpochs: {}, revisions: {}, resetEpoch: state.resetEpoch + 1 }));
}

/** Explicit source removal retires its forms, including source-set batch scopes. */
export function forgetWorkspaceSource(tool: WorkspaceTool, source: string) {
  notifyRetirement({ tool, source });
  const sourceKey = JSON.stringify(["source", tool, source]);
  useDraftStore.setState(state => ({scopeEpochs: {...state.scopeEpochs, [sourceKey]: (state.scopeEpochs[sourceKey] ?? 0) + 1}}));
  const keys = Object.keys(useDraftStore.getState().entries);
  for (const key of keys) {
    const parts = JSON.parse(key) as string[];
    if (parts[0] === tool && parts.slice(1, -1).includes(source)) {
      clearWorkspaceDrafts(tool, parts.slice(1, -1));
    }
  }
}

/** Runtime operations use tool identity, independently of editable draft lifetime. */
export function useWorkspaceTool() { return useContext(ScopeContext).tool; }

/** A new operation choice retires cleanup while keeping every editable value. */
export function retireWorkspaceCompletion(tool: WorkspaceTool) {
  const key = JSON.stringify([tool]);
  useDraftStore.setState(state => ({ scopeEpochs: {...state.scopeEpochs, [key]: (state.scopeEpochs[key] ?? 0) + 1} }));
}

export type WorkspaceRetirement = { tool?: WorkspaceTool; scope?: readonly string[]; source?: string };
const retirementListeners = new Set<(event: WorkspaceRetirement) => void>();
export function subscribeWorkspaceRetirement(listener: (event: WorkspaceRetirement) => void) {
  retirementListeners.add(listener);
  return () => { retirementListeners.delete(listener); };
}
function notifyRetirement(event: WorkspaceRetirement) {
  retirementListeners.forEach(listener => listener(event));
}
function runtimeScopeLifetime(state: DraftState, scope: DraftScope) {
  return scopeLifetime(state, [scope.tool, ...scope.path]) + ":" + scope.sources.map(source => state.scopeEpochs[JSON.stringify(["source", scope.tool, source])] ?? 0).join(":");
}
export function getWorkspaceScopeLifetime(scope: DraftScope) {
  return runtimeScopeLifetime(useDraftStore.getState(), scope);
}
export function useWorkspaceScopeLifetime(scope: DraftScope) {
  return useDraftStore(state => runtimeScopeLifetime(state, scope));
}
/** Runtime callbacks share removal authority, but never edit persisted intent. */
export function useWorkspaceScope() { return useContext(ScopeContext); }
