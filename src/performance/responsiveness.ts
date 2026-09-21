export type FrontendRole = "primary" | "pre_quit" | "recovery";
export type ActionState = "armed" | "active" | "settled" | "cancelled";
export type SpanTerminal = "ended" | "cancelled";
export type CausalOwner =
  | { kind: "action"; action_id: number }
  | { kind: "setup"; setup_id: number };
export type TraceEventKind =
  | "armed" | "event_received" | "handler_start" | "handler_end"
  | "state_visible" | "double_raf" | "scenario_settled"
  | "inspection_queued" | "inspection_started" | "inspection_settled"
  | "inspection_delivered" | "inspection_cancelled"
  | "persistence_settled";
export type SpanKind =
  | "inspection_queue" | "inspection_native" | "inspection_delivery"
  | "ipc_round_trip" | "draft_encode" | "storage_write"
  | "recovery_verification";
export type RecorderFailureCode =
  | "observer_init" | "observer_delivery" | "frame_schedule"
  | "frame_callback" | "state_transition" | "capacity_accounting"
  | "serialization";
export type RecorderFailurePhase =
  | "create" | "install" | "action" | "setup" | "span"
  | "observer" | "frame" | "teardown" | "serialize";
export type BrowserLimitationCode =
  | "event_timing_unsupported" | "long_tasks_unsupported";

export type TimingBuckets = {
  le_8_334_us: number;
  le_16_667_us: number;
  le_33_334_us: number;
  le_50_000_us: number;
  le_100_000_us: number;
  le_250_000_us: number;
  overflow: number;
};

export type EventTimingEntry = {
  name: "click" | "keydown" | "input" | "change";
  start_us: number;
  duration_us: number;
  interaction_id: number | null;
  action_id: number | null;
  cycle_index: number | null;
};

export type LongTaskEntry = { start_us: number; duration_us: number };

export type TimingAggregate = {
  count: number;
  total_us: number;
  max_us: number;
  buckets: TimingBuckets;
};

export type EventActionTimingAggregate = {
  name: EventTimingEntry["name"];
  action_id: number;
  cycle_index: number | null;
  aggregate: TimingAggregate;
};

export type TraceAction = {
  action_id: number;
  target_id: string;
  state: ActionState;
  armed_us: number;
  active_us: number | null;
  terminal_us: number | null;
};

export type TraceSetup = {
  setup_id: number;
  target_id: string;
  state: "active" | "settled" | "cancelled";
  start_us: number;
  terminal_us: number | null;
};

export type TraceEvent = {
  event_seq: number;
  owner: CausalOwner;
  span_id: number | null;
  kind: TraceEventKind;
  at_us: number;
  subject_id: string | null;
  correlation_id: string | null;
};

export type TraceSpan = {
  span_id: number;
  owner: CausalOwner;
  parent_span_id: number | null;
  kind: SpanKind;
  subject_id: string | null;
  start_us: number;
  end_us: number;
  terminal: SpanTerminal;
  terminal_cause_action_id: number | null;
};

export type BrowserTiming = {
  event_timing: {
    supported: boolean;
    raw: EventTimingEntry[];
    aggregate: TimingAggregate | null;
    by_action: EventActionTimingAggregate[];
  };
  long_tasks: {
    supported: boolean;
    raw: LongTaskEntry[];
    aggregate: TimingAggregate | null;
  };
  raf_gaps: { count: number; max_us: number; buckets: TimingBuckets };
};

export type FrontendTraceV2 = {
  schema_version: 2;
  component_kind: "frontend_trace";
  component_role: FrontendRole;
  session_id: string;
  sample_id: string;
  page_instance_id: string;
  lane: "inspection" | "draft" | "session_memory";
  scenario: { id: string; manifest_sha256: string };
  workload: { id: string; facts: Record<string, string | number | boolean> };
  phase: "warmup" | "measured" | "exploratory_soak";
  repetition: number;
  clock_origin: { domain: "webview_monotonic"; unit: "us" };
  setups: TraceSetup[];
  actions: TraceAction[];
  events: TraceEvent[];
  spans: TraceSpan[];
  browser_timing: BrowserTiming;
  dropped_events: number;
  late_events: number;
  observer_entries_aggregated: number;
  limitations: BrowserLimitationCode[];
  failure: null | { code: RecorderFailureCode; phase: RecorderFailurePhase; count: number };
  settled: boolean;
};

export type ResponsivenessDescriptor = {
  componentRole: FrontendRole;
  sessionId: string;
  sampleId: string;
  pageInstanceId: string;
  lane: FrontendTraceV2["lane"];
  scenario: { id: string; manifestSha256: string };
  workload: FrontendTraceV2["workload"];
  phase: FrontendTraceV2["phase"];
  repetition: number;
};

export type ObserverKind = "event_timing" | "long_task";
export type TimingObservation =
  | { name: EventTimingEntry["name"]; startUs: number; durationUs: number; interactionId: number | null }
  | { name: "long_task"; startUs: number; durationUs: number };

export type RecorderEnvironment = {
  nowUs: () => number;
  requestFrame: (callback: (timestamp: number) => void) => number;
  cancelFrame: (id: number) => void;
  utf8ByteLength: (value: string) => number;
  supportedObserverKinds: () => readonly ObserverKind[];
  createObserver: (
    kind: ObserverKind,
    deliver: (entries: TimingObservation[]) => void,
  ) => { disconnect: () => void };
};

export type StartSpan = {
  owner: CausalOwner;
  kind: SpanKind;
  subjectId?: string;
  parentSpanId?: number;
};

export type RecordEvent = {
  owner: CausalOwner;
  kind: TraceEventKind;
  spanId?: number;
  subjectId?: string;
  correlationId?: string;
};

