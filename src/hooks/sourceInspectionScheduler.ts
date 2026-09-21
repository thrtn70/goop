import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import {
  getResponsivenessRecorder,
  type CausalOwner,
} from "@/performance/responsiveness";
import type { ProbeState } from "./useProbe";

export type InspectionRequest = {
  sourceId: string;
  path: string;
};

type Pending = {
  request: InspectionRequest;
  retired: boolean;
  deliver: (state: ProbeState) => void;
  owner: CausalOwner | null;
  openSpanId: number | null;
};

export type RetireInspection = (terminalCauseActionId?: number) => void;

// One slot spans route lifetimes; retiring a consumer cannot cancel native decoding.
//
// setup(sourceId): queue span -> native span -> delivery span -> settled
//                            \-> retire: cancel open span/setup, hold slot until native exits
let active = false;
let pending: Pending[] = [];

function recordEvent(
  item: Pending,
  kind:
    | "inspection_queued"
    | "inspection_started"
    | "inspection_settled"
    | "inspection_delivered"
    | "inspection_cancelled",
) {
  if (!item.owner) return;
  getResponsivenessRecorder().recordEvent({
    owner: item.owner,
    spanId: item.openSpanId ?? undefined,
    kind,
    subjectId: item.request.sourceId,
  });
}

function startSpan(
  item: Pending,
  kind: "inspection_queue" | "inspection_native" | "inspection_delivery",
) {
  if (!item.owner) return;
  item.openSpanId = getResponsivenessRecorder().startSpan({
    owner: item.owner,
    kind,
    subjectId: item.request.sourceId,
  });
}

function endOpenSpan(item: Pending) {
  if (item.openSpanId === null) return;
  getResponsivenessRecorder().endSpan(item.openSpanId);
  item.openSpanId = null;
}

function cancel(item: Pending, terminalCauseActionId?: number) {
  if (item.retired) return;
  item.retired = true;
  if (!item.owner) return;
  recordEvent(item, "inspection_cancelled");
  if (item.openSpanId !== null) {
    getResponsivenessRecorder().cancelSpan(
      item.openSpanId,
      terminalCauseActionId,
    );
    item.openSpanId = null;
  }
  getResponsivenessRecorder().cancelSetup(item.owner);
}

function drain() {
  if (active) return;
  const next = pending.shift();
  if (!next) return;
  if (next.retired) {
    drain();
    return;
  }
  active = true;
  void (async () => {
    endOpenSpan(next);
    startSpan(next, "inspection_native");
    recordEvent(next, "inspection_started");
    let result: ProbeState;
    try {
      const inspection = await api.convert.inspect(next.request.path);
      result = { phase: "ready", ...inspection };
    } catch (error) {
      result = { phase: "error", message: formatError(error) };
    }
    try {
      if (!next.retired) {
        recordEvent(next, "inspection_settled");
        endOpenSpan(next);
        startSpan(next, "inspection_delivery");
        try {
          next.deliver(result);
        } catch (error) {
          cancel(next);
          throw error;
        }
        if (!next.retired) {
          recordEvent(next, "inspection_delivered");
          endOpenSpan(next);
          if (next.owner) {
            getResponsivenessRecorder().settleSetup(next.owner);
          }
        }
      }
    } finally {
      active = false;
      queueMicrotask(drain);
    }
  })().catch((error) => {
    console.error("Inspection consumer failed", error);
  });
}
export function scheduleInspection(
  request: InspectionRequest,
  deliver: Pending["deliver"],
): RetireInspection {
  const recorder = getResponsivenessRecorder();
  const owner = recorder.startSetup(request.sourceId);
  const record: Pending = {
    request: { sourceId: request.sourceId, path: request.path },
    deliver,
    retired: false,
    owner,
    openSpanId: null,
  };
  startSpan(record, "inspection_queue");
  recordEvent(record, "inspection_queued");
  pending.push(record);
  queueMicrotask(drain);
  return (terminalCauseActionId) => {
    if (record.retired) return;
    pending = pending.filter((item) => item !== record);
    cancel(record, terminalCauseActionId);
  };
}
