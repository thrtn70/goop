import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Job } from "@/types";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import {
  buildHandoff,
  noHandoffMessage,
  planHandoff,
  tooManyMessage,
  type HandoffDestination,
} from "./handoff";

const TOOL_LABELS: Readonly<Record<HandoffDestination, string>> = { convert: "Convert", compress: "Compress" };

// Shared by every entry point (History, Quick View, the queue): only the
// latest click may navigate or report, however its path check is timed.
let latestRequest = 0;

/**
 * Hand finished files and albums to Convert or Compress. Paths are checked
 * again where they are now; the destination adds them and queues nothing.
 * A handoff is dropped if a newer one starts, if you move to another page,
 * or if `active` turns false (a closed Quick View) before its check ends.
 */
export function useHandoff(active = true): (jobs: readonly Job[], destination: HandoffDestination) => Promise<boolean> {
  const navigate = useNavigate();
  const location = useLocation();
  const entry = useRef(location.key);
  const open = useRef(active);
  useEffect(() => {
    entry.current = location.key;
    open.current = active;
  }, [location.key, active]);
  const enqueueToast = useAppStore(state => state.enqueueToast);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(
    async (jobs, destination) => {
      const request = ++latestRequest;
      const startedOn = entry.current;
      const current = () =>
        request === latestRequest && mounted.current && open.current && entry.current === startedOn;
      const plan = planHandoff(jobs);
      if (plan.kind === "too_many") {
        enqueueToast({ variant: "info", title: tooManyMessage(destination, plan) });
        return false;
      }
      if (plan.kind === "none") {
        enqueueToast({ variant: "info", ...noHandoffMessage(destination, plan.skipped) });
        return false;
      }
      let resolved;
      try {
        resolved = await api.handoff.resolve(plan.candidates.map(candidate => candidate.source));
      } catch (error) {
        if (!current()) return false;
        enqueueToast({ variant: "error", title: `Couldn't hand off to ${TOOL_LABELS[destination]}`, detail: formatError(error) });
        return false;
      }
      if (!current()) return false;
      const handoff = buildHandoff(destination, plan, resolved);
      if (handoff.items.length === 0) {
        enqueueToast({ variant: "info", ...noHandoffMessage(destination, handoff.skipped) });
        return false;
      }
      navigate(`/${destination}`, { state: { handoff } });
      return true;
    },
    [enqueueToast, navigate],
  );
}