export type ResponsivenessRecorder = {
  readonly enabled: boolean;
  readonly pageInstanceId: string | null;
  startSetup: (targetId: string) => CausalOwner | null;
  settleSetup: (owner: CausalOwner) => void;
  cancelSetup: (owner: CausalOwner) => void;
  armAction: (action: ArmAction) => CausalOwner | null;
  claimAction: (claim: ActionClaim) => CausalOwner | null;
  markStateVisible: (actionId: number) => void;
  settleAction: (actionId: number) => void;
  cancelAction: (actionId: number) => void;
  settleActionAfterDoubleFrame: (actionId: number, onSettled?: () => void) => void;
  startSpan: (span: StartSpan) => number | null;
  endSpan: (spanId: number) => void;
  cancelSpan: (spanId: number, terminalCauseActionId?: number) => void;
  recordEvent: (event: RecordEvent) => void;
  invalidate: (phase: RecorderFailurePhase) => void;
  onFailure: (callback: () => void) => () => void;
  hasOpenWork: () => boolean;
  snapshot: () => FrontendTraceV2 | null;
  finalize: () => FrontendTraceV2 | null;
  teardown: () => void;
};

export type ArmAction = {
  actionId: number;
  targetId: string;
  eventType: EventTimingEntry["name"];
  targetRole: string;
  accessibleName: string;
  expectedPriorValue: string;
};

export type ActionClaim = Omit<ArmAction, "actionId" | "expectedPriorValue"> & {
  trusted: boolean;
  priorValue: string;
};

type RecorderLimits = {
  maxSetups: number;
  maxActions: number;
  maxSpans: number;
  maxEvents: number;
  maxObserverEntries: number;
  maxEventActionAggregates: number;
  maxRafSamples: number;
  maxSerializedBytes: number;
};

export const DEFAULT_RAF_SAMPLE_CAP = 180_000;

