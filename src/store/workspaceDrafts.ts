import { cloneVideoOptions } from "@/features/convert/videoOptions";
import { cloneAudioOptions, type AudioConvertOptions } from "@/features/convert/audioOptions";
import type { TrackConvertOptions, TrackPresetPolicy, VideoConvertOptions } from "@/types";
import { cloneImageAlphaPolicy } from "@/features/convert/imageAlphaPolicy";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, type ComponentType, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { create } from "zustand";
import {
  cloneTrackOptions,
  decodeDraftEntries,
  DRAFT_BACKUP_KEY,
  DRAFT_STORAGE_KEY,
  LEGACY_DRAFT_STORAGE_KEY,
  loadBrowserDraftEntriesOutcome,
  readDraftEntriesOutcome,
  saveDraftEntries,
  storedDraftValue,
  type DraftProtectionReason,
} from "./workspacePersistence";
import { cloneVideoTrackPolicyDraft, type VideoTrackPolicyDraft } from "@/features/convert/videoTrackOptions";

export type WorkspaceTool = "extract" | "convert" | "compress" | "image" | "metadata" | "recognize";
type DraftScope = { tool: WorkspaceTool; path: readonly string[]; sources: readonly string[] };
type DraftEntry = { value: unknown };
type DraftProtection = { kind: "load"; reason: DraftProtectionReason } | { kind: "migration"; legacyRaw: string } | null;
type DraftState = { entries: Record<string, DraftEntry>; epochs: Record<string, number>; scopeEpochs: Record<string, number>; completionEpochs: Record<string, number>; resetEpoch: number; revisions: Record<string, number>; persistenceFailed: boolean; recoveryFailed: boolean; protection: DraftProtection };
const initialDraftLoad = loadBrowserDraftEntriesOutcome();
const useDraftStore = create<DraftState>(() => ({
  entries: initialDraftLoad.kind === "protected" ? {} : initialDraftLoad.entries,
  epochs: {}, scopeEpochs: {}, completionEpochs: {}, resetEpoch: 0, revisions: {},
  persistenceFailed: initialDraftLoad.kind !== "ready",
  recoveryFailed: false,
  protection: initialDraftLoad.kind === "protected"
    ? { kind: "load", reason: initialDraftLoad.reason }
    : initialDraftLoad.kind === "migration_pending"
      ? { kind: "migration", legacyRaw: initialDraftLoad.legacy_raw }
      : null,
}));
useDraftStore.subscribe((state, previous) => {
  if (state.entries === previous.entries || typeof window === "undefined") return;
  if (state.protection !== null) return;
  let ok = false;
  try { ok = saveDraftEntries(window.localStorage, state.entries); } catch { /* Storage may be disabled. */ }
  if (state.persistenceFailed === ok) useDraftStore.setState({ persistenceFailed: !ok });
});
export function useDraftPersistenceFailed() { return useDraftStore(state => state.persistenceFailed); }

/**
 * Advances `revisions` in place, retiring every completion submitted before
 * this edit of `key`. Seeds and route restoration are not edits.
 */
function recordDraftEdit(revisions: Record<string, number>, key: string, sources: readonly string[]): void {
  const parts = JSON.parse(key) as string[];
  for (let length = 1; length < parts.length; length++) {
    const scopeKey = JSON.stringify(parts.slice(0, length));
    revisions[scopeKey] = (revisions[scopeKey] ?? 0) + 1;
  }
  for (const source of sources) {
    const sourceKey = JSON.stringify(["source-edit", parts[0], source]);
    revisions[sourceKey] = (revisions[sourceKey] ?? 0) + 1;
  }
}
/**
 * Saved values that replace this session's are edits made now: a completion
 * submitted before them cannot clear what it never saw. Values a load leaves
 * as they were keep their completion authority. Values compare as they are
 * stored, so a bigint or a set compares by what it holds.
 */
