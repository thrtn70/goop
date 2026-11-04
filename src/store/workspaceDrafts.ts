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
  saveDraftEntriesOutcome,
  type DraftProtectionReason,
  type DraftSaveOutcome,
} from "./workspacePersistence";
import { cloneVideoTrackPolicyDraft, type VideoTrackPolicyDraft } from "@/features/convert/videoTrackOptions";

export type WorkspaceTool = "extract" | "convert" | "compress" | "image" | "metadata" | "recognize";
type DraftScope = { tool: WorkspaceTool; path: readonly string[]; sources: readonly string[] };
type DraftEntry = { value: unknown };
type DraftProtection = { kind: "load"; reason: DraftProtectionReason } | { kind: "migration"; legacyRaw: string } | null;
export type DraftForgetFailure = "no_backup_room" | "failed";
// session: keys this launch seeded or wrote; every field on screen is one of them.
type DraftState = { entries: Record<string, DraftEntry>; epochs: Record<string, number>; scopeEpochs: Record<string, number>; completionEpochs: Record<string, number>; resetEpoch: number; revisions: Record<string, number>; persistence: DraftSaveOutcome; session: ReadonlySet<string>; recoveryFailed: boolean; forgetFailure: DraftForgetFailure | null; protection: DraftProtection };
const SAVED: DraftSaveOutcome = { kind: "ok" };
const WRITE_FAILED: DraftSaveOutcome = { kind: "write_failed" };
const initialDraftLoad = loadBrowserDraftEntriesOutcome();
const useDraftStore = create<DraftState>(() => ({
  entries: initialDraftLoad.kind === "protected" ? {} : initialDraftLoad.entries,
  epochs: {}, scopeEpochs: {}, completionEpochs: {}, resetEpoch: 0, revisions: {},
  persistence: initialDraftLoad.kind === "ready" ? SAVED : WRITE_FAILED,
  session: new Set(),
  recoveryFailed: false,
  forgetFailure: null,
  protection: initialDraftLoad.kind === "protected"
    ? { kind: "load", reason: initialDraftLoad.reason }
    : initialDraftLoad.kind === "migration_pending"
      ? { kind: "migration", legacyRaw: initialDraftLoad.legacy_raw }
      : null,
}));
const saveDrafts = (entries: Record<string, DraftEntry>) => saveDraftEntriesOutcome(window.localStorage, entries);
const sameOutcome = (a: DraftSaveOutcome, b: DraftSaveOutcome) =>
  a.kind === b.kind && (a.kind !== "full" || (b.kind === "full" && a.entries === b.entries && a.bytes === b.bytes));
