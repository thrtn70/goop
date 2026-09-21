import { invoke } from "@tauri-apps/api/core";
import { armNextDraftWriteFailure } from "./responsivenessBootstrap";
import {
  createResponsivenessRecorder, installResponsivenessRecorder,
  isValidResponsivenessDescriptor,
  markResponsivenessScenarioStarted, sealResponsivenessRecorderDisabled,
  teardownResponsivenessRecorder, type ActionClaim, type ArmAction,
  type CausalOwner, type FrontendTraceV2, type ObserverKind,
  type RecorderEnvironment, type ResponsivenessDescriptor,
  type ResponsivenessRecorder, type TimingObservation,
} from "./responsiveness";

export type ResponsivenessBootstrap = {
  initialPath: "/extract" | "/convert";
  draftStorage: null | { raw: string; sha256: string };
  failNextDraftWrite: boolean;
};
export type ResponsivenessCompletion = {
  kind: "actions_and_setups" | "recovery";
  timeoutMs: number;
  expectedDraftSha256: string | null;
  expectedAxValue: string | null;
};
export type ResponsivenessActivation = { enabled: false } | {
  enabled: true; recorderMode: "enabled" | "control"; token: string; descriptor: ResponsivenessDescriptor;
  actions: ArmAction[]; webviewDataStoreId: number[];
  bootstrap: ResponsivenessBootstrap; completion: ResponsivenessCompletion;
};
type ReadyArgs = { pageInstanceId: string; token: string; actionId: number | null };
type ResponsivenessActionCandidate = Omit<ActionClaim, "targetId">;
type TrustedEventObservation = {
  targetRole: string | null;
  accessibleName: string | null;
  unique: boolean;
  controlKey: unknown;
  eventType: "click" | "keydown" | "input" | "change" | "select";
  key?: string; metaKey?: boolean; ctrlKey?: boolean;
};
type RuntimeDependencies = {
  status: () => Promise<ResponsivenessActivation>;
  sealDisabled: () => void;
  createRecorder: (descriptor: ResponsivenessDescriptor, environment: RecorderEnvironment) => ResponsivenessRecorder;
  installRecorder: (recorder: ResponsivenessRecorder, pageInstanceId: string) => string | null;
  markScenarioStarted: () => void;
  teardownRecorder: (token: string) => boolean;
  controlReady: (args: Omit<ReadyArgs, "actionId">) => Promise<unknown>;
  ready: (args: ReadyArgs) => Promise<unknown>;
  actionReady: (args: ReadyArgs & { actionId: number }) => Promise<unknown>;
  writeComponent: (args: { token: string; component: FrontendTraceV2 }) => Promise<unknown>;
  environment: RecorderEnvironment;
  applyBootstrap: (bootstrap: ResponsivenessBootstrap) => void;
  readDraftRaw: () => string | null;
  sha256: (value: string) => Promise<string>;
  nowMs: () => number;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (id: number) => void;
  installTrustedEventGuard: (observe: (event: TrustedEventObservation) => void) => () => void;
};
export type ResponsivenessRuntime = {
  initialize: () => Promise<void>;
  expectsAction: (candidate: Pick<ResponsivenessActionCandidate, "eventType" | "targetRole" | "accessibleName">) => boolean;
  claimAction: (claim: ResponsivenessActionCandidate) => number | null;
  recordHandlerStart: (actionId: number) => void;
  recordHandlerEnd: (actionId: number) => void;
  acknowledgeVisible: (actionId: number) => void;
  cancelAction: (actionId: number) => void;
  acknowledgeTopBarValue: (value: string) => void;
  workloadCount: (name: string) => number | null;
  observeTrustedEvent: (event: TrustedEventObservation) => void;
};

