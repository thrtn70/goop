import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
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

/**
 * Hand finished files and albums to Convert or Compress. Paths are checked
 * again where they are now; the destination adds them and queues nothing.
 */
export function useHandoff(): (jobs: readonly Job[], destination: HandoffDestination) => Promise<boolean> {
  const navigate = useNavigate();
  const enqueueToast = useAppStore(state => state.enqueueToast);
  return useCallback(
    async (jobs, destination) => {
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
        enqueueToast({ variant: "error", title: `Couldn't hand off to ${TOOL_LABELS[destination]}`, detail: formatError(error) });
        return false;
      }
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
