import { useEffect, useState } from "react";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { ProbeResult } from "@/types";

/**
 * Probe lifecycle for a dropped / browsed file.
 *
 * Shared between `FileRow` (Convert) and `CompressFileRow` (Compress).
 * Returns a small state machine with retry support.
 *
 * `path` is the absolute filesystem path; it's passed through as the effect
 * dependency. Changing paths restarts the probe.
 */
export type ProbeState =
  | { phase: "probing" }
  | { phase: "ready"; probe: ProbeResult }
  | { phase: "error"; message: string };

export interface UseProbeResult {
  state: ProbeState;
  /** Re-run the probe. Use this for a user-facing "Retry" button. */
  retry: () => void;
}

export function useProbe(path: string): UseProbeResult {
  const [state, setState] = useState<ProbeState>({ phase: "probing" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "probing" });

    void api.convert
      .probe(path)
      .then((probe) => {
        if (cancelled) return;
        setState({ phase: "ready", probe });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ phase: "error", message: formatError(e) });
      });

    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  return {
    state,
    retry: () => setNonce((n) => n + 1),
  };
}