useDraftStore.subscribe((state, previous) => {
  if (state.entries === previous.entries || typeof window === "undefined") return;
  if (state.protection !== null) return;
  let persistence: DraftSaveOutcome = WRITE_FAILED;
  try { persistence = saveDrafts(state.entries); } catch { /* Storage may be disabled. */ }
  if (!sameOutcome(state.persistence, persistence)) useDraftStore.setState({ persistence });
});
export function useDraftPersistenceFailed() { return useDraftStore(state => state.persistence.kind !== "ok"); }
export function useDraftPersistence() { return useDraftStore(state => state.persistence); }
// A pending operation never submitted saved values, so hydrating them retires
// cleanup in every tool they belong to, as a new operation choice does: its
// parent callback may remove any source of that tool, not just its own scope.
function hydrateSavedEntries(state: DraftState, saved: Record<string, DraftEntry>, entries = saved): Pick<DraftState, "entries" | "completionEpochs"> {
  const completionEpochs = { ...state.completionEpochs };
  for (const tool of new Set(Object.keys(saved).map(key => (JSON.parse(key) as string[])[0]))) {
    const toolKey = JSON.stringify([tool]);
    completionEpochs[toolKey] = (completionEpochs[toolKey] ?? 0) + 1;
  }
  return { entries, completionEpochs };
}
export function retryDraftPersistence() {
  try {
    const state = useDraftStore.getState();
    const read = readDraftEntriesOutcome(window.localStorage);
    if (read.kind === "protected") {
      useDraftStore.setState({ persistence: WRITE_FAILED, protection: { kind: "load", reason: read.reason } });
      return;
    }
    if (state.protection?.kind === "load") {
      if (read.kind === "empty") {
        const persistence = saveDrafts(state.entries);
        useDraftStore.setState(persistence.kind === "ok"
          ? { persistence, protection: null }
          : { persistence });
        return;
      }
      const entries = read.kind === "v2" ? read.entries : read.kind === "legacy" ? read.entries : {};
      // Hydrate while protection is still active so the subscription cannot
      // turn an error-derived state into an authoritative write.
      useDraftStore.setState(current => hydrateSavedEntries(current, entries));
      if (read.kind === "legacy") {
        const migrated = saveDrafts(entries);
        if (migrated.kind !== "ok") {
          useDraftStore.setState({ persistence: migrated, protection: { kind: "migration", legacyRaw: read.legacy_raw } });
          return;
        }
      }
      useDraftStore.setState({ persistence: SAVED, protection: null });
      return;
    }
    if (state.protection?.kind === "migration") {
      if (read.kind === "v2") {
        useDraftStore.setState(current => hydrateSavedEntries(current, read.entries));
        useDraftStore.setState({ persistence: SAVED, protection: null });
        return;
      }
      if (read.kind === "empty") {
        useDraftStore.setState({ persistence: WRITE_FAILED });
        return;
      }
      const legacyChanged = read.legacy_raw !== state.protection.legacyRaw;
      const entries = legacyChanged ? read.entries : state.entries;
      if (legacyChanged) useDraftStore.setState(current => hydrateSavedEntries(current, entries));
      const persistence = saveDrafts(entries);
      useDraftStore.setState(persistence.kind === "ok"
        ? { persistence, protection: null }
        : { persistence, protection: { kind: "migration", legacyRaw: read.legacy_raw } });
      return;
    }
    if (read.kind === "legacy") {
      useDraftStore.setState(current => ({ ...hydrateSavedEntries(current, read.entries), persistence: WRITE_FAILED, protection: { kind: "migration", legacyRaw: read.legacy_raw } }));
      return;
    }
    useDraftStore.setState({ persistence: saveDrafts(state.entries) });
  } catch { useDraftStore.setState({ persistence: WRITE_FAILED }); }
}
/**
 * Saved drafts a strict read refused as malformed. A newer Goop that changed
 * the format version is never offered; one that only added drafts is, and its
 * entries survive in the backup. An oversized save is never offered either:
 * recovery could read none of it.
 */
export function useDraftRecoveryAvailable() {
  return useDraftStore(state => state.protection?.kind === "load" && state.protection.reason === "malformed");
}
export function useDraftRecoveryFailed() { return useDraftStore(state => state.recoveryFailed); }

// One copy per distinct save: a later recovery or forget never replaces an
// earlier backup. Few slots, since each can hold a full save in shared storage.
// Returns false, writing nothing, when every slot holds another save.
const MAX_DRAFT_BACKUPS = 5;
function backUpSavedDrafts(storage: Pick<Storage, "getItem" | "setItem">, raw: string): boolean {
  const keys = Array.from({ length: MAX_DRAFT_BACKUPS }, (_, index) => `${DRAFT_BACKUP_KEY}.${index}`);
  const existing = keys.map(key => storage.getItem(key));
  if (existing.includes(raw)) return true;
  const free = existing.indexOf(null);
  if (free < 0) return false;
  storage.setItem(keys[free], raw);
  return true;
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
      return useDraftStore.getState().persistence.kind === "ok";
    }
    const saved = storage.getItem(DRAFT_STORAGE_KEY) ?? storage.getItem(LEGACY_DRAFT_STORAGE_KEY);
    if (saved === null) throw new Error("No saved drafts to recover");
    if (!backUpSavedDrafts(storage, saved)) throw new Error("No room for another draft backup");
    raw = saved;
  } catch {
    useDraftStore.setState({ recoveryFailed: true });
    return false;
  }
  try {
    const saved = decodeDraftEntries(raw);
    // Hydrate while protection is still active, so only the save below writes.
    useDraftStore.setState(current => ({ ...hydrateSavedEntries(current, saved, { ...current.entries, ...saved }), recoveryFailed: false }));
    const persistence = saveDrafts(useDraftStore.getState().entries);
    useDraftStore.setState(persistence.kind === "ok" ? { persistence, protection: null } : { persistence });
    return persistence.kind === "ok";
  } catch {
    useDraftStore.setState({ persistence: WRITE_FAILED });
    return false;
  }
}