const OPAQUE_ID = /^[A-Za-z0-9._:-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EVENT_TYPES = new Set<ArmAction["eventType"]>(["click", "keydown", "input", "change"]);
const DRAFT_STORAGE_KEY = "goop.workspace-drafts.v1";

function browserEnvironment(): RecorderEnvironment {
  return {
    nowUs: () => Math.round(performance.now() * 1_000),
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
    utf8ByteLength: (value) => new TextEncoder().encode(value).byteLength,
    supportedObserverKinds: () => {
      if (typeof PerformanceObserver === "undefined") return [];
      const supported = new Set(PerformanceObserver.supportedEntryTypes ?? []);
      return ([supported.has("event") && "event_timing", supported.has("longtask") && "long_task"]
        .filter(Boolean) as ObserverKind[]);
    },
    createObserver: (kind, deliver) => {
      const observer = new PerformanceObserver((list) => {
        const observations: TimingObservation[] = [];
        for (const entry of list.getEntries()) {
          const startUs = Math.round(entry.startTime * 1_000);
          const durationUs = Math.round(entry.duration * 1_000);
          if (kind === "long_task") observations.push({ name: "long_task", startUs, durationUs });
          else if (["click", "keydown", "input", "change"].includes(entry.name)) {
            const interactionId = (entry as PerformanceEntry & { interactionId?: number }).interactionId;
            observations.push({ name: entry.name as "click" | "keydown" | "input" | "change", startUs, durationUs,
              interactionId: Number.isSafeInteger(interactionId) ? interactionId! : null });
          }
        }
        deliver(observations);
      });
      observer.observe(kind === "long_task" ? { type: "longtask", buffered: false }
        : { type: "event", buffered: false, durationThreshold: 0 } as PerformanceObserverInit);
      return { disconnect: () => observer.disconnect() };
    },
  };
}

function controlObservation(target: EventTarget | null) {
  const control = target instanceof Element
    ? target.closest<HTMLElement>("[data-responsiveness-role][data-responsiveness-name]")
    : null;
  const targetRole = control?.dataset.responsivenessRole ?? null;
  const accessibleName = control?.dataset.responsivenessName ?? null;
  const matches = control === null ? [] : [...document.querySelectorAll<HTMLElement>("[data-responsiveness-role][data-responsiveness-name]")]
    .filter((candidate) => candidate.dataset.responsivenessRole === targetRole
      && candidate.dataset.responsivenessName === accessibleName);
  return { targetRole, accessibleName, unique: matches.length === 1 && matches[0] === control, controlKey: control };
}
function installBrowserGuard(observe: (event: TrustedEventObservation) => void): () => void {
  const types = ["click", "keydown", "input", "change", "select"] as const;
  const listener = (event: Event) => {
    if (!event.isTrusted) return;
    const keyboard = event instanceof KeyboardEvent ? event : null;
    observe({ ...controlObservation(event.target), eventType: event.type as TrustedEventObservation["eventType"],
      key: keyboard?.key, metaKey: keyboard?.metaKey, ctrlKey: keyboard?.ctrlKey });
  };
  types.forEach((type) => document.addEventListener(type, listener, true));
  return () => types.forEach((type) => document.removeEventListener(type, listener, true));
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function applyBrowserBootstrap(config: ResponsivenessBootstrap): void {
  history.replaceState(history.state, "", config.initialPath);
  if (config.draftStorage) localStorage.setItem(DRAFT_STORAGE_KEY, config.draftStorage.raw);
  if (config.failNextDraftWrite) armNextDraftWriteFailure();
}
function validActions(actions: unknown, bytes: (value: string) => number, allowEmpty: boolean): actions is ArmAction[] {
  if (!Array.isArray(actions) || (!allowEmpty && actions.length === 0) || actions.length > 2_048) return false;
  const identifier = (value: unknown) => typeof value === "string" && value.length > 0 && OPAQUE_ID.test(value) && bytes(value) <= 64;
  const text = (value: unknown, empty = false) => typeof value === "string" && (empty || value.length > 0) && bytes(value) <= 64
    && ![...value].some((character) => { const point = character.codePointAt(0) ?? 0; return point <= 0x1f || (point >= 0x7f && point <= 0x9f); });
  return actions.every((raw, index) => {
    const action = raw as Partial<ArmAction>;
    return raw !== null && typeof raw === "object" && action.actionId === index + 1
      && identifier(action.targetId) && EVENT_TYPES.has(action.eventType as ArmAction["eventType"])
      && identifier(action.targetRole) && text(action.accessibleName) && text(action.expectedPriorValue, true);
  });
}
function validActivation(value: Extract<ResponsivenessActivation, { enabled: true }>, environment: RecorderEnvironment): boolean {
  const bytes = environment.utf8ByteLength;
  const recovery = value.completion?.kind === "recovery";
  const stored = value.bootstrap?.draftStorage;
  return (value.recorderMode === "enabled" || value.recorderMode === "control")
    && typeof value.token === "string" && OPAQUE_ID.test(value.token) && bytes(value.token) <= 64
    && isValidResponsivenessDescriptor(value.descriptor, environment)
    && Array.isArray(value.webviewDataStoreId) && value.webviewDataStoreId.length === 16
    && value.webviewDataStoreId.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    && (value.bootstrap?.initialPath === "/extract" || value.bootstrap?.initialPath === "/convert")
    && (stored === null || (typeof stored?.raw === "string" && bytes(stored.raw) <= 512 * 1024 && SHA256.test(stored.sha256)))
    && typeof value.bootstrap?.failNextDraftWrite === "boolean"
    && (value.completion?.kind === "actions_and_setups" || recovery)
    && Number.isSafeInteger(value.completion?.timeoutMs) && value.completion.timeoutMs > 0 && value.completion.timeoutMs <= 120_000
    && (value.completion.expectedDraftSha256 === null || SHA256.test(value.completion.expectedDraftSha256))
    && (value.completion.expectedAxValue === null || (typeof value.completion.expectedAxValue === "string" && bytes(value.completion.expectedAxValue) <= 64))
    && validActions(value.actions, bytes, recovery)
    && (!recovery || (value.actions.length === 0 && value.descriptor.componentRole === "recovery"));
}

const production: RuntimeDependencies = {
  status: () => invoke<ResponsivenessActivation>("responsiveness_status"), sealDisabled: sealResponsivenessRecorderDisabled,
  createRecorder: createResponsivenessRecorder, installRecorder: installResponsivenessRecorder,
  markScenarioStarted: markResponsivenessScenarioStarted, teardownRecorder: teardownResponsivenessRecorder,
  controlReady: (args) => invoke("responsiveness_control_ready", args),
  ready: (args) => invoke("responsiveness_ready", args), actionReady: (args) => invoke("responsiveness_action_ready", args),
  writeComponent: (args) => invoke("responsiveness_write_component", args), environment: browserEnvironment(),
  applyBootstrap: applyBrowserBootstrap, readDraftRaw: () => localStorage.getItem(DRAFT_STORAGE_KEY), sha256,
  nowMs: () => performance.now(), setTimer: (callback, delay) => window.setTimeout(callback, delay),
  clearTimer: (id) => window.clearTimeout(id), installTrustedEventGuard: installBrowserGuard,
};

export function createResponsivenessRuntime(overrides: Partial<RuntimeDependencies> = {}): ResponsivenessRuntime {
  const dep = { ...production, ...overrides };
  let initialization: Promise<void> | null = null;
  let recorder: ResponsivenessRecorder | null = null;
  let activation: Extract<ResponsivenessActivation, { enabled: true }> | null = null;
  let registryToken: string | null = null;
  let actionIndex = -1;
  let claimedActionId: number | null = null;
  let expectedEventObserved = false;
  let inputPreludeObserved = false;
  let companionObserved = false;
  let observedControlKey: unknown = null;
  let pendingTypingChange: { targetRole: string; accessibleName: string; controlKey: unknown } | null = null;
  let claimedKey: { key: string; command: boolean } | null = null;
  let active = false;
  let flushed = false;
  let guardCleanup: (() => void) | null = null;
  let failureCleanup: (() => void) | null = null;
  let completionTimerId: number | null = null;
  let pollTimerId: number | null = null;
  let completionDeadline = 0;
  let lastTopBarValue: string | null = null;
  let recoveryOwner: CausalOwner | null = null;
  let recoverySpan: number | null = null;
  let recoveryChecking = false;

  const cleanup = () => {
    guardCleanup?.(); guardCleanup = null;
    failureCleanup?.(); failureCleanup = null;
    if (completionTimerId !== null) dep.clearTimer(completionTimerId);
    if (pollTimerId !== null) dep.clearTimer(pollTimerId);
    completionTimerId = null; pollTimerId = null;
    lastTopBarValue = null; pendingTypingChange = null; observedControlKey = null;
  };
  const disable = () => { active = false; cleanup(); activation = null; recorder = null; try { dep.sealDisabled(); } catch { /* ordinary boot wins */ } };
  const writeFinal = async () => {
    if (flushed || !recorder || !activation) return;
    flushed = true; active = false; cleanup();
    const component = recorder.finalize();
    if (component) try { await dep.writeComponent({ token: activation.token, component }); } catch { /* diagnostic only */ }
    if (registryToken) dep.teardownRecorder(registryToken);
    registryToken = null; activation = null; recorder = null;
  };
  const fail = (phase: "action" | "setup" | "serialize") => { recorder?.invalidate(phase); void writeFinal(); };
  const arm = (index: number): number | null => {
    if (!recorder || !activation || !activation.actions[index]) return null;
    const owner = recorder.armAction(activation.actions[index]);
    if (owner?.kind !== "action" || owner.action_id !== activation.actions[index].actionId) { fail("action"); return null; }
    actionIndex = index; claimedActionId = null; expectedEventObserved = false;
    inputPreludeObserved = false; companionObserved = false; observedControlKey = null; claimedKey = null;
    return owner.action_id;
  };
  const draftEvidence = async (
    currentRecorder: ResponsivenessRecorder,
    currentActivation: Extract<ResponsivenessActivation, { enabled: true }>,
    owner: CausalOwner,
  ): Promise<boolean> => {
    if (currentActivation.descriptor.lane !== "draft") return true;
    const raw = dep.readDraftRaw();
    if (raw === null) return false;
    const hash = await dep.sha256(raw);
    if (!active || recorder !== currentRecorder || activation !== currentActivation) return false;
    currentRecorder.recordEvent({ owner, kind: "persistence_settled", subjectId: "draft_sha256", correlationId: hash });
    return (currentActivation.completion.expectedDraftSha256 === null || currentActivation.completion.expectedDraftSha256 === hash)
      && (currentActivation.completion.expectedAxValue === null || currentActivation.completion.expectedAxValue === lastTopBarValue);
  };
  const finalize = async (owner: CausalOwner) => { recorder?.recordEvent({ owner, kind: "scenario_settled" }); await writeFinal(); };
  const waitForSetups = (owner: CausalOwner, deadline: number) => {
    if (!active) return;
    try {
      const pending = recorder?.hasOpenWork() ?? true;
      if (!pending) { void finalize(owner); return; }
      if (dep.nowMs() >= deadline) { fail("serialize"); return; }
      pollTimerId = dep.setTimer(() => waitForSetups(owner, deadline), 10);
    } catch { fail("serialize"); }
  };
  const finishAction = async (actionId: number) => {
    if (!active || !recorder || !activation || actionId !== activation.actions[actionIndex]?.actionId) return;
    const currentRecorder = recorder;
    const currentActivation = activation;
    const completed = currentActivation.actions[actionIndex];
    if (completed.eventType === "input" && observedControlKey !== null) {
      pendingTypingChange = {
        targetRole: completed.targetRole,
        accessibleName: completed.accessibleName,
        controlKey: observedControlKey,
      };
    }
    claimedActionId = null;
    if (actionIndex + 1 < currentActivation.actions.length) {
      const next = arm(actionIndex + 1);
      if (next === null) { fail("action"); return; }
      try {
        await dep.actionReady({ pageInstanceId: currentActivation.descriptor.pageInstanceId, token: currentActivation.token, actionId: next });
      } catch {
        if (active && recorder === currentRecorder) { currentRecorder.cancelAction(next); fail("action"); }
      }
      return;
    }
    if (currentActivation.descriptor.lane === "draft") {
      const owner = currentRecorder.startSetup("draft_completion");
      if (!owner) { fail("setup"); return; }
      try {
        const matches = await draftEvidence(currentRecorder, currentActivation, owner);
        if (!active || recorder !== currentRecorder) return;
        currentRecorder.settleSetup(owner);
        if (!matches) { fail("setup"); return; }
      } catch {
        if (active && recorder === currentRecorder) { currentRecorder.cancelSetup(owner); fail("setup"); }
        return;
      }
    }
    waitForSetups({ kind: "action", action_id: actionId }, completionDeadline);
  };
  const finishRecovery = async (value: string) => {
    if (recoveryChecking || !active || !recorder || !activation || !recoveryOwner || recoverySpan === null) return;
    recoveryChecking = true;
    const currentRecorder = recorder;
    const currentActivation = activation;
    const currentOwner = recoveryOwner;
    const currentSpan = recoverySpan;
    try {
      const raw = dep.readDraftRaw();
      const draftHash = raw === null ? null : await dep.sha256(raw);
      const valueHash = await dep.sha256(value);
      if (!active || recorder !== currentRecorder || activation !== currentActivation) return;
      if (draftHash) currentRecorder.recordEvent({ owner: currentOwner, spanId: currentSpan, kind: "persistence_settled", subjectId: "draft_sha256", correlationId: draftHash });
      currentRecorder.recordEvent({ owner: currentOwner, spanId: currentSpan, kind: "persistence_settled", subjectId: "recovered_value_sha256", correlationId: valueHash });
      if (draftHash === currentActivation.completion.expectedDraftSha256 && value === currentActivation.completion.expectedAxValue) {
        currentRecorder.endSpan(currentSpan); currentRecorder.settleSetup(currentOwner); await finalize(currentOwner);
      } else { currentRecorder.cancelSpan(currentSpan); currentRecorder.cancelSetup(currentOwner); fail("setup"); }
    } catch {
      if (active && recorder === currentRecorder) {
        currentRecorder.cancelSpan(currentSpan);
        currentRecorder.cancelSetup(currentOwner);
        fail("setup");
      }
    }
  };
  const sameControl = (event: TrustedEventObservation, expected: Pick<ArmAction, "targetRole" | "accessibleName">) => (
    event.unique && event.targetRole === expected.targetRole && event.accessibleName === expected.accessibleName
  );
  const observeTrustedEvent = (event: TrustedEventObservation) => {
    if (!active || !recorder || !activation) return;
    if (event.eventType === "change" && pendingTypingChange !== null) {
      if (sameControl(event, pendingTypingChange) && event.controlKey === pendingTypingChange.controlKey) {
        pendingTypingChange = null;
      } else fail("action");
      return;
    }
    if (activation.actions.length === 0) { fail("action"); return; }
    const expected = activation.actions[actionIndex];
    const sameTarget = sameControl(event, expected);
    if (claimedActionId === null) {
      if (sameTarget && event.eventType === expected.eventType) {
        if (expectedEventObserved) { fail("action"); return; }
        if (inputPreludeObserved && observedControlKey !== event.controlKey) { fail("action"); return; }
        expectedEventObserved = true;
        observedControlKey = event.controlKey;
        if (event.eventType === "keydown") claimedKey = { key: event.key ?? "", command: Boolean(event.metaKey || event.ctrlKey) };
      } else if (sameTarget && expected.eventType === "input" && event.eventType === "keydown" && !inputPreludeObserved) {
        inputPreludeObserved = true;
        observedControlKey = event.controlKey;
      } else fail("action");
      return;
    }
    const sameClaimedControl = sameTarget && event.controlKey === observedControlKey;
    const deleteInput = sameClaimedControl && event.eventType === "input" && ["Delete", "Backspace"].includes(claimedKey?.key ?? "");
    const commandSelection = sameClaimedControl && event.eventType === "select" && claimedKey?.command && claimedKey.key.toLowerCase() === "a";
    if ((!deleteInput && !commandSelection) || companionObserved) fail("action");
    else companionObserved = true;
  };
  const initialize = (): Promise<void> => {
    if (initialization) return initialization;
    initialization = (async () => {
      const status = await dep.status().catch(() => ({ enabled: false } as const));
      if (!status.enabled) { disable(); return; }
      if (!validActivation(status, dep.environment)) { disable(); return; }
      if (status.bootstrap.draftStorage && await dep.sha256(status.bootstrap.draftStorage.raw) !== status.bootstrap.draftStorage.sha256) { disable(); return; }
      dep.applyBootstrap(status.bootstrap);
      if (status.recorderMode === "control") {
        dep.sealDisabled();
        await dep.controlReady({ pageInstanceId: status.descriptor.pageInstanceId, token: status.token });
        return;
      }
      const candidate = dep.createRecorder(status.descriptor, dep.environment);
      if (!candidate.enabled) { disable(); return; }
      const token = dep.installRecorder(candidate, status.descriptor.pageInstanceId);
      if (!token) { candidate.teardown(); return; }
      recorder = candidate; activation = status; registryToken = token;
      failureCleanup = candidate.onFailure(() => { void Promise.resolve().then(writeFinal); });
      if (candidate.snapshot()?.failure) { await writeFinal(); return; }
      const first = status.actions.length > 0 ? arm(0) : null;
      if (status.actions.length === 0) {
        recoveryOwner = recorder.startSetup("recovery");
        recoverySpan = recoveryOwner ? recorder.startSpan({ owner: recoveryOwner, kind: "recovery_verification", subjectId: "workspace_drafts" }) : null;
        if (!recoveryOwner || recoverySpan === null) { fail("setup"); return; }
      } else if (first === null) { fail("action"); return; }
      dep.markScenarioStarted();
      active = true;
      try {
        // Native readiness means activation is validated, the initial action
        // is armed when present, and the trusted-event guard is live. The harness separately
        // waits for the named AX target to exist before dispatching the event.
        guardCleanup = dep.installTrustedEventGuard(observeTrustedEvent);
        await dep.ready({ pageInstanceId: status.descriptor.pageInstanceId, token: status.token, actionId: first });
        if (!active || flushed) return;
      }
      catch {
        if (first !== null) recorder.cancelAction(first);
        fail("action");
        return;
      }
      completionDeadline = dep.nowMs() + status.completion.timeoutMs;
      completionTimerId = dep.setTimer(() => fail("serialize"), status.completion.timeoutMs);
    })().catch(() => { if (registryToken === null) disable(); else fail("serialize"); });
    return initialization;
  };
  return {
    initialize,
    expectsAction: ({ eventType, targetRole, accessibleName }) => {
      const expected = activation?.actions[actionIndex];
      return Boolean(active && expected?.eventType === eventType
        && expected.targetRole === targetRole && expected.accessibleName === accessibleName);
    },
    claimAction: (claim) => {
      if (!active || !recorder || !activation) return null;
      const expected = activation.actions[actionIndex];
      if (!expected || claimedActionId !== null || !expectedEventObserved
        || expected.eventType !== claim.eventType || expected.targetRole !== claim.targetRole
        || expected.accessibleName !== claim.accessibleName) { fail("action"); return null; }
      const owner = recorder.claimAction({ ...claim, targetId: expected.targetId });
      if (owner?.kind !== "action" || owner.action_id !== expected.actionId) { fail("action"); return null; }
      claimedActionId = owner.action_id; return owner.action_id;
    },
    recordHandlerStart: (id) => {
      if (!active || !recorder) return;
      if (claimedActionId !== id) { fail("action"); return; }
      recorder.recordEvent({ owner: { kind: "action", action_id: id }, kind: "handler_start" });
    },
    recordHandlerEnd: (id) => {
      if (!active || !recorder) return;
      if (claimedActionId !== id) { fail("action"); return; }
      recorder.recordEvent({ owner: { kind: "action", action_id: id }, kind: "handler_end" });
    },
    acknowledgeVisible: (id) => {
      if (!active || !recorder) return;
      if (claimedActionId !== id) { fail("action"); return; }
      recorder.markStateVisible(id);
      if (!active || recorder.snapshot()?.failure !== null) { void writeFinal(); return; }
      recorder.settleActionAfterDoubleFrame(id, () => { void finishAction(id); });
      if (recorder.snapshot()?.failure !== null) void writeFinal();
    },
    cancelAction: (id) => {
      if (!active || !recorder) return;
      if (claimedActionId !== id) { fail("action"); return; }
      recorder.cancelAction(id); claimedActionId = null; fail("action");
    },
    acknowledgeTopBarValue: (value) => { if (!active) return; lastTopBarValue = value; if (activation?.completion.kind === "recovery") void finishRecovery(value); },
    workloadCount: (name) => { if (!active) return null; const value = activation?.descriptor.workload.facts[name]; return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; },
    observeTrustedEvent,
  };
}

const runtime = createResponsivenessRuntime();
export const initializeResponsiveness = runtime.initialize;
export const expectsResponsivenessAction = runtime.expectsAction;
export const claimResponsivenessAction = runtime.claimAction;
export const recordResponsivenessHandlerStart = runtime.recordHandlerStart;
export const recordResponsivenessHandlerEnd = runtime.recordHandlerEnd;
export const acknowledgeResponsivenessVisible = runtime.acknowledgeVisible;
export const cancelResponsivenessAction = runtime.cancelAction;
export const acknowledgeResponsivenessTopBarValue = runtime.acknowledgeTopBarValue;
export const responsivenessWorkloadCount = runtime.workloadCount;