const DEFAULT_LIMITS: RecorderLimits = {
  maxSetups: 256,
  maxActions: 2_048,
  maxSpans: 8_192,
  maxEvents: 16_384,
  maxObserverEntries: 512,
  maxEventActionAggregates: 8_192,
  maxRafSamples: DEFAULT_RAF_SAMPLE_CAP,
  maxSerializedBytes: 6 * 1024 * 1024,
};
const CONSERVATIVE_BASE_BYTES = 5_632;
const CONSERVATIVE_SETUP_BYTES = 192;
const CONSERVATIVE_ACTION_BYTES = 224;
const CONSERVATIVE_EVENT_BYTES = 352;
const CONSERVATIVE_SPAN_BYTES = 352;
const CONSERVATIVE_OBSERVER_ENTRY_BYTES = 160;
const CONSERVATIVE_EVENT_ACTION_AGGREGATE_BYTES = 320;
const OPAQUE_ID = /^[A-Za-z0-9._:-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function emptyBuckets(): TimingBuckets {
  return {
    le_8_334_us: 0,
    le_16_667_us: 0,
    le_33_334_us: 0,
    le_50_000_us: 0,
    le_100_000_us: 0,
    le_250_000_us: 0,
    overflow: 0,
  };
}

function emptyAggregate(): TimingAggregate {
  return { count: 0, total_us: 0, max_us: 0, buckets: emptyBuckets() };
}

function addBucket(buckets: TimingBuckets, durationUs: number): void {
  if (durationUs <= 8_334) buckets.le_8_334_us += 1;
  else if (durationUs <= 16_667) buckets.le_16_667_us += 1;
  else if (durationUs <= 33_334) buckets.le_33_334_us += 1;
  else if (durationUs <= 50_000) buckets.le_50_000_us += 1;
  else if (durationUs <= 100_000) buckets.le_100_000_us += 1;
  else if (durationUs <= 250_000) buckets.le_250_000_us += 1;
  else buckets.overflow += 1;
}

  function addAggregate(aggregate: TimingAggregate, durationUs: number): void {
  aggregate.count += 1;
  aggregate.total_us += durationUs;
  aggregate.max_us = Math.max(aggregate.max_us, durationUs);
  addBucket(aggregate.buckets, durationUs);
}

function isSafeNonnegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameOwner(left: CausalOwner, right: CausalOwner): boolean {
  return left.kind === right.kind
    && (left.kind === "action" ? left.action_id === (right as { action_id: number }).action_id : left.setup_id === (right as { setup_id: number }).setup_id);
}

const noop = (): void => {};
export const NOOP_RESPONSIVENESS_RECORDER: ResponsivenessRecorder = Object.freeze({
  enabled: false,
  pageInstanceId: null,
  startSetup: () => null,
  settleSetup: noop,
  cancelSetup: noop,
  armAction: () => null,
  claimAction: () => null,
  markStateVisible: noop,
  settleAction: noop,
  cancelAction: noop,
  settleActionAfterDoubleFrame: noop,
  startSpan: () => null,
  endSpan: noop,
  cancelSpan: noop,
  recordEvent: noop,
  invalidate: noop,
  onFailure: () => noop,
  hasOpenWork: () => false,
  snapshot: () => null,
  finalize: () => null,
  teardown: noop,
});

const recorderControls = new WeakMap<ResponsivenessRecorder, {
  reject: (phase: RecorderFailurePhase) => void;
}>();

export function createResponsivenessRecorder(
  suppliedDescriptor: ResponsivenessDescriptor,
  env: RecorderEnvironment,
  limitOverrides: Partial<RecorderLimits> = {},
): ResponsivenessRecorder {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const descriptor = sanitizeDescriptor(suppliedDescriptor, env);
  const actions: TraceAction[] = [];
  const setups: TraceSetup[] = [];
  const events: TraceEvent[] = [];
  const spans: TraceSpan[] = [];
  const actionsById = new Map<number, TraceAction>();
  const setupsById = new Map<number, TraceSetup>();
  const completedSpansById = new Map<number, TraceSpan>();
  const openSpans = new Map<number, Omit<TraceSpan, "end_us" | "terminal" | "terminal_cause_action_id">>();
  const openSpanCounts = new Map<string, number>();
  const actionExpectations = new Map<number, ArmAction>();
  const visibleActions = new Set<number>();
  const armedEventActions = new Set<number>();
  const receivedEventActions = new Set<number>();
  const handlerStartedActions = new Set<number>();
  const handlerEndedActions = new Set<number>();
  const doubleRafActions = new Set<number>();
  const observers: { disconnect: () => void }[] = [];
  const failureListeners = new Set<() => void>();
  const pendingFrames = new Set<number>();
  const actionFrames = new Map<number, Set<number>>();
  const limitations: BrowserLimitationCode[] = [];
  const eventRaw: EventTimingEntry[] = [];
  const sessionFirstCycleRaw = new Map<string, EventTimingEntry>();
  const sessionLastCycleRaw = new Map<string, EventTimingEntry>();
  const sessionSlowRaw = new Map<string, EventTimingEntry>();
  const eventActionAggregates = new Map<string, EventActionTimingAggregate>();
  const longRaw: LongTaskEntry[] = [];
  const eventAggregate = emptyAggregate();
  const longAggregate = emptyAggregate();
  const rafBuckets = emptyBuckets();
  let rafCount = 0;
  let rafMaxUs = 0;
  let samplerFrameId: number | null = null;
  let lastSampleFrameUs: number | null = null;
  let conservativeBytes = CONSERVATIVE_BASE_BYTES;
  let failure: FrontendTraceV2["failure"] = null;
  let droppedEvents = 0;
  let lateEvents = 0;
  let observerEntriesAggregated = 0;
  let inert = false;
  let tornDown = false;
  let finalized: FrontendTraceV2 | null = null;
  let finalizationAttempted = false;
  let lastActionId = 0;
  let liveActionId: number | null = null;
  let nextSetupId = 1;
  let nextSpanId = 1;
  let nextEventSeq = 1;
  let lastNowUs = -1;
  let scenarioSettled = false;

  function nowUs(): number {
    const value = env.nowUs();
    if (!isSafeNonnegative(value)) throw new Error("invalid monotonic timestamp");
    if (value < lastNowUs) throw new Error("nonmonotonic timestamp");
    lastNowUs = value;
    return value;
  }

  function disconnect(captureFailure = false): void {
    for (const observer of observers.splice(0)) {
      try { observer.disconnect(); } catch {
        if (captureFailure && failure === null) failure = { code: "observer_delivery", phase: "teardown", count: 1 };
      }
    }
    for (const frame of pendingFrames) {
      try { env.cancelFrame(frame); } catch {
        if (captureFailure && failure === null) failure = { code: "frame_schedule", phase: "teardown", count: 1 };
      }
    }
    pendingFrames.clear();
    actionFrames.clear();
    samplerFrameId = null;
  }

  function fail(code: RecorderFailureCode, phase: RecorderFailurePhase): void {
    const firstFailure = failure === null;
    if (firstFailure) failure = { code, phase, count: 1 };
    inert = true;
    disconnect();
    if (firstFailure) {
      for (const callback of failureListeners) {
        try { callback(); } catch { /* diagnostic callbacks cannot escape */ }
      }
    }
  }

  function boundary<T>(
    fallback: T,
    code: RecorderFailureCode,
    phase: RecorderFailurePhase,
    operation: () => T,
  ): T {
    if (finalized !== null) {
      lateEvents += 1;
      if (failure === null) failure = { code: "state_transition", phase, count: 1 };
      finalized.late_events = lateEvents;
      finalized.failure = failure;
      finalized.settled = false;
      return fallback;
    }
    if (scenarioSettled) {
      lateEvents += 1;
      fail("state_transition", phase);
      return fallback;
    }
    if (inert) return fallback;
    try {
      return operation();
    } catch (error) {
      fail(error instanceof CapacityError ? "capacity_accounting" : code, phase);
      return fallback;
    }
  }

  function validIdentifier(value: string): boolean {
    return value.length > 0 && OPAQUE_ID.test(value) && env.utf8ByteLength(value) <= 64;
  }

  function requireIdentifier(value: string): void {
    if (!validIdentifier(value)) throw new Error("invalid opaque identifier");
  }

  function requireLabel(value: string): void {
    if (value.length === 0 || env.utf8ByteLength(value) > 64 || value.includes("/") || value.includes("\\")) {
      throw new Error("invalid action label");
    }
  }

  function requireComparisonValue(value: string): void {
    const containsControl = [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    });
    if (env.utf8ByteLength(value) > 64 || containsControl) {
      throw new Error("invalid transient comparison value");
    }
  }

  function reserve(bytes: number): void {
    if (conservativeBytes + bytes > limits.maxSerializedBytes) {
      droppedEvents += 1;
      throw new CapacityError();
    }
    conservativeBytes += bytes;
  }

  function findAction(actionId: number): TraceAction {
    const action = actionsById.get(actionId);
    if (!action) throw new Error("unknown action");
    return action;
  }

  function attributeAction(timestampUs: number): TraceAction | undefined {
    let low = 0;
    let high = actions.length - 1;
    let candidate: TraceAction | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const action = actions[middle];
      if (action.armed_us <= timestampUs) {
        candidate = action;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return candidate && (candidate.terminal_us === null || timestampUs <= candidate.terminal_us) ? candidate : undefined;
  }

  function findSetup(owner: CausalOwner): TraceSetup {
    if (owner.kind !== "setup") throw new Error("not a setup owner");
    const setup = setupsById.get(owner.setup_id);
    if (!setup) throw new Error("unknown setup");
    return setup;
  }

  function ownerKey(owner: CausalOwner): string {
    return owner.kind === "action" ? `a:${owner.action_id}` : `s:${owner.setup_id}`;
  }

  function hasOpenSpans(owner: CausalOwner): boolean {
    return (openSpanCounts.get(ownerKey(owner)) ?? 0) > 0;
  }

  function adjustOpenSpans(owner: CausalOwner, delta: number): void {
    const key = ownerKey(owner);
    const next = (openSpanCounts.get(key) ?? 0) + delta;
    if (next <= 0) openSpanCounts.delete(key);
    else openSpanCounts.set(key, next);
  }

  function validateActiveOwner(owner: CausalOwner, allowArmedAction = false): void {
    if (owner.kind === "setup") {
      if (findSetup(owner).state !== "active") throw new Error("terminal setup owner");
      return;
    }
    const action = findAction(owner.action_id);
    if (action.state !== "active" && !(allowArmedAction && action.state === "armed")) {
      throw new Error("terminal action owner");
    }
  }

  function appendEvent(event: RecordEvent, timestamp = nowUs()): void {
    if (event.kind === "scenario_settled") {
      if (scenarioSettled) {
        lateEvents += 1;
        throw new Error("duplicate scenario settlement");
      }
      if (actions.some((action) => action.state === "armed" || action.state === "active")
        || setups.some((setup) => setup.state === "active") || openSpans.size > 0) {
        throw new Error("scenario settled with open records");
      }
      if (event.owner.kind === "action") findAction(event.owner.action_id);
      else findSetup(event.owner);
    } else {
      validateActiveOwner(event.owner, event.kind === "armed");
    }
    const setupOnly = event.kind.startsWith("inspection_");
    const actionOnly = ["armed", "event_received", "handler_start", "handler_end", "state_visible", "double_raf"].includes(event.kind);
    if ((setupOnly && event.owner.kind !== "setup") || (actionOnly && event.owner.kind !== "action")) {
      throw new Error("event kind owner mismatch");
    }
    if (event.owner.kind === "action") {
      const actionId = event.owner.action_id;
      if (event.kind === "armed") {
        if (armedEventActions.has(actionId)) throw new Error("duplicate armed event");
        armedEventActions.add(actionId);
      } else if (event.kind === "event_received") {
        if (!armedEventActions.has(actionId) || receivedEventActions.has(actionId)) throw new Error("invalid event claim order");
        receivedEventActions.add(actionId);
      } else if (event.kind === "handler_start") {
        if (!receivedEventActions.has(actionId) || handlerStartedActions.has(actionId)) throw new Error("invalid handler start order");
        handlerStartedActions.add(actionId);
      } else if (event.kind === "handler_end") {
        if (!handlerStartedActions.has(actionId) || handlerEndedActions.has(actionId)) throw new Error("invalid handler end order");
        handlerEndedActions.add(actionId);
      } else if (event.kind === "state_visible") {
        if (!handlerEndedActions.has(actionId) || visibleActions.has(actionId)) throw new Error("invalid state-visible order");
        visibleActions.add(actionId);
      } else if (event.kind === "double_raf") {
        if (!visibleActions.has(actionId) || doubleRafActions.has(actionId)) throw new Error("invalid double-rAF order");
        doubleRafActions.add(actionId);
      }
    }
    if (events.length >= limits.maxEvents) {
      droppedEvents += 1;
      throw new CapacityError();
    }
    if (event.subjectId !== undefined) requireIdentifier(event.subjectId);
    if (event.correlationId !== undefined) requireIdentifier(event.correlationId);
    if (event.spanId !== undefined) {
      const span = completedSpansById.get(event.spanId) ?? openSpans.get(event.spanId);
      if (!span || !sameOwner(span.owner, event.owner)) throw new Error("unknown or mismatched event span");
    }
    reserve(CONSERVATIVE_EVENT_BYTES);
    events.push({
      event_seq: nextEventSeq++,
      owner: event.owner,
      span_id: event.spanId ?? null,
      kind: event.kind,
      at_us: timestamp,
      subject_id: event.subjectId ?? null,
      correlation_id: event.correlationId ?? null,
    });
    if (event.kind === "scenario_settled") scenarioSettled = true;
  }

  function settleOpenRecords(): void {
    const timestamp = nowUs();
    for (const action of actions) {
      if (action.state === "armed" || action.state === "active") {
        action.state = "cancelled";
        action.terminal_us = timestamp;
      }
    }
    liveActionId = null;
    for (const setup of setups) {
      if (setup.state === "active") {
        setup.state = "cancelled";
        setup.terminal_us = timestamp;
      }
    }
    for (const [spanId, span] of openSpans) {
      const completed: TraceSpan = { ...span, end_us: timestamp, terminal: "cancelled", terminal_cause_action_id: null };
      spans.push(completed);
      completedSpansById.set(spanId, completed);
      adjustOpenSpans(span.owner, -1);
      openSpans.delete(spanId);
    }
  }

  function observe(kind: ObserverKind): void {
    try {
      observers.push(env.createObserver(kind, (entries) => {
        boundary(undefined, "observer_delivery", "observer", () => {
          for (const entry of entries) {
            if (!isSafeNonnegative(entry.startUs) || !isSafeNonnegative(entry.durationUs)) {
              throw new Error("invalid observer entry");
            }
            if (kind === "event_timing") {
              if (entry.name === "long_task") throw new Error("wrong observer entry");
              if (!["click", "keydown", "input", "change"].includes(entry.name)
                || (entry.interactionId !== null && !isSafeNonnegative(entry.interactionId))) {
                throw new Error("invalid event timing entry");
              }
              const timingEntry: EventTimingEntry = {
                name: entry.name,
                start_us: entry.startUs,
                duration_us: entry.durationUs,
                interaction_id: entry.interactionId,
                action_id: null,
                cycle_index: null,
              };
              const attributed = attributeAction(entry.startUs);
              if (attributed) {
                timingEntry.action_id = attributed.action_id;
                const actionsPerCycle = descriptor.value.workload.facts.actions_per_cycle;
                if (typeof actionsPerCycle === "number" && actionsPerCycle > 0) {
                  timingEntry.cycle_index = Math.floor((attributed.action_id - 1) / actionsPerCycle) + 1;
                }
                const key = `${timingEntry.name}:${attributed.action_id}`;
                let actionAggregate = eventActionAggregates.get(key);
                if (!actionAggregate) {
                  if (eventActionAggregates.size >= limits.maxEventActionAggregates) throw new CapacityError();
                  reserve(CONSERVATIVE_EVENT_ACTION_AGGREGATE_BYTES);
                  actionAggregate = {
                    name: timingEntry.name,
                    action_id: attributed.action_id,
                    cycle_index: timingEntry.cycle_index,
                    aggregate: emptyAggregate(),
                  };
                  eventActionAggregates.set(key, actionAggregate);
                }
                addAggregate(actionAggregate.aggregate, entry.durationUs);
              }
              addAggregate(eventAggregate, entry.durationUs);
              const sessionCycles = descriptor.value.workload.facts.session_cycle_count;
              if (descriptor.value.lane !== "session_memory") {
                if (eventRaw.length < limits.maxObserverEntries) {
                  reserve(CONSERVATIVE_OBSERVER_ENTRY_BYTES);
                  eventRaw.push(timingEntry);
                } else {
                  observerEntriesAggregated += 1;
                }
              } else {
                const actionsPerCycle = descriptor.value.workload.facts.actions_per_cycle;
                const edgeReservation = typeof actionsPerCycle === "number"
                  ? Math.min(limits.maxObserverEntries, actionsPerCycle * 2 * 4)
                  : 0;
                const slowCapacity = limits.maxObserverEntries - edgeReservation;
                const rawKey = `${timingEntry.name}:${timingEntry.action_id ?? `u:${timingEntry.interaction_id ?? timingEntry.start_us}`}`;
                const destination = timingEntry.cycle_index === 1
                  ? sessionFirstCycleRaw
                  : (typeof sessionCycles === "number" && timingEntry.cycle_index === sessionCycles
                    ? sessionLastCycleRaw
                    : null);
                if (destination !== null) {
                  if (destination.has(rawKey)) {
                    observerEntriesAggregated += 1;
                  } else {
                    reserve(CONSERVATIVE_OBSERVER_ENTRY_BYTES);
                    destination.set(rawKey, timingEntry);
                  }
                } else if (entry.durationUs >= 50_000 && !sessionSlowRaw.has(rawKey) && sessionSlowRaw.size < slowCapacity) {
                  reserve(CONSERVATIVE_OBSERVER_ENTRY_BYTES);
                  sessionSlowRaw.set(rawKey, timingEntry);
                } else {
                  observerEntriesAggregated += 1;
                }
              }
            } else {
              if (entry.name !== "long_task") throw new Error("wrong observer entry");
              addAggregate(longAggregate, entry.durationUs);
              if (longRaw.length < limits.maxObserverEntries) {
                reserve(CONSERVATIVE_OBSERVER_ENTRY_BYTES);
                longRaw.push({ start_us: entry.startUs, duration_us: entry.durationUs });
              } else observerEntriesAggregated += 1;
            }
          }
        });
      }));
    } catch {
      fail("observer_init", "observer");
    }
  }

  try {
    const supported = new Set(env.supportedObserverKinds());
    if (!supported.has("event_timing")) limitations.push("event_timing_unsupported");
    if (!supported.has("long_task")) limitations.push("long_tasks_unsupported");
    if (supported.has("event_timing")) observe("event_timing");
    if (!inert && supported.has("long_task")) observe("long_task");
  } catch {
    if (!limitations.includes("event_timing_unsupported")) limitations.push("event_timing_unsupported");
    if (!limitations.includes("long_tasks_unsupported")) limitations.push("long_tasks_unsupported");
    fail("observer_init", "observer");
  }

  if (!descriptor.valid) fail("state_transition", "create");

  const recorder: ResponsivenessRecorder = {
    enabled: true,
    pageInstanceId: descriptor.value.pageInstanceId,
    startSetup: (targetId) => boundary(null, "state_transition", "setup", () => {
      requireIdentifier(targetId);
      if (setups.length >= limits.maxSetups) {
        droppedEvents += 1;
        throw new CapacityError();
      }
      reserve(CONSERVATIVE_SETUP_BYTES);
      const setup: TraceSetup = {
        setup_id: nextSetupId++,
        target_id: targetId,
        state: "active",
        start_us: nowUs(),
        terminal_us: null,
      };
      setups.push(setup);
      setupsById.set(setup.setup_id, setup);
      return { kind: "setup", setup_id: setup.setup_id };
    }),
    settleSetup: (owner) => boundary(undefined, "state_transition", "setup", () => {
      const setup = findSetup(owner);
      if (setup.state !== "active") throw new Error("setup already terminal");
      if (hasOpenSpans(owner)) throw new Error("setup has open spans");
      setup.state = "settled";
      setup.terminal_us = nowUs();
    }),
    cancelSetup: (owner) => boundary(undefined, "state_transition", "setup", () => {
      const setup = findSetup(owner);
      if (setup.state !== "active") throw new Error("setup already terminal");
      if (hasOpenSpans(owner)) throw new Error("setup has open spans");
      setup.state = "cancelled";
      setup.terminal_us = nowUs();
    }),
    armAction: (armed) => boundary(null, "state_transition", "action", () => {
      const { actionId, targetId, eventType, targetRole, accessibleName, expectedPriorValue } = armed;
      requireIdentifier(targetId);
      requireIdentifier(targetRole);
      requireLabel(accessibleName);
      requireComparisonValue(expectedPriorValue);
      if (!Number.isSafeInteger(actionId) || actionId !== lastActionId + 1) throw new Error("action ordinal gap");
      if (liveActionId !== null) {
        throw new Error("another action is live");
      }
      if (actions.length >= limits.maxActions) {
        droppedEvents += 1;
        throw new CapacityError();
      }
      reserve(CONSERVATIVE_ACTION_BYTES);
      const owner: CausalOwner = { kind: "action", action_id: actionId };
      const timestamp = nowUs();
      actions.push({
        action_id: actionId,
        target_id: targetId,
        state: "armed",
        armed_us: timestamp,
        active_us: null,
        terminal_us: null,
      });
      actionsById.set(actionId, actions.at(-1)!);
      liveActionId = actionId;
      actionExpectations.set(actionId, { actionId, targetId, eventType, targetRole, accessibleName, expectedPriorValue });
      lastActionId = actionId;
      appendEvent({ owner, kind: "armed" }, timestamp);
      return owner;
    }),
    claimAction: (claim) => boundary(null, "state_transition", "action", () => {
      if (liveActionId === null) throw new Error("unexpected trusted event");
      const action = findAction(liveActionId);
      const expected = actionExpectations.get(action.action_id)!;
      if (!claim.trusted || claim.targetId !== expected.targetId || claim.eventType !== expected.eventType || claim.targetRole !== expected.targetRole
        || claim.accessibleName !== expected.accessibleName || claim.priorValue !== expected.expectedPriorValue) {
        throw new Error("trusted event mismatch");
      }
      if (action.state !== "armed") throw new Error("action cannot activate");
      const timestamp = nowUs();
      action.state = "active";
      action.active_us = timestamp;
      const owner: CausalOwner = { kind: "action", action_id: action.action_id };
      appendEvent({ owner, kind: "event_received" }, timestamp);
      return owner;
    }),
    markStateVisible: (actionId) => boundary(undefined, "state_transition", "action", () => {
      const action = findAction(actionId);
      if (action.state !== "active") throw new Error("state cannot be visible");
      appendEvent({ owner: { kind: "action", action_id: actionId }, kind: "state_visible" });
    }),
    settleAction: (actionId) => boundary(undefined, "state_transition", "action", () => {
      const action = findAction(actionId);
      if (action.state !== "active") throw new Error("action cannot settle");
      if (!visibleActions.has(actionId)) throw new Error("action state not visible");
      if (hasOpenSpans({ kind: "action", action_id: actionId })) {
        throw new Error("action has open spans");
      }
      action.state = "settled";
      action.terminal_us = nowUs();
      liveActionId = null;
      actionExpectations.delete(actionId);
    }),
    cancelAction: (actionId) => boundary(undefined, "state_transition", "action", () => {
      const action = findAction(actionId);
      if (action.state !== "armed" && action.state !== "active") throw new Error("action cannot cancel");
      if (hasOpenSpans({ kind: "action", action_id: actionId })) {
        throw new Error("action has open spans");
      }
      action.state = "cancelled";
      action.terminal_us = nowUs();
      liveActionId = null;
      actionExpectations.delete(actionId);
      for (const frameId of actionFrames.get(actionId) ?? []) {
        pendingFrames.delete(frameId);
        try {
          env.cancelFrame(frameId);
        } catch {
          fail("frame_schedule", "frame");
          break;
        }
      }
      actionFrames.delete(actionId);
    }),
    settleActionAfterDoubleFrame: (actionId, onSettled) => boundary(undefined, "frame_schedule", "frame", () => {
      const action = findAction(actionId);
      if (action.state !== "active") throw new Error("action cannot await frame");
      if (!visibleActions.has(actionId)) throw new Error("action state not visible");
      if ((actionFrames.get(actionId)?.size ?? 0) > 0) throw new Error("action frame already scheduled");
      const firstStart = nowUs();
      scheduleFrame(() => {
        if (action.state !== "active") {
          lateEvents += 1;
          throw new Error("late frame callback");
        }
        const firstEnd = nowUs();
        recordRafGap(firstEnd - firstStart);
        scheduleFrame(() => {
          if (action.state !== "active") {
            lateEvents += 1;
            throw new Error("late frame callback");
          }
          const timestamp = nowUs();
          recordRafGap(timestamp - firstEnd);
          appendEvent({ owner: { kind: "action", action_id: actionId }, kind: "double_raf" }, timestamp);
          action.state = "settled";
          action.terminal_us = timestamp;
          liveActionId = null;
          actionExpectations.delete(actionId);
          lastSampleFrameUs = timestamp;
          scheduleRafSample();
          onSettled?.();
        }, actionId);
      }, actionId);
    }),
    startSpan: ({ owner, kind, subjectId, parentSpanId }) => boundary(null, "state_transition", "span", () => {
      validateActiveOwner(owner);
      if (subjectId !== undefined) requireIdentifier(subjectId);
      if (spans.length + openSpans.size >= limits.maxSpans) {
        droppedEvents += 1;
        throw new CapacityError();
      }
      if (parentSpanId !== undefined) {
        const parent = openSpans.get(parentSpanId);
        if (!parent || !sameOwner(parent.owner, owner)) throw new Error("invalid parent span");
      }
      reserve(CONSERVATIVE_SPAN_BYTES);
      const spanId = nextSpanId++;
      openSpans.set(spanId, {
        span_id: spanId,
        owner,
        parent_span_id: parentSpanId ?? null,
        kind,
        subject_id: subjectId ?? null,
        start_us: nowUs(),
      });
      adjustOpenSpans(owner, 1);
      return spanId;
    }),
    endSpan: (spanId) => boundary(undefined, "state_transition", "span", () => {
      const span = openSpans.get(spanId);
      if (!span) throw new Error("unknown or terminal span");
      validateActiveOwner(span.owner);
      openSpans.delete(spanId);
      adjustOpenSpans(span.owner, -1);
      const completed: TraceSpan = { ...span, end_us: nowUs(), terminal: "ended", terminal_cause_action_id: null };
      spans.push(completed);
      completedSpansById.set(spanId, completed);
    }),
    cancelSpan: (spanId, terminalCauseActionId) => boundary(undefined, "state_transition", "span", () => {
      const span = openSpans.get(spanId);
      if (!span) throw new Error("unknown or terminal span");
      validateActiveOwner(span.owner);
      if (terminalCauseActionId !== undefined) {
        if (span.owner.kind !== "setup") throw new Error("only setup spans may name a terminal cause");
        validateActiveOwner({ kind: "action", action_id: terminalCauseActionId });
      }
      openSpans.delete(spanId);
      adjustOpenSpans(span.owner, -1);
      const completed: TraceSpan = {
        ...span,
        end_us: nowUs(),
        terminal: "cancelled",
        terminal_cause_action_id: terminalCauseActionId ?? null,
      };
      spans.push(completed);
      completedSpansById.set(spanId, completed);
    }),
    recordEvent: (event) => boundary(undefined, "state_transition", event.owner.kind === "action" ? "action" : "setup", () => {
      if (["armed", "event_received", "state_visible", "double_raf"].includes(event.kind)) {
        throw new Error("internal action milestone");
      }
      appendEvent(event);
    }),
    invalidate: (phase) => fail("state_transition", phase),
    onFailure: (callback) => {
      failureListeners.add(callback);
      return () => { failureListeners.delete(callback); };
    },
    hasOpenWork: () => actions.some((action) => action.state === "armed" || action.state === "active")
      || setups.some((setup) => setup.state === "active") || openSpans.size > 0,
    snapshot: () => makeTrace(scenarioSettled && failure === null),
    finalize: () => {
      if (finalized !== null) return finalized;
      if (finalizationAttempted) return null;
      finalizationAttempted = true;
      try {
        if (!inert && !tornDown) {
          const hasOpenRecords = actions.some((action) => action.state === "armed" || action.state === "active")
            || setups.some((setup) => setup.state === "active")
            || openSpans.size > 0;
          if (hasOpenRecords || !scenarioSettled) fail("state_transition", "serialize");
        }
        disconnect(true);
        const trace = makeTrace(failure === null && !tornDown && scenarioSettled);
        const serialized = JSON.stringify(trace);
        const emittedBytes = env.utf8ByteLength(serialized);
        if (emittedBytes > limits.maxSerializedBytes || emittedBytes > conservativeBytes) {
          fail(emittedBytes > limits.maxSerializedBytes ? "serialization" : "capacity_accounting", "serialize");
          finalized = makeBoundedFailureTrace();
          inert = true;
          return finalized;
        }
        finalized = trace;
        inert = true;
        return finalized;
      } catch {
        fail("serialization", "serialize");
        finalized = makeBoundedFailureTrace();
        inert = true;
        return finalized;
      }
    },
    teardown: () => {
      if (tornDown || finalized !== null) return;
      try {
        settleOpenRecords();
      } catch {
        fail("state_transition", "teardown");
      }
      tornDown = true;
      inert = true;
      disconnect(true);
    },
  };

  function makeTrace(settled: boolean): FrontendTraceV2 {
    const retainedEventTiming = descriptor.value.lane === "session_memory"
      ? [...sessionFirstCycleRaw.values(), ...sessionSlowRaw.values(), ...sessionLastCycleRaw.values()]
        .sort((left, right) => left.start_us - right.start_us || left.name.localeCompare(right.name))
      : eventRaw;
    return {
      schema_version: 2,
      component_kind: "frontend_trace",
      component_role: descriptor.value.componentRole,
      session_id: descriptor.value.sessionId,
      sample_id: descriptor.value.sampleId,
      page_instance_id: descriptor.value.pageInstanceId,
      lane: descriptor.value.lane,
      scenario: { id: descriptor.value.scenario.id, manifest_sha256: descriptor.value.scenario.manifestSha256 },
      workload: { id: descriptor.value.workload.id, facts: { ...descriptor.value.workload.facts } },
      phase: descriptor.value.phase,
      repetition: descriptor.value.repetition,
      clock_origin: { domain: "webview_monotonic", unit: "us" },
      setups: setups.map((setup) => ({ ...setup })),
      actions: actions.map((action) => ({ ...action })),
      events: events.map((event) => ({ ...event, owner: { ...event.owner } })),
      spans: [...spans, ...[...openSpans.values()].map((span) => ({
        ...span,
        end_us: span.start_us,
        terminal: "cancelled" as const,
        terminal_cause_action_id: null,
      }))].sort((left, right) => left.span_id - right.span_id),
      browser_timing: {
        event_timing: {
          supported: !limitations.includes("event_timing_unsupported"),
          raw: retainedEventTiming.map((entry) => ({ ...entry })),
          aggregate: eventAggregate.count > 0 ? cloneAggregate(eventAggregate) : null,
          by_action: [...eventActionAggregates.values()]
            .sort((left, right) => left.action_id - right.action_id || left.name.localeCompare(right.name))
            .map((entry) => ({ ...entry, aggregate: cloneAggregate(entry.aggregate) })),
        },
        long_tasks: {
          supported: !limitations.includes("long_tasks_unsupported"),
          raw: longRaw.map((entry) => ({ ...entry })),
          aggregate: longAggregate.count > 0 ? cloneAggregate(longAggregate) : null,
        },
        raf_gaps: { count: rafCount, max_us: rafMaxUs, buckets: { ...rafBuckets } },
      },
      dropped_events: droppedEvents,
      late_events: lateEvents,
      observer_entries_aggregated: observerEntriesAggregated,
      limitations: [...limitations],
      failure,
      settled,
    };
  }

  function makeBoundedFailureTrace(): FrontendTraceV2 | null {
    if (limits.maxSerializedBytes < CONSERVATIVE_BASE_BYTES) return null;
    const trace = makeTrace(false);
    trace.setups = [];
    trace.actions = [];
    trace.events = [];
    trace.spans = [];
    trace.browser_timing.event_timing.raw = [];
    trace.browser_timing.event_timing.aggregate = null;
    trace.browser_timing.event_timing.by_action = [];
    trace.browser_timing.long_tasks.raw = [];
    trace.browser_timing.long_tasks.aggregate = null;
    return trace;
  }

  function recordRafGap(gapUs: number): void {
    if (!isSafeNonnegative(gapUs)) throw new Error("invalid frame gap");
    rafCount += 1;
    rafMaxUs = Math.max(rafMaxUs, gapUs);
    addBucket(rafBuckets, gapUs);
  }

  function scheduleFrame(callback: () => void, actionId?: number): number | null {
    if (inert || finalized !== null) return null;
    if (pendingFrames.size >= 2) {
      fail("frame_schedule", "frame");
      return null;
    }
    try {
      const id = env.requestFrame(() => {
        pendingFrames.delete(id);
        if (actionId !== undefined) actionFrames.get(actionId)?.delete(id);
        if (samplerFrameId === id) samplerFrameId = null;
        boundary(undefined, "frame_callback", "frame", callback);
      });
      if (!Number.isSafeInteger(id) || pendingFrames.has(id)) throw new Error("invalid frame id");
      pendingFrames.add(id);
      if (actionId !== undefined) {
        const frames = actionFrames.get(actionId) ?? new Set<number>();
        frames.add(id);
        actionFrames.set(actionId, frames);
      }
      return id;
    } catch {
      fail("frame_schedule", "frame");
      return null;
    }
  }

  function scheduleRafSample(): void {
    if (samplerFrameId !== null || rafCount >= limits.maxRafSamples || inert || finalized !== null) return;
    const frameId = scheduleFrame(() => {
      const timestamp = nowUs();
      if (lastSampleFrameUs !== null) recordRafGap(timestamp - lastSampleFrameUs);
      lastSampleFrameUs = timestamp;
      scheduleRafSample();
    });
    if (frameId !== null) samplerFrameId = frameId;
  }

  recorderControls.set(recorder, { reject: (phase) => fail("state_transition", phase) });
  return recorder;
}

class CapacityError extends Error {}

function cloneAggregate(aggregate: TimingAggregate): TimingAggregate {
  return { ...aggregate, buckets: { ...aggregate.buckets } };
}

function sanitizeDescriptor(
  descriptor: ResponsivenessDescriptor,
  env: RecorderEnvironment,
): { valid: boolean; value: ResponsivenessDescriptor } {
  const fallback: ResponsivenessDescriptor = {
    componentRole: "primary",
    sessionId: "00000000-0000-4000-8000-000000000000",
    sampleId: "invalid",
    pageInstanceId: "00000000-0000-4000-8000-000000000000",
    lane: "inspection",
    scenario: { id: "invalid", manifestSha256: "0".repeat(64) },
    workload: { id: "invalid", facts: {} },
    phase: "measured",
    repetition: 0,
  };
  try {
    const safeId = (value: unknown, replacement: string): string => (
      typeof value === "string" && value.length > 0 && OPAQUE_ID.test(value) && env.utf8ByteLength(value) <= 64
        ? value
        : replacement
    );
    const rawFacts = descriptor?.workload?.facts;
    const factEntries = rawFacts && typeof rawFacts === "object" ? Object.entries(rawFacts).slice(0, 32) : [];
    const factsValid = rawFacts !== null
      && typeof rawFacts === "object"
      && Object.keys(rawFacts).length <= 32
      && factEntries.every(([key, value]) => (
        safeId(key, "invalid") === key
        && (typeof value !== "string" || safeId(value, "invalid") === value)
        && (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && isSafeNonnegative(value)))
      ));
    const roles: FrontendRole[] = ["primary", "pre_quit", "recovery"];
    const lanes: FrontendTraceV2["lane"][] = ["inspection", "draft", "session_memory"];
    const phases: FrontendTraceV2["phase"][] = ["warmup", "measured", "exploratory_soak"];
    const value: ResponsivenessDescriptor = {
      componentRole: roles.includes(descriptor.componentRole) ? descriptor.componentRole : fallback.componentRole,
      sessionId: UUID.test(descriptor.sessionId) ? descriptor.sessionId : fallback.sessionId,
      sampleId: safeId(descriptor.sampleId, fallback.sampleId),
      pageInstanceId: UUID.test(descriptor.pageInstanceId) ? descriptor.pageInstanceId : fallback.pageInstanceId,
      lane: lanes.includes(descriptor.lane) ? descriptor.lane : fallback.lane,
      scenario: {
        id: safeId(descriptor.scenario?.id, fallback.scenario.id),
        manifestSha256: SHA256.test(descriptor.scenario?.manifestSha256 ?? "")
          ? descriptor.scenario.manifestSha256
          : fallback.scenario.manifestSha256,
      },
      workload: {
        id: safeId(descriptor.workload?.id, fallback.workload.id),
        facts: Object.fromEntries(factsValid ? factEntries : []),
      },
      phase: phases.includes(descriptor.phase) ? descriptor.phase : fallback.phase,
      repetition: isSafeNonnegative(descriptor.repetition) ? descriptor.repetition : fallback.repetition,
    };
    return {
      valid: value.componentRole === descriptor.componentRole
        && value.sessionId === descriptor.sessionId
        && value.pageInstanceId === descriptor.pageInstanceId
        && value.sampleId === descriptor.sampleId
        && value.lane === descriptor.lane
        && value.scenario.id === descriptor.scenario.id
        && value.scenario.manifestSha256 === descriptor.scenario.manifestSha256
        && value.workload.id === descriptor.workload.id
        && value.phase === descriptor.phase
        && factsValid
        && value.repetition === descriptor.repetition,
      value,
    };
  } catch {
    return { valid: false, value: fallback };
  }
}