const hasEarlierEntries = (state: DraftState) => Object.keys(state.entries).some(key => !state.session.has(key));
const savedEditsTooLarge = (state: DraftState) => state.protection?.kind === "load" && state.protection.reason === "oversized";
const canForgetEarlierDrafts = (state: DraftState) =>
  savedEditsTooLarge(state) || (state.persistence.kind === "full" && hasEarlierEntries(state));
/** A save over the limit at launch, which no reader here can restore. */
export function useDraftSavedEditsTooLarge() { return useDraftStore(savedEditsTooLarge); }
/** A save too large at launch, or a save over the limit holding entries from earlier sessions that Forget would drop. */
export function useDraftForgetAvailable() { return useDraftStore(canForgetEarlierDrafts); }
export function useDraftForgetFailure() { return useDraftStore(state => state.forgetFailure); }

// Saves Forget may back up and replace. A newer Goop's save, or one that
// cannot be read at all, is left alone; Try again handles those.
const FORGETTABLE_PROTECTION = new Set<DraftProtectionReason>(["oversized", "malformed"]);

/**
 * Backs up the saved drafts, then keeps only the entries this session seeded
 * or wrote and saves those. Nothing changes if the backup cannot be written.
 * A save readable again since launch is restored by Try again instead. Returns
 * whether the kept drafts were saved.
 */
export function forgetEarlierDrafts(): boolean {
  const state = useDraftStore.getState();
  if (!canForgetEarlierDrafts(state)) return false;
  try {
    const storage = window.localStorage;
    const read = readDraftEntriesOutcome(storage);
    if (read.kind === "protected" ? !FORGETTABLE_PROTECTION.has(read.reason) : state.protection?.kind === "load") {
      retryDraftPersistence();
      return useDraftStore.getState().persistence.kind === "ok";
    }
    const saved = storage.getItem(DRAFT_STORAGE_KEY) ?? storage.getItem(LEGACY_DRAFT_STORAGE_KEY);
    if (saved === null) throw new Error("No saved drafts to back up");
    if (!backUpSavedDrafts(storage, saved)) {
      useDraftStore.setState({ forgetFailure: "no_backup_room" });
      return false;
    }
  } catch {
    useDraftStore.setState({ forgetFailure: "failed" });
    return false;
  }
  // Clearing protection here lets the autosave subscription write the kept drafts.
  useDraftStore.setState(current => ({
    entries: Object.fromEntries(Object.entries(current.entries).filter(([key]) => current.session.has(key))),
    protection: null,
    forgetFailure: null,
  }));
  return useDraftStore.getState().persistence.kind === "ok";
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

// Copied only when a key is new, so a keystroke in a known field costs nothing here.
const withSessionKey = (session: ReadonlySet<string>, key: string): ReadonlySet<string> =>
  session.has(key) ? session : new Set([...session, key]);

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
    useDraftStore.setState(s => {
      const session = withSessionKey(s.session, key);
      if (s.entries[key]) return session === s.session ? s : { session };
      return { entries: { ...s.entries, [key]: { value: seed } }, session };
    });
  }, [key, seed]);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    useDraftStore.setState(s => {
      if ((s.epochs[epochKey] ?? 0) !== epoch) return s;
      const current = s.entries[key] ? s.entries[key].value as T : seed;
      const nextValue = typeof next === "function" ? (next as (value: T) => T)(current) : next;
      const value = Object.is(current, nextValue) ? current : ownMediaDraft(slot, nextValue);
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
      return { entries: { ...s.entries, [key]: { value } }, revisions, session: withSessionKey(s.session, key) };
    });
  }, [epoch, epochKey, key, seed, slot, sources, tool]);
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
    ...(state.protection === null ? {} : { persistence: WRITE_FAILED, protection: state.protection }) }));
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
