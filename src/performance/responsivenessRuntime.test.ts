import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArmAction,
  CausalOwner,
  FrontendTraceV2,
  RecorderFailurePhase,
  RecorderEnvironment,
  ResponsivenessDescriptor,
  ResponsivenessRecorder,
} from "./responsiveness";
import { createResponsivenessRecorder } from "./responsiveness";
import {
  createResponsivenessRuntime,
  type ResponsivenessActivation,
} from "./responsivenessRuntime";

const descriptor: ResponsivenessDescriptor = {
  componentRole: "primary",
  sessionId: "11111111-1111-4111-8111-111111111111",
  sampleId: "inspection:small:measured:1",
  pageInstanceId: "22222222-2222-4222-8222-222222222222",
  lane: "inspection",
  scenario: { id: "inspection", manifestSha256: "a".repeat(64) },
  workload: { id: "small", facts: { sources: 2 } },
  phase: "measured",
  repetition: 1,
};

afterEach(() => vi.unstubAllGlobals());

const actions: ArmAction[] = [
  {
    actionId: 1,
    targetId: "source_select:source-1",
    eventType: "click",
    targetRole: "button",
    accessibleName: "Select first.mp4",
    expectedPriorValue: "false",
  },
  {
    actionId: 2,
    targetId: "source_remove:source-2",
    eventType: "click",
    targetRole: "button",
    accessibleName: "Remove second.mp4",
    expectedPriorValue: "present",
  },
];

function observed(action: ArmAction, eventType = action.eventType, extra: Record<string, unknown> = {}) {
  return {
    targetRole: action.targetRole,
    accessibleName: action.accessibleName,
    unique: true,
    controlKey: action.accessibleName,
    eventType,
    ...extra,
  } as Parameters<ReturnType<typeof createResponsivenessRuntime>["observeTrustedEvent"]>[0];
}

function candidate(action: ArmAction, priorValue = action.expectedPriorValue) {
  return {
    eventType: action.eventType,
    targetRole: action.targetRole,
    accessibleName: action.accessibleName,
    trusted: true,
    priorValue,
  };
}

function deterministicEnvironment(options: {
  observerFailure?: boolean;
  frameFailure?: boolean;
} = {}): RecorderEnvironment {
  let now = 0;
  return {
    nowUs: () => ++now,
    requestFrame: (callback) => {
      if (options.frameFailure) throw new Error("frame unavailable");
      callback(++now);
      return now;
    },
    cancelFrame: vi.fn(),
    utf8ByteLength: (value) => new TextEncoder().encode(value).byteLength,
    supportedObserverKinds: () => options.observerFailure ? ["event_timing"] : [],
    createObserver: () => {
      if (options.observerFailure) throw new Error("observer unavailable");
      return { disconnect: vi.fn() };
    },
  };
}

function trace(): FrontendTraceV2 {
  return {
    schema_version: 2,
    component_kind: "frontend_trace",
    component_role: "primary",
    session_id: descriptor.sessionId,
    sample_id: descriptor.sampleId,
    page_instance_id: descriptor.pageInstanceId,
    lane: "inspection",
    scenario: { id: "inspection", manifest_sha256: "a".repeat(64) },
    workload: { id: "small", facts: { sources: 2 } },
    phase: "measured",
    repetition: 1,
    clock_origin: { domain: "webview_monotonic", unit: "us" },
    setups: [], actions: [], events: [], spans: [],
    browser_timing: {
      event_timing: { supported: false, raw: [], aggregate: null, by_action: [] },
      long_tasks: { supported: false, raw: [], aggregate: null },
      raf_gaps: {
        count: 0, max_us: 0,
        buckets: {
          le_8_334_us: 0, le_16_667_us: 0, le_33_334_us: 0,
          le_50_000_us: 0, le_100_000_us: 0, le_250_000_us: 0, overflow: 0,
        },
      },
    },
    dropped_events: 0, late_events: 0, observer_entries_aggregated: 0,
    limitations: [], failure: null, settled: true,
  };
}