export function isValidResponsivenessDescriptor(
  descriptor: unknown,
  environment: RecorderEnvironment,
): descriptor is ResponsivenessDescriptor {
  return sanitizeDescriptor(descriptor as ResponsivenessDescriptor, environment).valid;
}

export type PageRecorderRegistry = {
  get: () => ResponsivenessRecorder;
  install: (recorder: ResponsivenessRecorder, pageInstanceId: string) => string | null;
  markScenarioStarted: () => void;
  sealDisabled: () => void;
  teardown: (token: string) => boolean;
};

export function createPageRecorderRegistry(): PageRecorderRegistry {
  let recorder = NOOP_RESPONSIVENESS_RECORDER;
  let installed = false;
  let scenarioStarted = false;
  let terminal = false;
  let token: string | null = null;
  return {
    get: () => recorder,
    install: (candidate, pageInstanceId) => {
      const rejectCandidate = () => {
        recorderControls.get(candidate)?.reject("install");
        candidate.teardown();
      };
      if (!candidate.enabled || !UUID.test(pageInstanceId) || candidate.pageInstanceId !== pageInstanceId) {
        rejectCandidate();
        return null;
      }
      if (installed || scenarioStarted || terminal) {
        recorderControls.get(recorder)?.reject("install");
        if (candidate !== recorder) rejectCandidate();
        return null;
      }
      installed = true;
      recorder = candidate;
      token = `${pageInstanceId}:recorder`;
      return token;
    },
    markScenarioStarted: () => {
      if (!installed) {
        scenarioStarted = true;
        terminal = true;
        return;
      }
      if (terminal || scenarioStarted) {
        recorderControls.get(recorder)?.reject("install");
        return;
      }
      scenarioStarted = true;
    },
    sealDisabled: () => {
      if (installed || scenarioStarted) {
        recorderControls.get(recorder)?.reject("install");
        return;
      }
      terminal = true;
    },
    teardown: (candidateToken) => {
      if (!installed || terminal || token === null || candidateToken !== token) {
        recorderControls.get(recorder)?.reject("teardown");
        return false;
      }
      recorder.teardown();
      recorder = NOOP_RESPONSIVENESS_RECORDER;
      terminal = true;
      return true;
    },
  };
}

const pageRecorderRegistry = createPageRecorderRegistry();
export const getResponsivenessRecorder = (): ResponsivenessRecorder => pageRecorderRegistry.get();
export const installResponsivenessRecorder = (
  recorder: ResponsivenessRecorder,
  pageInstanceId: string,
): string | null => pageRecorderRegistry.install(recorder, pageInstanceId);
export const markResponsivenessScenarioStarted = (): void => pageRecorderRegistry.markScenarioStarted();
export const sealResponsivenessRecorderDisabled = (): void => pageRecorderRegistry.sealDisabled();
export const teardownResponsivenessRecorder = (token: string): boolean => pageRecorderRegistry.teardown(token);