function hydratedRevisions(state: DraftState, entries: Record<string, DraftEntry>): Record<string, number> {
  const revisions = { ...state.revisions };
  for (const [key, entry] of Object.entries(entries)) {
    if (storedDraftValue(state.entries[key]?.value) === storedDraftValue(entry.value)) continue;
    // A key does not say which path parts are sources, so each one counts.
    recordDraftEdit(revisions, key, (JSON.parse(key) as string[]).slice(1, -1));
  }
  return revisions;
}
export function retryDraftPersistence() {
  try {
    const state = useDraftStore.getState();
    const read = readDraftEntriesOutcome(window.localStorage);
    if (read.kind === "protected") {
      useDraftStore.setState({ persistenceFailed: true, protection: { kind: "load", reason: read.reason } });
      return;
    }
    if (state.protection?.kind === "load") {
      if (read.kind === "empty") {
        const ok = saveDraftEntries(window.localStorage, state.entries);
        useDraftStore.setState(ok
          ? { persistenceFailed: false, protection: null }
          : { persistenceFailed: true });
        return;
      }
      const entries = read.kind === "v2" ? read.entries : read.kind === "legacy" ? read.entries : {};
      // Hydrate while protection is still active so the subscription cannot
      // turn an error-derived state into an authoritative write.
      useDraftStore.setState(current => ({ entries, revisions: hydratedRevisions(current, entries) }));
      if (read.kind === "legacy" && !saveDraftEntries(window.localStorage, entries)) {
        useDraftStore.setState({ persistenceFailed: true, protection: { kind: "migration", legacyRaw: read.legacy_raw } });
        return;
      }
      useDraftStore.setState({ persistenceFailed: false, protection: null });
      return;
    }
    if (state.protection?.kind === "migration") {
      if (read.kind === "v2") {
        useDraftStore.setState(current => ({ entries: read.entries, revisions: hydratedRevisions(current, read.entries) }));
        useDraftStore.setState({ persistenceFailed: false, protection: null });
        return;
      }
      if (read.kind === "empty") {
        useDraftStore.setState({ persistenceFailed: true });
        return;
      }
      const legacyChanged = read.legacy_raw !== state.protection.legacyRaw;
      const entries = legacyChanged ? read.entries : state.entries;
      if (legacyChanged) useDraftStore.setState(current => ({ entries, revisions: hydratedRevisions(current, entries) }));
      const ok = saveDraftEntries(window.localStorage, entries);
      useDraftStore.setState(ok
        ? { persistenceFailed: false, protection: null }
        : { persistenceFailed: true, protection: { kind: "migration", legacyRaw: read.legacy_raw } });
      return;
    }
    if (read.kind === "legacy") {
      useDraftStore.setState(current => ({ entries: read.entries, revisions: hydratedRevisions(current, read.entries), persistenceFailed: true, protection: { kind: "migration", legacyRaw: read.legacy_raw } }));
      return;
    }
    const ok = saveDraftEntries(window.localStorage, state.entries);
    useDraftStore.setState({ persistenceFailed: !ok });
  } catch { useDraftStore.setState({ persistenceFailed: true }); }
}
/**
 * Saved drafts a strict read refused as malformed. A newer Goop that changed
 * the format version is never offered; one that only added drafts is, and its
 * entries survive in the backup.
 */
export function useDraftRecoveryAvailable() {
  return useDraftStore(state => state.protection?.kind === "load" && state.protection.reason === "malformed");
}
export function useDraftRecoveryFailed() { return useDraftStore(state => state.recoveryFailed); }

// One copy per distinct unreadable save: a later recovery never replaces an
// earlier backup. Few slots, since each can hold a full save in shared storage.
const MAX_DRAFT_BACKUPS = 5;
function backUpUnreadableDrafts(storage: Pick<Storage, "getItem" | "setItem">, raw: string) {
  const keys = Array.from({ length: MAX_DRAFT_BACKUPS }, (_, index) => `${DRAFT_BACKUP_KEY}.${index}`);
  const existing = keys.map(key => storage.getItem(key));
  if (existing.includes(raw)) return;
  const free = existing.indexOf(null);
  if (free < 0) throw new Error("No room for another draft backup");
  storage.setItem(keys[free], raw);
}

/**
 * Backs up the saved drafts a strict read refused, then keeps every entry that
 * can still be read. Saved values win where both exist, as a retry would;
 * entries only this session has are kept. Nothing changes if the backup cannot
 * be written. Returns whether the recovered drafts were saved.
 */
export function recoverSavedDrafts(): boolean {
  if (useDraftStore.getState().protection?.kind !== "load") return false;
  let raw: string;
  try {
    const storage = window.localStorage;
    const read = readDraftEntriesOutcome(storage);
    // The saved drafts may have changed since launch; recover only refused ones.
    if (read.kind !== "protected" || read.reason !== "malformed") {
      retryDraftPersistence();
      return !useDraftStore.getState().persistenceFailed;
    }
    const saved = storage.getItem(DRAFT_STORAGE_KEY) ?? storage.getItem(LEGACY_DRAFT_STORAGE_KEY);
    if (saved === null) throw new Error("No saved drafts to recover");
    backUpUnreadableDrafts(storage, saved);
    raw = saved;
  } catch {
    useDraftStore.setState({ recoveryFailed: true });
    return false;
  }
  try {
    const entries = { ...useDraftStore.getState().entries, ...decodeDraftEntries(raw) };
    // Hydrate while protection is still active, so only the save below writes.
    useDraftStore.setState(current => ({ entries, revisions: hydratedRevisions(current, entries), recoveryFailed: false }));
    const ok = saveDraftEntries(window.localStorage, entries);
    useDraftStore.setState(ok ? { persistenceFailed: false, protection: null } : { persistenceFailed: true });
    return ok;
  } catch {
    useDraftStore.setState({ persistenceFailed: true });
    return false;
  }
}
const ScopeContext = createContext<DraftScope>({ tool: "convert", path: [], sources: [] });
const matches = (key: string, prefix: readonly string[]) => {
  const parts = JSON.parse(key) as string[];
  return prefix.every((part, i) => parts[i] === part);
};

