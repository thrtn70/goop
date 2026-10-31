import { useEffect, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";

export type HomeDirState = { status: "loading" } | { status: "ready"; dir: string } | { status: "failed" };

const LOADING: HomeDirState = { status: "loading" };
const FAILED: HomeDirState = { status: "failed" };

// One lookup per app run. A page that remounts finds the answer already here and never shows "loading".
let lookup: Promise<HomeDirState> | null = null;
let settled: HomeDirState | null = null;

function lookupHomeDir(): Promise<HomeDirState> {
  lookup ??= Promise.resolve()
    // Inside a then(): a runtime that throws instead of rejecting still ends up as `failed`.
    .then(() => homeDir())
    .then(
      (dir): HomeDirState => (typeof dir === "string" && dir !== "" ? { status: "ready", dir } : FAILED),
      (): HomeDirState => FAILED,
    )
    .then((state) => {
      settled = state;
      return state;
    });
  return lookup;
}

/** The user's home folder, resolved once and shared. `failed` means the folder is unknown, not that it is empty. */
export function useHomeDir(): HomeDirState {
  const [state, setState] = useState<HomeDirState>(() => settled ?? LOADING);

  useEffect(() => {
    let live = true;
    void lookupHomeDir().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);

  return state;
}

/** Forgets the shared lookup so a test can start from a cold app. */
export function __resetHomeDirCacheForTests(): void {
  lookup = null;
  settled = null;
}
