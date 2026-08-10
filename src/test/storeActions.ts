// Test-only helper for restoring the app store's action bindings.
//
// Tests routinely swap an action for a spy — `useAppStore.setState({
// forgetJobs })` — to assert that a component called it. Zustand keeps that
// binding for the rest of the file, so a later test that exercises the real
// implementation silently runs the spy instead. The failure is quiet and
// non-local: the test that breaks is usually several describes away from the
// one that installed the spy.
//
// It also travels between actions. Several actions reach each other through
// `get()` (`trashJobs` calls `forgetJobs`), so a stale spy short-circuits the
// middle of a chain that a later test never stubbed at all.
//
// Suites that stub any action should call `restoreStoreActions()` from a
// file-level `beforeEach`. Restoring every action, rather than the one field a
// given test happens to stub, means new stubs need no new bookkeeping.

import { useAppStore } from "@/store/appStore";

type AppState = ReturnType<typeof useAppStore.getState>;

/**
 * Every top-level function on the store's state is an action — the state type
 * keeps its data as plain values and its nested shapes (`history`, `ui`) as
 * objects. That invariant is what makes `typeof value === "function"` a
 * complete and exact filter. A future state field holding a callback would
 * break it, and this helper would start clobbering that field between tests.
 */
function captureActions(): Partial<AppState> {
  const state = useAppStore.getState();
  const actions: Partial<AppState> = {};
  for (const key of Object.keys(state) as (keyof AppState)[]) {
    if (typeof state[key] !== "function") continue;
    // TypeScript can't tie a union-typed key to its own value type across a
    // write, so the assignment needs a cast. Read and write use the same key,
    // which is what makes the pairing sound.
    (actions as Record<string, unknown>)[key] = state[key];
  }
  return actions;
}

// Captured at import time, before any describe body or test has run, so this is
// always the store's own implementation rather than whatever a test left behind.
const realActions: Partial<AppState> = captureActions();

/** Put every store action back to the implementation the store shipped with. */
export function restoreStoreActions(): void {
  useAppStore.setState(realActions);
}
