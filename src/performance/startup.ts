import { invoke } from "@tauri-apps/api/core";

type StartupCallbacks = {
  enabled: () => Promise<boolean>;
  report: () => Promise<void>;
  afterFrame: (callback: () => void) => void;
};

/** Coordinates initial snapshots with a committed shell, once per page lifetime. */
export function createStartupCoordinator(callbacks: StartupCallbacks) {
  let shellReady = false;
  let initialDataReady = false;
  let scheduled = false;
  const maybeReport = () => {
    if (!shellReady || !initialDataReady || scheduled) return;
    scheduled = true;
    void callbacks.enabled().then((enabled) => {
      if (!enabled) return;
      callbacks.afterFrame(() => {
        // Instrumentation must never affect startup if the report is unwritable.
        void callbacks.report().catch(() => {});
      });
    }).catch(() => {});
  };
  return {
    markShellReady() { shellReady = true; maybeReport(); },
    markInitialDataReady(success = true) {
      if (success) initialDataReady = true;
      maybeReport();
    },
  };
}

const startup = createStartupCoordinator({
  enabled: () => invoke<boolean>("performance_status"),
  report: () => invoke<void>("performance_ready", { initialDataLoaded: true }),
  // Two frame callbacks leave a paint opportunity after React commits the
  // hydrated shell. This measures application readiness, not pixel presentation.
  afterFrame: (callback) => requestAnimationFrame(() => requestAnimationFrame(callback)),
});
export const markShellReady = startup.markShellReady;
export const markInitialDataReady = startup.markInitialDataReady;