function fakeRecorder(log: string[], options: {
  snapshot?: () => FrontendTraceV2;
  hasOpenWork?: () => boolean;
  setupOwner?: CausalOwner | null;
  spanId?: number | null;
} = {}): ResponsivenessRecorder {
  let completion: (() => void) | undefined;
  let failureCallback: (() => void) | null = null;
  let failurePhase: RecorderFailurePhase | null = null;
  const currentTrace = () => failurePhase === null
    ? trace()
    : { ...trace(), failure: { code: "state_transition" as const, phase: failurePhase, count: 1 }, settled: false };
  const setupOwner = options.setupOwner === undefined ? { kind: "setup", setup_id: 1 } as const : options.setupOwner;
  const spanId = options.spanId === undefined ? 1 : options.spanId;
  return {
    enabled: true,
    pageInstanceId: descriptor.pageInstanceId,
    startSetup: vi.fn((targetId) => { log.push(`setup:${targetId}`); return setupOwner; }),
    settleSetup: vi.fn(() => log.push("setup:settled")),
    cancelSetup: vi.fn(() => log.push("setup:cancelled")),
    armAction: vi.fn((action) => {
      log.push(`arm:${action.actionId}`);
      return { kind: "action", action_id: action.actionId };
    }),
    claimAction: vi.fn(() => ({ kind: "action", action_id: Number(log.at(-1)?.split(":")[1] ?? 0) })),
    markStateVisible: vi.fn((actionId) => log.push(`visible:${actionId}`)),
    settleAction: vi.fn(),
    cancelAction: vi.fn(),
    settleActionAfterDoubleFrame: vi.fn((actionId, onSettled) => {
      log.push(`frames:${actionId}`);
      completion = onSettled;
    }),
    startSpan: vi.fn((span) => { log.push(`span:${span.kind}`); return spanId; }),
    endSpan: vi.fn(() => log.push("span:ended")),
    cancelSpan: vi.fn(() => log.push("span:cancelled")),
    recordEvent: vi.fn((event) => log.push(`event:${event.kind}`)),
    invalidate: vi.fn((phase) => {
      log.push(`invalidate:${phase}`);
      if (failurePhase === null) { failurePhase = phase; failureCallback?.(); }
    }),
    onFailure: vi.fn((callback) => { failureCallback = callback; return () => { failureCallback = null; }; }),
    hasOpenWork: options.hasOpenWork ?? (() => false),
    snapshot: options.snapshot ?? currentTrace,
    finalize: vi.fn(currentTrace),
    teardown: vi.fn(),
    _completeForTest: () => completion?.(),
  } as ResponsivenessRecorder & { _completeForTest: () => void };
}

function enabledActivation(overrides: Partial<Extract<ResponsivenessActivation, { enabled: true }>> = {}): ResponsivenessActivation {
  return {
    enabled: true, token: "opaque-token", descriptor, actions,
    webviewDataStoreId: Array.from({ length: 16 }, (_, index) => index),
    bootstrap: { initialPath: "/convert", draftStorage: null, failNextDraftWrite: false },
    completion: { kind: "actions_and_setups", timeoutMs: 2_000, expectedDraftSha256: null, expectedAxValue: null },
    ...overrides,
  };
}