function scopeLifetime(state: DraftState, path: readonly string[], includeCompletion = true) {
  let epoch = 0;
  for (let length = 1; length <= path.length; length++) {
    const key = JSON.stringify(path.slice(0, length));
    epoch += state.scopeEpochs[key] ?? 0;
    if (includeCompletion) epoch += state.completionEpochs[key] ?? 0;
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

/** Each editable video boundary owns its nested rate settings. */
function ownMediaDraft<T>(slot: string, value: T): T {
  if (slot === "AudioOptionsPanel.savedCustom") return cloneAudioOptions(value as AudioConvertOptions | null) as T;
  if (slot === "VideoOptionsPanel.savedCustom" || slot === "VideoOptionsPanel.savedSoftware") return cloneVideoOptions(value as VideoConvertOptions | null) as T;
  if (slot === "ConvertPage.files" && Array.isArray(value)) {
    return value.map(file => ({...file,
      ...(file.audioOptions === undefined ? {} : {audioOptions:cloneAudioOptions(file.audioOptions)}),
      ...(file.videoOptions === undefined ? {} : {videoOptions:cloneVideoOptions(file.videoOptions)}),
      ...(file.trackOptions === undefined ? {} : {trackOptions:cloneTrackOptions(file.trackOptions as TrackConvertOptions | null)}),
      ...(file.pendingTrackPolicy === undefined ? {} : {pendingTrackPolicy:file.pendingTrackPolicy ? structuredClone(file.pendingTrackPolicy as TrackPresetPolicy) : null}),
      ...(file.videoTrackPolicyDraft === undefined ? {} : {videoTrackPolicyDraft:cloneVideoTrackPolicyDraft(file.videoTrackPolicyDraft as VideoTrackPolicyDraft | null)}),
      ...(file.imageAlphaPolicy === undefined ? {} : {imageAlphaPolicy:cloneImageAlphaPolicy(file.imageAlphaPolicy)}),
    })) as T;
  }
  return value;
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
  const seed = useMemo(() => ownMediaDraft(slot, typeof initial === "function" ? (initial as () => T)() : initial), [key, epoch]);
  useEffect(() => {
    useDraftStore.setState(s => s.entries[key] ? s : { entries: { ...s.entries, [key]: { value: seed } } });
  }, [key, seed]);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    useDraftStore.setState(s => {
      if ((s.epochs[epochKey] ?? 0) !== epoch) return s;
      const current = s.entries[key] ? s.entries[key].value as T : seed;
      const nextValue = typeof next === "function" ? (next as (value: T) => T)(current) : next;
      const value = Object.is(current, nextValue) ? current : ownMediaDraft(slot, nextValue);
      if (Object.is(current, value) && s.entries[key]) return s;
      const revisions = { ...s.revisions };
      // A successful old callback may clear only the form values it submitted.
      recordDraftEdit(revisions, key, sources);
      return { entries: { ...s.entries, [key]: { value } }, revisions };
    });
  }, [epoch, epochKey, key, seed, slot, sources]);
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
  useDraftStore.setState(state => ({ entries: {}, epochs: {}, scopeEpochs: {}, completionEpochs: {}, revisions: {}, resetEpoch: state.resetEpoch + 1,
    ...(state.protection === null ? {} : { persistenceFailed: true, protection: state.protection }) }));
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
  useDraftStore.setState(state => ({ completionEpochs: {...state.completionEpochs, [key]: (state.completionEpochs[key] ?? 0) + 1} }));
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
  return scopeLifetime(state, [scope.tool, ...scope.path], false) + ":" + scope.sources.map(source => state.scopeEpochs[JSON.stringify(["source", scope.tool, source])] ?? 0).join(":");
}
export function getWorkspaceScopeLifetime(scope: DraftScope) {
  return runtimeScopeLifetime(useDraftStore.getState(), scope);
}
export function useWorkspaceScopeLifetime(scope: DraftScope) {
  return useDraftStore(state => runtimeScopeLifetime(state, scope));
}
/** Runtime callbacks share removal authority, but never edit persisted intent. */
export function useWorkspaceScope() { return useContext(ScopeContext); }

/** Parent readiness also observes forms whose inspector is currently unmounted. */
export function useWorkspaceDraftEntries() { return useDraftStore(state => state.entries); }
/** Calls the listener with the drafts after every change, for checks outside React. */
export function subscribeWorkspaceDraftEntries(listener: (entries: Record<string, DraftEntry>) => void) {
  return useDraftStore.subscribe((state, previous) => { if (state.entries !== previous.entries) listener(state.entries); });
}

/** An intentional settings replacement retires only its raw editor slots. */
export function clearWorkspaceDraftSlots(tool: WorkspaceTool, scope: readonly string[], slots: readonly string[]) {
  const keys = slots.map(slot => JSON.stringify([tool, ...scope, slot]));
  useDraftStore.setState(state => {
    const entries = { ...state.entries };
    const epochs = { ...state.epochs };
    for (const key of keys) { delete entries[key]; epochs[key] = (epochs[key] ?? 0) + 1; }
    return { entries, epochs };
  });
}