describe("PERF-02 responsiveness runtime", () => {
  it("performs one disabled activation query and seals without creating instrumentation or further IPC", async () => {
    const status = vi.fn<() => Promise<ResponsivenessActivation>>().mockResolvedValue({ enabled: false });
    const sealDisabled = vi.fn();
    const createRecorder = vi.fn();
    const ready = vi.fn();
    const actionReady = vi.fn();
    const writeComponent = vi.fn();
    const applyBootstrap = vi.fn();
    const installTrustedEventGuard = vi.fn();
    const setTimer = vi.fn();
    const runtime = createResponsivenessRuntime({
      status, sealDisabled, createRecorder, installRecorder: vi.fn(),
      markScenarioStarted: vi.fn(), ready, actionReady, writeComponent,
      applyBootstrap, installTrustedEventGuard, setTimer,
    });

    await runtime.initialize();
    await runtime.initialize();

    expect(status).toHaveBeenCalledTimes(1);
    expect(sealDisabled).toHaveBeenCalledTimes(1);
    expect(createRecorder).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(actionReady).not.toHaveBeenCalled();
    expect(writeComponent).not.toHaveBeenCalled();
    expect(applyBootstrap).not.toHaveBeenCalled();
    expect(installTrustedEventGuard).not.toHaveBeenCalled();
    expect(setTimer).not.toHaveBeenCalled();
    runtime.acknowledgeTopBarValue("https://private.example/path");
    expect(runtime.workloadCount("fixture_count")).toBeNull();
    expect(runtime.claimAction(candidate(actions[0]))).toBeNull();
    runtime.observeTrustedEvent(observed(actions[0]));
    expect(writeComponent).not.toHaveBeenCalled();
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("allows ordinary bootstrap to continue when the activation query fails", async () => {
    const ordinaryBootstrap = vi.fn();
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockRejectedValue(new Error("unavailable")),
      sealDisabled: vi.fn(), createRecorder: vi.fn(), installRecorder: vi.fn(),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(),
      writeComponent: vi.fn(),
    });

    await runtime.initialize();
    ordinaryBootstrap();

    expect(ordinaryBootstrap).toHaveBeenCalledTimes(1);
    runtime.acknowledgeTopBarValue("https://private.example/path");
    expect(runtime.workloadCount("fixture_count")).toBeNull();
  });

  it("arms before readiness, advances only after double-frame settlement, and flushes once", async () => {
    const log: string[] = [];
    const recorder = fakeRecorder(log) as ResponsivenessRecorder & { _completeForTest: () => void };
    const ready = vi.fn(async ({ actionId }: { actionId: number | null }) => { log.push(`ready:${actionId}`); });
    const actionReady = vi.fn(async ({ actionId }: { actionId: number }) => { log.push(`action-ready:${actionId}`); });
    const writeComponent = vi.fn(async () => { log.push("write"); });
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation()),
      sealDisabled: vi.fn(),
      createRecorder: vi.fn(() => recorder),
      installRecorder: vi.fn(() => `${descriptor.pageInstanceId}:recorder`),
      markScenarioStarted: vi.fn(), ready, actionReady, writeComponent,
      applyBootstrap: vi.fn(),
      installTrustedEventGuard: vi.fn(() => { log.push("guard"); return vi.fn(); }),
    });

    await runtime.initialize();
    expect(log).toEqual(["arm:1", "guard", "ready:1"]);

    runtime.observeTrustedEvent(observed(actions[0]));
    const first = runtime.claimAction(candidate(actions[0]));
    expect(first).toBe(1);
    runtime.recordHandlerStart(first!);
    runtime.recordHandlerEnd(first!);
    runtime.acknowledgeVisible(first!);
    expect(log).toEqual(["arm:1", "guard", "ready:1", "event:handler_start", "event:handler_end", "visible:1", "frames:1"]);

    recorder._completeForTest();
    await vi.waitFor(() => expect(actionReady).toHaveBeenCalledExactlyOnceWith({
      pageInstanceId: descriptor.pageInstanceId,
      token: "opaque-token",
      actionId: 2,
    }));
    expect(log.slice(-2)).toEqual(["arm:2", "action-ready:2"]);

    runtime.observeTrustedEvent(observed(actions[1]));
    const second = runtime.claimAction(candidate(actions[1]));
    runtime.recordHandlerStart(second!);
    runtime.recordHandlerEnd(second!);
    runtime.acknowledgeVisible(second!);
    recorder._completeForTest();

    await vi.waitFor(() => expect(writeComponent).toHaveBeenCalledTimes(1));
    expect(writeComponent).toHaveBeenCalledWith({ token: "opaque-token", component: trace() });
    expect(actionReady).toHaveBeenCalledTimes(1);
    expect(log.filter((entry) => entry === "event:scenario_settled")).toHaveLength(1);
    recorder._completeForTest();
    expect(writeComponent).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed plans without installing or announcing readiness", async () => {
    const sealDisabled = vi.fn();
    const installRecorder = vi.fn();
    const ready = vi.fn();
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({ actions: [{ ...actions[0], actionId: 2 }] })),
      sealDisabled,
      createRecorder: vi.fn(), installRecorder,
      markScenarioStarted: vi.fn(), ready,
      actionReady: vi.fn(), writeComponent: vi.fn(),
    });

    await runtime.initialize();

    expect(sealDisabled).toHaveBeenCalledTimes(1);
    expect(installRecorder).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });

  it("rejects a malformed descriptor before bootstrap can mutate route or storage", async () => {
    const applyBootstrap = vi.fn();
    const createRecorder = vi.fn();
    const sealDisabled = vi.fn();
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({
        descriptor: { ...descriptor, pageInstanceId: "not-a-uuid" },
      })),
      applyBootstrap, createRecorder, sealDisabled, installRecorder: vi.fn(),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent: vi.fn(),
    });

    await runtime.initialize();

    expect(sealDisabled).toHaveBeenCalledTimes(1);
    expect(applyBootstrap).not.toHaveBeenCalled();
    expect(createRecorder).not.toHaveBeenCalled();
  });

  it("rejects an unbounded or non-opaque native token before recorder creation", async () => {
    const createRecorder = vi.fn();
    const sealDisabled = vi.fn();
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({ token: "x".repeat(65) })),
      sealDisabled, createRecorder, installRecorder: vi.fn(),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(),
      writeComponent: vi.fn(),
    });

    await runtime.initialize();

    expect(sealDisabled).toHaveBeenCalledTimes(1);
    expect(createRecorder).not.toHaveBeenCalled();
  });

  it("rejects completion timeouts above the frozen 120,000 ms maximum", async () => {
    const createRecorder = vi.fn();
    const applyBootstrap = vi.fn();
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({
        completion: { kind: "actions_and_setups", timeoutMs: 120_001, expectedDraftSha256: null, expectedAxValue: null },
      })),
      sealDisabled: vi.fn(), createRecorder, applyBootstrap, installRecorder: vi.fn(),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent: vi.fn(),
    });

    await runtime.initialize();

    expect(applyBootstrap).not.toHaveBeenCalled();
    expect(createRecorder).not.toHaveBeenCalled();
  });

  it("verifies and applies native bootstrap before creating the recorder", async () => {
    const log: string[] = [];
    const raw = JSON.stringify({ version: 1, slots: {} });
    const hash = "b".repeat(64);
    const recorder = fakeRecorder(log);
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({
        bootstrap: { initialPath: "/convert", draftStorage: { raw, sha256: hash }, failNextDraftWrite: true },
      })),
      sha256: vi.fn(async (value) => { log.push(`hash:${value}`); return hash; }),
      applyBootstrap: vi.fn(() => log.push("bootstrap")),
      createRecorder: vi.fn(() => { log.push("create"); return recorder; }),
      installRecorder: vi.fn(() => { log.push("install"); return "registry-token"; }),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent: vi.fn(),
      installTrustedEventGuard: vi.fn(() => vi.fn()),
    });

    await runtime.initialize();

    expect(log.slice(0, 5)).toEqual([`hash:${raw}`, "bootstrap", "create", "install", "arm:1"]);
  });

  it("seals a bootstrap whose supplied draft hash does not match the actual raw value", async () => {
    const createRecorder = vi.fn();
    const applyBootstrap = vi.fn();
    const sealDisabled = vi.fn();
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({
        bootstrap: {
          initialPath: "/convert",
          draftStorage: { raw: "actual", sha256: "c".repeat(64) },
          failNextDraftWrite: false,
        },
      })),
      sha256: vi.fn().mockResolvedValue("d".repeat(64)),
      applyBootstrap, sealDisabled, createRecorder,
      installRecorder: vi.fn(), markScenarioStarted: vi.fn(), ready: vi.fn(),
      actionReady: vi.fn(), writeComponent: vi.fn(),
    });

    await runtime.initialize();

    expect(sealDisabled).toHaveBeenCalledTimes(1);
    expect(applyBootstrap).not.toHaveBeenCalled();
    expect(createRecorder).not.toHaveBeenCalled();
  });

  it("preserves pre-quit draft bytes when recovery bootstrap supplies null storage", async () => {
    const storageKey = "goop.workspace-drafts.v1";
    const slot = JSON.stringify(["extract", "TopBar.url"]);
    const raw = JSON.stringify({ version: 1, entries: { [slot]: { value: "https://x.test/a.mp4" } } });
    const values = new Map([[storageKey, raw]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("history", { state: null, replaceState: vi.fn() });
    const log: string[] = [];
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({
        descriptor: { ...descriptor, componentRole: "recovery", lane: "draft" }, actions: [],
        bootstrap: { initialPath: "/extract", draftStorage: null, failNextDraftWrite: false },
        completion: { kind: "recovery", timeoutMs: 2_000, expectedDraftSha256: "a".repeat(64), expectedAxValue: "https://x.test/a.mp4" },
      })),
      createRecorder: vi.fn(() => fakeRecorder(log)), installRecorder: vi.fn(() => "recovery-registry"),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent: vi.fn(),
      installTrustedEventGuard: vi.fn(() => vi.fn()), setTimer: vi.fn(() => 1), clearTimer: vi.fn(),
    });

    await runtime.initialize();
    const { DRAFT_STORAGE_KEY, loadDraftEntries } = await import("@/store/workspacePersistence");

    expect(DRAFT_STORAGE_KEY).toBe(storageKey);
    expect(values.get(storageKey)).toBe(raw);
    expect(loadDraftEntries(storage)).toEqual({ [slot]: { value: "https://x.test/a.mp4" } });
  });

  it("invalidates unexpected trusted events but permits the explicit input companion", async () => {
    const inputAction: ArmAction = {
      actionId: 1, targetId: "url_input", eventType: "input", targetRole: "textbox",
      accessibleName: "Paste URL to download", expectedPriorValue: "",
    };
    const invalidLog: string[] = [];
    const invalid = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({ actions: [inputAction] })),
      createRecorder: vi.fn(() => fakeRecorder(invalidLog)), installRecorder: vi.fn(() => "invalid-registry"),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent: vi.fn(),
      applyBootstrap: vi.fn(), installTrustedEventGuard: vi.fn(() => vi.fn()),
    });
    await invalid.initialize();
    invalid.observeTrustedEvent({ targetRole: "link", accessibleName: "Convert", unique: true, controlKey: "convert", eventType: "click" });
    expect(invalidLog).toContain("invalidate:action");

    const companionLog: string[] = [];
    const companion = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({ actions: [inputAction] })),
      createRecorder: vi.fn(() => fakeRecorder(companionLog)), installRecorder: vi.fn(() => "companion-registry"),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent: vi.fn(),
      applyBootstrap: vi.fn(), installTrustedEventGuard: vi.fn(() => vi.fn()),
    });
    await companion.initialize();
    companion.observeTrustedEvent(observed(inputAction, "keydown", { key: "h" }));
    companion.observeTrustedEvent(observed(inputAction));
    expect(companion.claimAction({
      eventType: "input", targetRole: "textbox",
      accessibleName: "Paste URL to download", trusted: true, priorValue: "",
    })).toBe(1);
    expect(companionLog).not.toContain("invalidate:action");
  });

  it("maps a semantic source control to the fixed manifest target id and rejects ambiguity", async () => {
    const manifestAction: ArmAction = {
      actionId: 1,
      targetId: "manifest-source-one",
      eventType: "click",
      targetRole: "button",
      accessibleName: "Select actual-dialog-file.mp4",
      expectedPriorValue: "false",
    };
    const log: string[] = [];
    const recorder = fakeRecorder(log);
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({ actions: [manifestAction] })),
      createRecorder: vi.fn(() => recorder), installRecorder: vi.fn(() => "semantic-registry"),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent: vi.fn(),
      applyBootstrap: vi.fn(), installTrustedEventGuard: vi.fn(() => vi.fn()),
      setTimer: vi.fn(() => 1), clearTimer: vi.fn(),
    });
    await runtime.initialize();

    runtime.observeTrustedEvent({
      targetRole: "button", accessibleName: manifestAction.accessibleName,
      unique: true, controlKey: "random-entry-id-7d3f", eventType: "click",
    });
    expect(runtime.claimAction(candidate(manifestAction))).toBe(1);
    expect(recorder.claimAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      targetId: "manifest-source-one",
      accessibleName: manifestAction.accessibleName,
    }));

    const ambiguousLog: string[] = [];
    const ambiguousWrite = vi.fn();
    const ambiguous = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({ actions: [manifestAction] })),
      createRecorder: vi.fn(() => fakeRecorder(ambiguousLog)), installRecorder: vi.fn(() => "ambiguous-registry"),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent: ambiguousWrite,
      applyBootstrap: vi.fn(), installTrustedEventGuard: vi.fn(() => vi.fn()),
      setTimer: vi.fn(() => 2), clearTimer: vi.fn(),
    });
    await ambiguous.initialize();
    ambiguous.observeTrustedEvent({
      targetRole: "button", accessibleName: manifestAction.accessibleName,
      unique: false, controlKey: "duplicate-one", eventType: "click",
    });

    expect(ambiguousLog).toContain("invalidate:action");
    await vi.waitFor(() => expect(ambiguousWrite).toHaveBeenCalledTimes(1));
  });

  it("allows only one Delete input or Command-A selection companion event", async () => {
    const runKeyAction = async (key: string, command: boolean) => {
      const log: string[] = [];
      const keyAction: ArmAction = {
        actionId: 1, targetId: "url_input", eventType: "keydown", targetRole: "textbox",
        accessibleName: "Paste URL to download", expectedPriorValue: "abc",
      };
      const runtime = createResponsivenessRuntime({
        status: vi.fn().mockResolvedValue(enabledActivation({ actions: [keyAction] })),
        createRecorder: vi.fn(() => fakeRecorder(log)), installRecorder: vi.fn(() => `registry-${key}`),
        markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent: vi.fn(),
        applyBootstrap: vi.fn(), installTrustedEventGuard: vi.fn(() => vi.fn()),
      });
      await runtime.initialize();
      runtime.observeTrustedEvent(observed(keyAction, "keydown", { key, metaKey: command }));
      expect(runtime.claimAction({
        eventType: "keydown", targetRole: "textbox",
        accessibleName: "Paste URL to download", trusted: true, priorValue: "abc",
      })).toBe(1);
      return { log, runtime };
    };

    const deletion = await runKeyAction("Delete", false);
    deletion.runtime.observeTrustedEvent({ targetRole: "textbox", accessibleName: "Paste URL to download", unique: true, controlKey: "Paste URL to download", eventType: "input" });
    expect(deletion.log).not.toContain("invalidate:action");
    deletion.runtime.observeTrustedEvent({ targetRole: "textbox", accessibleName: "Paste URL to download", unique: true, controlKey: "Paste URL to download", eventType: "input" });
    expect(deletion.log).toContain("invalidate:action");

    const selection = await runKeyAction("a", true);
    selection.runtime.observeTrustedEvent({ targetRole: "textbox", accessibleName: "Paste URL to download", unique: true, controlKey: "Paste URL to download", eventType: "select" });
    expect(selection.log).not.toContain("invalidate:action");
    selection.runtime.observeTrustedEvent({ targetRole: "textbox", accessibleName: "Paste URL to download", unique: true, controlKey: "Paste URL to download", eventType: "select" });
    expect(selection.log).toContain("invalidate:action");
  });

  it("allows one blur-time change after measured typing before the next remove click", async () => {
    const inputAction: ArmAction = {
      actionId: 1, targetId: "manifest-url-character", eventType: "input", targetRole: "textbox",
      accessibleName: "Paste URL to download", expectedPriorValue: "",
    };
    const removeAction: ArmAction = {
      actionId: 2, targetId: "manifest-remove-one", eventType: "click", targetRole: "button",
      accessibleName: "Remove actual-dialog-file.mp4", expectedPriorValue: "present",
    };
    const log: string[] = [];
    const recorder = fakeRecorder(log) as ResponsivenessRecorder & { _completeForTest: () => void };
    const actionReady = vi.fn();
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({ actions: [inputAction, removeAction] })),
      createRecorder: vi.fn(() => recorder), installRecorder: vi.fn(() => "blur-registry"),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady, writeComponent: vi.fn(),
      applyBootstrap: vi.fn(), installTrustedEventGuard: vi.fn(() => vi.fn()),
      setTimer: vi.fn(() => 1), clearTimer: vi.fn(),
    });
    await runtime.initialize();
    runtime.observeTrustedEvent(observed(inputAction, "keydown", { key: "x" }));
    runtime.observeTrustedEvent(observed(inputAction));
    const inputId = runtime.claimAction(candidate(inputAction))!;
    runtime.recordHandlerStart(inputId); runtime.recordHandlerEnd(inputId); runtime.acknowledgeVisible(inputId);
    recorder._completeForTest();
    await vi.waitFor(() => expect(actionReady).toHaveBeenCalledTimes(1));

    runtime.observeTrustedEvent(observed(inputAction, "change"));
    runtime.observeTrustedEvent(observed(removeAction));

    expect(runtime.claimAction(candidate(removeAction))).toBe(2);
    expect(log).not.toContain("invalidate:action");
    runtime.observeTrustedEvent(observed(inputAction, "change"));
    expect(log).toContain("invalidate:action");

    const unsolicitedLog: string[] = [];
    const unsolicited = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({ actions: [inputAction] })),
      createRecorder: vi.fn(() => fakeRecorder(unsolicitedLog)), installRecorder: vi.fn(() => "unsolicited-registry"),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent: vi.fn(),
      applyBootstrap: vi.fn(), installTrustedEventGuard: vi.fn(() => vi.fn()),
      setTimer: vi.fn(() => 2), clearTimer: vi.fn(),
    });
    await unsolicited.initialize();
    unsolicited.observeTrustedEvent(observed(inputAction, "change"));
    expect(unsolicitedLog).toContain("invalidate:action");
  });

  it("waits for active inspection setup work before finalizing the last action", async () => {
    const log: string[] = [];
    let setupActive = true;
    const timerCallbacks: Array<() => void> = [];
    const recorder = fakeRecorder(log, {
      snapshot: () => ({ ...trace(), setups: setupActive ? [{
        setup_id: 1, target_id: "inspect_source", state: "active", start_us: 1, terminal_us: null,
      }] : [] }),
      hasOpenWork: () => setupActive,
    }) as ResponsivenessRecorder & { _completeForTest: () => void };
    const writeComponent = vi.fn();
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({ actions: [actions[0]] })),
      createRecorder: vi.fn(() => recorder), installRecorder: vi.fn(() => "registry-token"),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent,
      applyBootstrap: vi.fn(), installTrustedEventGuard: vi.fn(() => vi.fn()),
      nowMs: vi.fn().mockReturnValue(100),
      setTimer: vi.fn((callback) => { timerCallbacks.push(callback); return 4; }), clearTimer: vi.fn(),
    });
    await runtime.initialize();
    runtime.observeTrustedEvent(observed(actions[0]));
    const id = runtime.claimAction(candidate(actions[0]))!;
    runtime.recordHandlerStart(id); runtime.recordHandlerEnd(id); runtime.acknowledgeVisible(id);
    recorder._completeForTest();
    expect(writeComponent).not.toHaveBeenCalled();

    setupActive = false;
    timerCallbacks[1]!();
    await vi.waitFor(() => expect(writeComponent).toHaveBeenCalledTimes(1));
    expect(log).toContain("event:scenario_settled");
  });

  it("flushes one failed component when observer initialization or initial arm fails", async () => {
    const run = async (kind: "observer" | "arm") => {
      const environment = deterministicEnvironment({ observerFailure: kind === "observer" });
      const recorder = createResponsivenessRecorder(descriptor, environment);
      if (kind === "arm") recorder.armAction(actions[0]);
      const writeComponent = vi.fn();
      const runtime = createResponsivenessRuntime({
        status: vi.fn().mockResolvedValue(enabledActivation({ actions: [actions[0]] })),
        environment, createRecorder: vi.fn(() => recorder), installRecorder: vi.fn(() => `${kind}-registry`),
        markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent,
        applyBootstrap: vi.fn(), installTrustedEventGuard: vi.fn(() => vi.fn()),
        setTimer: vi.fn(() => 1), clearTimer: vi.fn(),
      });
      await runtime.initialize();
      await vi.waitFor(() => expect(writeComponent).toHaveBeenCalledTimes(1));
      const component = writeComponent.mock.calls[0][0].component as FrontendTraceV2;
      expect(component.schema_version).toBe(2);
      expect(component.component_kind).toBe("frontend_trace");
      expect(component.failure).not.toBeNull();
      expect(component.settled).toBe(false);
      await Promise.resolve();
      expect(writeComponent).toHaveBeenCalledTimes(1);
      return component;
    };

    expect((await run("observer")).failure?.code).toBe("observer_init");
    expect((await run("arm")).failure?.phase).toBe("action");
  });

  it("flushes once when claim, visible-state, or frame boundaries fail", async () => {
    const run = async (kind: "claim" | "visible" | "frame") => {
      const environment = deterministicEnvironment({ frameFailure: kind === "frame" });
      const recorder = createResponsivenessRecorder(descriptor, environment);
      const writeComponent = vi.fn();
      const runtime = createResponsivenessRuntime({
        status: vi.fn().mockResolvedValue(enabledActivation({ actions: [actions[0]] })),
        environment, createRecorder: vi.fn(() => recorder), installRecorder: vi.fn(() => `${kind}-registry`),
        markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent,
        applyBootstrap: vi.fn(), installTrustedEventGuard: vi.fn(() => vi.fn()),
        setTimer: vi.fn(() => 1), clearTimer: vi.fn(),
      });
      await runtime.initialize();
      runtime.observeTrustedEvent(observed(actions[0]));
      const id = runtime.claimAction(candidate(actions[0], kind === "claim" ? "wrong" : "false"));
      if (kind !== "claim") {
        runtime.recordHandlerStart(id!);
        if (kind === "frame") runtime.recordHandlerEnd(id!);
        runtime.acknowledgeVisible(id!);
      }
      await vi.waitFor(() => expect(writeComponent).toHaveBeenCalledTimes(1));
      const component = writeComponent.mock.calls[0][0].component as FrontendTraceV2;
      expect(component.failure).not.toBeNull();
      expect(component.settled).toBe(false);
      await Promise.resolve();
      expect(writeComponent).toHaveBeenCalledTimes(1);
      return component;
    };

    expect((await run("claim")).failure?.phase).toBe("action");
    expect((await run("visible")).failure?.phase).toBe("action");
    expect((await run("frame")).failure?.code).toBe("frame_schedule");
  });

  it("uses one enabled-only completion timer and flushes a failed component on timeout", async () => {
    const environment = deterministicEnvironment();
    const recorder = createResponsivenessRecorder(descriptor, environment);
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const writeComponent = vi.fn();
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({
        actions: [actions[0]], completion: { kind: "actions_and_setups", timeoutMs: 120_000, expectedDraftSha256: null, expectedAxValue: null },
      })),
      environment, createRecorder: vi.fn(() => recorder), installRecorder: vi.fn(() => "timeout-registry"),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent,
      applyBootstrap: vi.fn(), installTrustedEventGuard: vi.fn(() => vi.fn()),
      setTimer: vi.fn((callback, delay) => { timers.push({ callback, delay }); return 7; }), clearTimer: vi.fn(),
    });
    await runtime.initialize();

    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(120_000);
    timers[0].callback();

    await vi.waitFor(() => expect(writeComponent).toHaveBeenCalledTimes(1));
    expect((writeComponent.mock.calls[0][0].component as FrontendTraceV2).failure).toEqual(expect.objectContaining({ phase: "serialize" }));
  });

  it("runs zero-action recovery and emits evidence from actual storage and committed TopBar state", async () => {
    const log: string[] = [];
    const raw = "persisted-raw";
    const draftHash = "e".repeat(64);
    const value = "https://example.com/video";
    const valueHash = "f".repeat(64);
    const recoveryDescriptor = { ...descriptor, componentRole: "recovery" as const, lane: "draft" as const };
    const recorder = fakeRecorder(log);
    const ready = vi.fn();
    const writeComponent = vi.fn();
    const readDraftRaw = vi.fn(() => raw);
    const hash = vi.fn(async (actual: string) => actual === raw ? draftHash : valueHash);
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({
        descriptor: recoveryDescriptor, actions: [],
        completion: { kind: "recovery", timeoutMs: 2_000, expectedDraftSha256: draftHash, expectedAxValue: value },
      })),
      createRecorder: vi.fn(() => recorder), installRecorder: vi.fn(() => "recovery-registry"),
      markScenarioStarted: vi.fn(), ready, actionReady: vi.fn(), writeComponent,
      applyBootstrap: vi.fn(), readDraftRaw,
      sha256: hash,
      setTimer: vi.fn(() => 9), clearTimer: vi.fn(),
    });

    await runtime.initialize();
    expect(ready).toHaveBeenCalledExactlyOnceWith({
      pageInstanceId: descriptor.pageInstanceId, token: "opaque-token", actionId: null,
    });
    expect(log.slice(0, 2)).toEqual(["setup:recovery", "span:recovery_verification"]);

    runtime.acknowledgeTopBarValue(value);
    await vi.waitFor(() => expect(writeComponent).toHaveBeenCalledTimes(1));
    expect(log).toContain("setup:settled");
    expect(log).toContain("span:ended");
    expect((recorder.recordEvent as ReturnType<typeof vi.fn>).mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ kind: "persistence_settled", subjectId: "draft_sha256", correlationId: draftHash })],
      [expect.objectContaining({ kind: "persistence_settled", subjectId: "recovered_value_sha256", correlationId: valueHash })],
    ]));
    readDraftRaw.mockClear(); hash.mockClear();
    runtime.acknowledgeTopBarValue("https://private.example/after-finalize");
    runtime.observeTrustedEvent({ targetRole: "textbox", accessibleName: "Paste URL to download", unique: true, controlKey: "url", eventType: "click" });
    expect(runtime.workloadCount("fixture_count")).toBeNull();
    expect(readDraftRaw).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(writeComponent).toHaveBeenCalledTimes(1);
  });

  it("fails zero-action recovery when actual persisted or visible state does not match", async () => {
    const log: string[] = [];
    const recorder = fakeRecorder(log);
    const writeComponent = vi.fn();
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({
        descriptor: { ...descriptor, componentRole: "recovery", lane: "draft" }, actions: [],
        completion: { kind: "recovery", timeoutMs: 2_000, expectedDraftSha256: "1".repeat(64), expectedAxValue: "expected" },
      })),
      createRecorder: vi.fn(() => recorder), installRecorder: vi.fn(() => "recovery-registry"),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent,
      applyBootstrap: vi.fn(), readDraftRaw: vi.fn(() => "actual-raw"),
      sha256: vi.fn().mockResolvedValue("2".repeat(64)),
      setTimer: vi.fn(() => 3), clearTimer: vi.fn(),
    });
    await runtime.initialize();

    runtime.acknowledgeTopBarValue("actual-value");

    await vi.waitFor(() => expect(writeComponent).toHaveBeenCalledTimes(1));
    expect(log).toEqual(expect.arrayContaining(["span:cancelled", "setup:cancelled", "invalidate:setup"]));
  });

  it("invalidates any unexpected trusted interaction during zero-action recovery", async () => {
    const log: string[] = [];
    const recorder = fakeRecorder(log);
    const writeComponent = vi.fn();
    const installTrustedEventGuard = vi.fn(() => vi.fn());
    const runtime = createResponsivenessRuntime({
      status: vi.fn().mockResolvedValue(enabledActivation({
        descriptor: { ...descriptor, componentRole: "recovery", lane: "draft" }, actions: [],
        completion: { kind: "recovery", timeoutMs: 2_000, expectedDraftSha256: "1".repeat(64), expectedAxValue: "expected" },
      })),
      createRecorder: vi.fn(() => recorder), installRecorder: vi.fn(() => "recovery-registry"),
      markScenarioStarted: vi.fn(), ready: vi.fn(), actionReady: vi.fn(), writeComponent,
      applyBootstrap: vi.fn(), installTrustedEventGuard,
      setTimer: vi.fn(() => 3), clearTimer: vi.fn(),
    });
    await runtime.initialize();

    expect(installTrustedEventGuard).toHaveBeenCalledTimes(1);
    runtime.observeTrustedEvent({ targetRole: "textbox", accessibleName: "Paste URL to download", unique: true, controlKey: "url", eventType: "click" });

    expect(log).toContain("invalidate:action");
    await vi.waitFor(() => expect(writeComponent).toHaveBeenCalledTimes(1));
  });
});
