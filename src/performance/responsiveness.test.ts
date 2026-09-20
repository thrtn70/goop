import { describe, expect, it, vi } from "vitest";
import {
  NOOP_RESPONSIVENESS_RECORDER,
  DEFAULT_RAF_SAMPLE_CAP,
  createPageRecorderRegistry,
  createResponsivenessRecorder,
  type ObserverKind,
  type RecorderEnvironment,
  type ResponsivenessDescriptor,
  type TimingObservation,
} from "./responsiveness";

const descriptor: ResponsivenessDescriptor = {
  componentRole: "primary",
  sessionId: "8b363654-7783-49f6-aac5-53f466e46cb7",
  sampleId: "inspection:32:measured:1",
  pageInstanceId: "d4985b7c-76a8-4cf0-a248-c0505db369da",
  lane: "inspection",
  scenario: {
    id: "inspection-overlap",
    manifestSha256: "a".repeat(64),
  },
  workload: { id: "mixed-32", facts: { source_count: 32 } },
  phase: "measured",
  repetition: 1,
};

function fixture(options?: {
  supported?: ObserverKind[];
  observerInitThrows?: boolean;
  byteSize?: (value: string) => number;
  frameIds?: number[];
  cancelKeepsFrame?: boolean;
  observerDisconnectThrows?: boolean;
}) {
  let now = 1_000;
  let nextFrameId = 1;
  const frames = new Map<number, (timestamp: number) => void>();
  const observers = new Map<ObserverKind, (entries: TimingObservation[]) => void>();
  const disconnect = options?.observerDisconnectThrows
    ? vi.fn(() => { throw new Error("disconnect failure"); })
    : vi.fn();
  const env: RecorderEnvironment = {
    nowUs: () => now,
    requestFrame: (callback) => {
      const id = options?.frameIds?.shift() ?? nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => options?.cancelKeepsFrame ? undefined : frames.delete(id),
    utf8ByteLength: options?.byteSize ?? ((value) => new TextEncoder().encode(value).byteLength),
    supportedObserverKinds: () => options?.supported ?? [],
    createObserver: (kind, deliver) => {
      if (options?.observerInitThrows) throw new Error("private browser failure");
      observers.set(kind, deliver);
      return { disconnect };
    },
  };
  const tick = (microseconds = 1) => { now += microseconds; };
  const runFrame = () => {
    const first = frames.entries().next().value as [number, (timestamp: number) => void] | undefined;
    if (!first) throw new Error("no pending frame");
    frames.delete(first[0]);
    first[1](now / 1_000);
  };
  return { env, frames, observers, disconnect, tick, runFrame };
}

function arm(recorder: ReturnType<typeof createResponsivenessRecorder>, actionId: number, targetId: string) {
  return recorder.armAction({
    actionId,
    targetId,
    eventType: "click",
    targetRole: "button",
    accessibleName: targetId,
    expectedPriorValue: "ready",
  });
}

function claim(recorder: ReturnType<typeof createResponsivenessRecorder>) {
  return recorder.claimAction({
    trusted: true,
    targetId: recorder.snapshot()!.actions.at(-1)!.target_id,
    eventType: "click",
    targetRole: "button",
    accessibleName: recorder.snapshot()!.actions.at(-1)!.target_id,
    priorValue: "ready",
  });
}

function completeHandler(recorder: ReturnType<typeof createResponsivenessRecorder>, actionId: number) {
  const owner = { kind: "action" as const, action_id: actionId };
  recorder.recordEvent({ owner, kind: "handler_start" });
  recorder.recordEvent({ owner, kind: "handler_end" });
  recorder.markStateVisible(actionId);
}

describe("PERF-02 responsiveness recorder", () => {
  it("keeps the frozen default recorder completely inert", () => {
    expect(Object.isFrozen(NOOP_RESPONSIVENESS_RECORDER)).toBe(true);
    expect(NOOP_RESPONSIVENESS_RECORDER.enabled).toBe(false);
    expect(NOOP_RESPONSIVENESS_RECORDER.startSetup("source-1")).toBeNull();
    expect(NOOP_RESPONSIVENESS_RECORDER.startSpan({
      owner: { kind: "setup", setup_id: 1 },
      kind: "inspection_queue",
    })).toBeNull();
    expect(NOOP_RESPONSIVENESS_RECORDER.snapshot()).toBeNull();
    expect(NOOP_RESPONSIVENESS_RECORDER.finalize()).toBeNull();
  });

  it("records valid setup ownership and nested span causality", () => {
    const { env, tick } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    const owner = recorder.startSetup("source-1");
    expect(owner).toEqual({ kind: "setup", setup_id: 1 });

    tick(10);
    const queue = recorder.startSpan({ owner: owner!, kind: "inspection_queue", subjectId: "source-1" });
    tick(10);
    const native = recorder.startSpan({
      owner: owner!,
      kind: "inspection_native",
      subjectId: "source-1",
      parentSpanId: queue!,
    });
    tick(10);
    recorder.endSpan(native!);
    recorder.endSpan(queue!);
    recorder.settleSetup(owner!);
    recorder.recordEvent({ owner: owner!, kind: "scenario_settled" });

    const trace = recorder.finalize();
    expect(trace?.failure).toBeNull();
    expect(trace?.settled).toBe(true);
    expect(trace?.setups).toEqual([expect.objectContaining({ setup_id: 1, state: "settled" })]);
    expect(trace?.spans).toEqual([
      expect.objectContaining({ span_id: 1, owner, parent_span_id: null, terminal: "ended" }),
      expect.objectContaining({ span_id: 2, owner, parent_span_id: 1, terminal: "ended" }),
    ]);
  });

  it("records cancellation without erasing evidence and preserves a later action as terminal cause", () => {
    const { env, tick } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    const setup = recorder.startSetup("source-2")!;
    const span = recorder.startSpan({ owner: setup, kind: "inspection_native", subjectId: "source-2" })!;
    expect(arm(recorder, 1, "remove-source-2")).toEqual({ kind: "action", action_id: 1 });
    claim(recorder);
    completeHandler(recorder, 1);
    tick(5);
    recorder.cancelSpan(span, 1);
    recorder.cancelSetup(setup);
    recorder.settleAction(1);
    recorder.recordEvent({ owner: { kind: "action", action_id: 1 }, kind: "scenario_settled" });

    const trace = recorder.finalize();
    expect(trace?.spans[0]).toEqual(expect.objectContaining({
      terminal: "cancelled",
      terminal_cause_action_id: 1,
    }));
    expect(trace?.setups[0].state).toBe("cancelled");
    expect(trace?.actions[0].state).toBe("settled");
  });

  it.each([
    ["duplicate setup terminal", (recorder: ReturnType<typeof createResponsivenessRecorder>) => {
      const owner = recorder.startSetup("source-1")!;
      recorder.settleSetup(owner);
      recorder.settleSetup(owner);
    }],
    ["unknown span parent", (recorder: ReturnType<typeof createResponsivenessRecorder>) => {
      const owner = recorder.startSetup("source-1")!;
      recorder.startSpan({ owner, kind: "inspection_delivery", parentSpanId: 99 });
    }],
    ["owner mismatch", (recorder: ReturnType<typeof createResponsivenessRecorder>) => {
      const owner = recorder.startSetup("source-1")!;
      const parent = recorder.startSpan({ owner, kind: "inspection_queue" })!;
      arm(recorder, 1, "select-source-1");
      recorder.startSpan({ owner: { kind: "action", action_id: 1 }, kind: "inspection_native", parentSpanId: parent });
    }],
    ["nonmonotonic action id", (recorder: ReturnType<typeof createResponsivenessRecorder>) => {
      arm(recorder, 2, "source-2");
      arm(recorder, 1, "source-1");
    }],
    ["duplicate action terminal", (recorder: ReturnType<typeof createResponsivenessRecorder>) => {
      arm(recorder, 1, "source-1");
      recorder.cancelAction(1);
      recorder.cancelAction(1);
    }],
  ])("fails closed and becomes inert for %s", (_name, violate) => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    violate(recorder);
    expect(recorder.snapshot()?.failure).toEqual({ code: "state_transition", phase: expect.any(String), count: 1 });
    expect(recorder.startSetup("ignored")).toBeNull();
  });

  it("rejects event/span causal-owner mismatches", () => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    const setup = recorder.startSetup("source-1")!;
    const span = recorder.startSpan({ owner: setup, kind: "inspection_native" })!;
    arm(recorder, 1, "select-source-1");
    claim(recorder);
    recorder.recordEvent({ owner: { kind: "action", action_id: 1 }, kind: "handler_start", spanId: span });
    expect(recorder.snapshot()?.failure?.code).toBe("state_transition");
  });

  it("rejects a regressing monotonic clock", () => {
    const { env } = fixture();
    const times = [100, 90];
    const recorder = createResponsivenessRecorder(descriptor, { ...env, nowUs: () => times.shift() ?? 90 });
    const owner = recorder.startSetup("source-1")!;
    recorder.settleSetup(owner);
    expect(recorder.snapshot()?.failure).toEqual({ code: "state_transition", phase: "setup", count: 1 });
  });

  it("settles an action only after the second animation frame", () => {
    const { env, frames, runFrame, tick } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    arm(recorder, 1, "select-source-1");
    claim(recorder);
    completeHandler(recorder, 1);
    recorder.settleActionAfterDoubleFrame(1);
    expect(frames.size).toBe(1);
    tick(16_667);
    runFrame();
    expect(recorder.snapshot()?.actions[0].state).toBe("active");
    tick(16_667);
    runFrame();
    expect(recorder.snapshot()?.actions[0].state).toBe("settled");
    expect(recorder.snapshot()?.events.map((event) => event.kind)).toContain("double_raf");
  });

  it("requires an exact trusted claim and visible state before double-rAF", () => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    arm(recorder, 1, "source-1");
    expect(recorder.claimAction({
      trusted: true,
      targetId: "other-source",
      eventType: "click",
      targetRole: "button",
      accessibleName: "source-1",
      priorValue: "ready",
    })).toBeNull();
    expect(recorder.snapshot()?.failure?.code).toBe("state_transition");

    const second = createResponsivenessRecorder(descriptor, env);
    arm(second, 1, "source-1");
    claim(second);
    second.settleActionAfterDoubleFrame(1);
    expect(second.snapshot()?.failure).toEqual({ code: "frame_schedule", phase: "frame", count: 1 });
  });

  it("accepts all 20 transient URL prefixes without serializing their values", () => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    const value = "https://x.test/a.mp4";
    for (let index = 0; index < value.length; index += 1) {
      const actionId = index + 1;
      recorder.armAction({
        actionId,
        targetId: "draft-input",
        eventType: "input",
        targetRole: "textbox",
        accessibleName: "Paste URL to download",
        expectedPriorValue: value.slice(0, index),
      });
      recorder.claimAction({
        trusted: true,
        targetId: "draft-input",
        eventType: "input",
        targetRole: "textbox",
        accessibleName: "Paste URL to download",
        priorValue: value.slice(0, index),
      });
      completeHandler(recorder, actionId);
      recorder.settleAction(actionId);
    }
    recorder.recordEvent({ owner: { kind: "action", action_id: 20 }, kind: "scenario_settled" });
    const trace = recorder.finalize();
    expect(trace?.actions).toHaveLength(20);
    expect(JSON.stringify(trace)).not.toContain("https://");
  });

  it("rejects C1 controls in transient comparison values", () => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    expect(recorder.armAction({
      actionId: 1,
      targetId: "draft-input",
      eventType: "input",
      targetRole: "textbox",
      accessibleName: "Paste URL to download",
      expectedPriorValue: `safe\u0085unsafe`,
    })).toBeNull();
    expect(recorder.snapshot()?.failure?.code).toBe("state_transition");
  });

  it("enforces action milestone ordering, uniqueness, and internal double-rAF ownership", () => {
    const { env } = fixture();
    const outOfOrder = createResponsivenessRecorder(descriptor, env);
    arm(outOfOrder, 1, "source-1");
    claim(outOfOrder);
    outOfOrder.recordEvent({ owner: { kind: "action", action_id: 1 }, kind: "handler_end" });
    expect(outOfOrder.snapshot()?.failure?.code).toBe("state_transition");

    const duplicate = createResponsivenessRecorder(descriptor, env);
    arm(duplicate, 1, "source-1");
    claim(duplicate);
    duplicate.recordEvent({ owner: { kind: "action", action_id: 1 }, kind: "handler_start" });
    duplicate.recordEvent({ owner: { kind: "action", action_id: 1 }, kind: "handler_start" });
    expect(duplicate.snapshot()?.failure?.code).toBe("state_transition");

    const injected = createResponsivenessRecorder(descriptor, env);
    arm(injected, 1, "source-1");
    claim(injected);
    completeHandler(injected, 1);
    injected.recordEvent({ owner: { kind: "action", action_id: 1 }, kind: "double_raf" });
    expect(injected.snapshot()?.failure?.code).toBe("state_transition");

    const duplicateVisible = createResponsivenessRecorder(descriptor, env);
    arm(duplicateVisible, 1, "source-1");
    claim(duplicateVisible);
    completeHandler(duplicateVisible, 1);
    duplicateVisible.markStateVisible(1);
    expect(duplicateVisible.snapshot()?.failure?.code).toBe("state_transition");
  });

  it("budgets bounded rAF aggregation beyond a 20-minute 120 Hz soak", () => {
    expect(DEFAULT_RAF_SAMPLE_CAP).toBeGreaterThan(20 * 60 * 120);
  });

  it("allows only one live action and invalidates duplicate frame scheduling", () => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    arm(recorder, 1, "source-1");
    expect(arm(recorder, 2, "source-2")).toBeNull();
    expect(recorder.snapshot()?.failure?.code).toBe("state_transition");

    const second = createResponsivenessRecorder(descriptor, env);
    arm(second, 1, "source-1");
    claim(second);
    completeHandler(second, 1);
    second.settleActionAfterDoubleFrame(1);
    second.settleActionAfterDoubleFrame(1);
    expect(second.snapshot()?.failure).toEqual({ code: "frame_schedule", phase: "frame", count: 1 });
  });

  it("continues a bounded rAF-gap fallback after acknowledgement", () => {
    const { env, frames, runFrame, tick } = fixture({ frameIds: [90, 4, 70] });
    const recorder = createResponsivenessRecorder(descriptor, env, { maxRafSamples: 3 });
    arm(recorder, 1, "select-source-1");
    claim(recorder);
    completeHandler(recorder, 1);
    recorder.settleActionAfterDoubleFrame(1);
    tick(10_000);
    runFrame();
    tick(20_000);
    runFrame();
    expect(frames.size).toBe(1);
    tick(30_000);
    runFrame();
    expect(frames.size).toBe(0);
    expect(recorder.snapshot()?.browser_timing.raf_gaps).toEqual(expect.objectContaining({
      count: 3,
      max_us: 30_000,
    }));
  });

  it("cancels pending frames and open records during teardown", () => {
    const { env, frames } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    const setup = recorder.startSetup("source-1")!;
    recorder.startSpan({ owner: setup, kind: "inspection_native" });
    arm(recorder, 1, "select-source-1");
    claim(recorder);
    completeHandler(recorder, 1);
    recorder.settleActionAfterDoubleFrame(1);
    expect(frames.size).toBe(1);
    recorder.teardown();
    expect(frames.size).toBe(0);
    expect(recorder.snapshot()?.setups[0].state).toBe("cancelled");
    expect(recorder.snapshot()?.spans[0].terminal).toBe("cancelled");
    expect(recorder.snapshot()?.actions[0].state).toBe("cancelled");
  });

  it("invalidates a late frame callback after action cancellation", () => {
    const { env, runFrame } = fixture({ cancelKeepsFrame: true });
    const recorder = createResponsivenessRecorder(descriptor, env);
    arm(recorder, 1, "source-1");
    claim(recorder);
    completeHandler(recorder, 1);
    recorder.settleActionAfterDoubleFrame(1);
    recorder.cancelAction(1);
    runFrame();
    expect(recorder.snapshot()?.actions[0].state).toBe("cancelled");
    expect(recorder.snapshot()?.late_events).toBe(1);
    expect(recorder.snapshot()?.failure?.code).toBe("frame_callback");
  });

  it("feature-detects observers and records bounded observations", () => {
    const { env, observers } = fixture({ supported: ["event_timing", "long_task"] });
    const recorder = createResponsivenessRecorder(descriptor, env);
    observers.get("event_timing")!([{ name: "click", startUs: 10, durationUs: 80_000, interactionId: 4 }]);
    observers.get("long_task")!([{ name: "long_task", startUs: 20, durationUs: 60_000 }]);
    const timing = recorder.snapshot()!.browser_timing;
    expect(timing.event_timing).toEqual(expect.objectContaining({ supported: true, raw: [expect.objectContaining({ duration_us: 80_000 })] }));
    expect(timing.long_tasks).toEqual(expect.objectContaining({ supported: true, raw: [expect.objectContaining({ duration_us: 60_000 })] }));
    expect(recorder.snapshot()?.limitations).toEqual([]);
  });

  it("aggregates ordinary-lane Event Timing entries beyond the 512 raw cap", () => {
    const { env, observers } = fixture({ supported: ["event_timing"] });
    const recorder = createResponsivenessRecorder(descriptor, env);
    observers.get("event_timing")!(Array.from({ length: 513 }, (_, index) => ({
      name: "click" as const,
      startUs: index,
      durationUs: 1_000,
      interactionId: index,
    })));
    const trace = recorder.snapshot()!;
    expect(trace.failure).toBeNull();
    expect(trace.browser_timing.event_timing.raw).toHaveLength(512);
    expect(trace.browser_timing.event_timing.aggregate?.count).toBe(513);
    expect(trace.observer_entries_aggregated).toBe(1);
  });

  it("rejects invalid runtime Event Timing names and interaction IDs", () => {
    const { env, observers } = fixture({ supported: ["event_timing"] });
    const recorder = createResponsivenessRecorder(descriptor, env);
    observers.get("event_timing")!([{
      name: "click",
      startUs: 1,
      durationUs: 1,
      interactionId: -1,
    }]);
    expect(recorder.snapshot()?.failure).toEqual({ code: "observer_delivery", phase: "observer", count: 1 });
  });

  it("reports unsupported browser APIs instead of treating them as zero", () => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    expect(recorder.snapshot()?.browser_timing.event_timing.supported).toBe(false);
    expect(recorder.snapshot()?.browser_timing.long_tasks.supported).toBe(false);
    expect(recorder.snapshot()?.limitations).toEqual(["event_timing_unsupported", "long_tasks_unsupported"]);
  });

  it("aggregates unattributed long-session entries while retaining slow examples", () => {
    const { env, observers } = fixture({ supported: ["event_timing"] });
    const recorder = createResponsivenessRecorder({ ...descriptor, lane: "session_memory" }, env);
    const entries: TimingObservation[] = Array.from({ length: 36 }, (_, index) => ({
      name: "click" as const,
      startUs: index,
      durationUs: index === 20 ? 60_000 : 1_000,
      interactionId: index,
    }));
    observers.get("event_timing")!(entries);
    const timing = recorder.snapshot()!.browser_timing.event_timing;
    expect(timing.aggregate?.count).toBe(36);
    expect(timing.raw).toHaveLength(1);
    expect(timing.raw.some((entry) => entry.duration_us === 60_000)).toBe(true);
    expect(recorder.snapshot()?.observer_entries_aggregated).toBe(35);
  });

  it("adds action and cycle identity to attributable session timing", () => {
    const { env, observers, tick } = fixture({ supported: ["event_timing"] });
    const recorder = createResponsivenessRecorder({
      ...descriptor,
      lane: "session_memory",
      workload: { ...descriptor.workload, facts: { actions_per_cycle: 35, session_cycle_count: 50 } },
    }, env);
    arm(recorder, 1, "source-1");
    claim(recorder);
    tick(10);
    completeHandler(recorder, 1);
    recorder.settleAction(1);
    observers.get("event_timing")!([{ name: "click", startUs: 1_005, durationUs: 2_000, interactionId: 1 }]);
    expect(recorder.snapshot()?.browser_timing.event_timing.raw[0]).toEqual(expect.objectContaining({
      action_id: 1,
      cycle_index: 1,
    }));
  });

  it("attributes Event Timing that starts after arm but before handler claim", () => {
    const { env, observers, tick } = fixture({ supported: ["event_timing"] });
    const recorder = createResponsivenessRecorder({
      ...descriptor,
      lane: "session_memory",
      workload: { ...descriptor.workload, facts: { actions_per_cycle: 35, session_cycle_count: 3 } },
    }, env);
    arm(recorder, 1, "source-1");
    tick(5);
    observers.get("event_timing")!([{ name: "click", startUs: 1_002, durationUs: 2_000, interactionId: 1 }]);
    claim(recorder);
    completeHandler(recorder, 1);
    recorder.settleAction(1);
    expect(recorder.snapshot()?.browser_timing.event_timing.raw[0]).toEqual(expect.objectContaining({
      action_id: 1,
      cycle_index: 1,
    }));
  });

  it("aggregates every Lane-3 action and retains first, last, and slow middle examples", () => {
    const { env, observers, tick } = fixture({ supported: ["event_timing"] });
    const recorder = createResponsivenessRecorder({
      ...descriptor,
      lane: "session_memory",
      workload: { ...descriptor.workload, facts: { actions_per_cycle: 35, session_cycle_count: 3 } },
    }, env);
    for (let actionId = 1; actionId <= 105; actionId += 1) {
      arm(recorder, actionId, `source-${actionId}`);
      claim(recorder);
      completeHandler(recorder, actionId);
      recorder.settleAction(actionId);
      observers.get("event_timing")!([{
        name: "click",
        startUs: 999 + actionId,
        durationUs: actionId === 60 ? 60_000 : 1_000,
        interactionId: actionId,
      }]);
      tick(1);
    }
    const timing = recorder.snapshot()!.browser_timing.event_timing;
    expect(timing.by_action).toHaveLength(105);
    expect(timing.by_action[59]).toEqual(expect.objectContaining({ action_id: 60, cycle_index: 2 }));
    const retained = timing.raw.map((entry) => entry.action_id);
    expect(retained).toEqual([
      ...Array.from({ length: 35 }, (_, index) => index + 1),
      60,
      ...Array.from({ length: 35 }, (_, index) => index + 71),
    ]);
    expect(recorder.snapshot()?.observer_entries_aggregated).toBe(34);
    recorder.recordEvent({ owner: { kind: "action", action_id: 105 }, kind: "scenario_settled" });
    expect(recorder.finalize()?.failure).toBeNull();
  });

  it("reserves final-cycle raw capacity despite more than 442 slow middle observations", () => {
    const { env, observers, tick } = fixture({ supported: ["event_timing"] });
    const recorder = createResponsivenessRecorder({
      ...descriptor,
      lane: "session_memory",
      workload: { ...descriptor.workload, facts: { actions_per_cycle: 35, session_cycle_count: 50 } },
    }, env);
    for (let actionId = 1; actionId <= 1_750; actionId += 1) {
      const targetId = `source-${actionId}`;
      arm(recorder, actionId, targetId);
      recorder.claimAction({
        trusted: true,
        targetId,
        eventType: "click",
        targetRole: "button",
        accessibleName: targetId,
        priorValue: "ready",
      });
      completeHandler(recorder, actionId);
      recorder.settleAction(actionId);
      const cycle = Math.floor((actionId - 1) / 35) + 1;
      observers.get("event_timing")!([{
        name: "click",
        startUs: 999 + actionId,
        durationUs: cycle > 1 && cycle < 50 ? 60_000 : 1_000,
        interactionId: actionId,
      }]);
      tick(1);
    }
    const timing = recorder.snapshot()!.browser_timing.event_timing;
    expect(timing.raw.slice(0, 35).map((entry) => entry.action_id)).toEqual(
      Array.from({ length: 35 }, (_, index) => index + 1),
    );
    expect(timing.raw.slice(-35).map((entry) => entry.action_id)).toEqual(
      Array.from({ length: 35 }, (_, index) => index + 1_716),
    );
    expect(timing.raw.length).toBeLessThanOrEqual(512);
    expect(recorder.snapshot()?.observer_entries_aggregated).toBeGreaterThan(442);
  });

  it("converts observer initialization exceptions to a fixed failure with no private message", () => {
    const { env } = fixture({ supported: ["event_timing"], observerInitThrows: true });
    const recorder = createResponsivenessRecorder(descriptor, env);
    expect(recorder.snapshot()?.failure).toEqual({ code: "observer_init", phase: "observer", count: 1 });
    expect(recorder.snapshot()?.limitations).toContain("long_tasks_unsupported");
    expect(JSON.stringify(recorder.snapshot())).not.toContain("private browser failure");
  });

  it("surfaces observer cleanup failure with a fixed code", () => {
    const { env } = fixture({ supported: ["event_timing"], observerDisconnectThrows: true });
    const recorder = createResponsivenessRecorder(descriptor, env);
    const owner = recorder.startSetup("source-1")!;
    recorder.settleSetup(owner);
    recorder.recordEvent({ owner, kind: "scenario_settled" });
    const trace = recorder.finalize();
    expect(trace?.failure).toEqual({ code: "observer_delivery", phase: "teardown", count: 1 });
    expect(trace?.settled).toBe(false);
  });

  it("rejects paths and invalid opaque identifiers without serializing them", () => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    expect(recorder.startSetup("/Users/private/movie.mp4")).toBeNull();
    const serialized = JSON.stringify(recorder.snapshot());
    expect(serialized).not.toContain("/Users/private");
    expect(recorder.snapshot()?.failure).toEqual({ code: "state_transition", phase: "setup", count: 1 });
  });

  it("accepts exact count caps and fails on the next record", () => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env, { maxSetups: 2 });
    expect(recorder.startSetup("source-1")).not.toBeNull();
    expect(recorder.startSetup("source-2")).not.toBeNull();
    expect(recorder.startSetup("source-3")).toBeNull();
    expect(recorder.snapshot()?.failure).toEqual({ code: "capacity_accounting", phase: "setup", count: 1 });
    expect(recorder.snapshot()?.dropped_events).toBe(1);
  });

  it.each([
    ["action", { maxActions: 1 }, (recorder: ReturnType<typeof createResponsivenessRecorder>) => {
      arm(recorder, 1, "source-1");
      recorder.cancelAction(1);
      arm(recorder, 2, "source-2");
    }],
    ["span", { maxSpans: 1 }, (recorder: ReturnType<typeof createResponsivenessRecorder>) => {
      const owner = recorder.startSetup("source-1")!;
      recorder.startSpan({ owner, kind: "inspection_queue" });
      recorder.startSpan({ owner, kind: "inspection_native" });
    }],
    ["event", { maxEvents: 1 }, (recorder: ReturnType<typeof createResponsivenessRecorder>) => {
      const owner = recorder.startSetup("source-1")!;
      recorder.recordEvent({ owner, kind: "inspection_queued" });
      recorder.recordEvent({ owner, kind: "inspection_started" });
    }],
  ] as const)("classifies %s count overflow as capacity accounting", (_name, limits, overflow) => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env, limits);
    overflow(recorder);
    expect(recorder.snapshot()?.failure?.code).toBe("capacity_accounting");
    expect(recorder.snapshot()?.dropped_events).toBe(1);
  });

  it("accepts a 64-byte opaque ID and rejects the 65-byte boundary", () => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    expect(recorder.startSetup("a".repeat(64))).not.toBeNull();
    expect(recorder.startSetup("b".repeat(65))).toBeNull();
    expect(recorder.snapshot()?.failure).toEqual({ code: "state_transition", phase: "setup", count: 1 });
  });

  it("fails malformed descriptors without throwing or retaining invalid enum values", () => {
    const { env } = fixture({ byteSize: () => { throw new Error("private"); } });
    const malformed = { ...descriptor, lane: "invalid" } as unknown as ResponsivenessDescriptor;
    expect(() => createResponsivenessRecorder(malformed, env)).not.toThrow();
    const recorder = createResponsivenessRecorder(malformed, env);
    expect(recorder.snapshot()?.failure).toEqual({ code: "state_transition", phase: "create", count: 1 });
    expect(recorder.snapshot()?.lane).toBe("inspection");
  });

  it("rejects a registry page-identity mismatch and reaps the candidate", () => {
    const registry = createPageRecorderRegistry();
    const { env, disconnect } = fixture({ supported: ["event_timing"] });
    const recorder = createResponsivenessRecorder(descriptor, env);
    expect(registry.install(recorder, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(recorder.snapshot()?.failure).toEqual({ code: "state_transition", phase: "install", count: 1 });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("uses O(1) conservative byte reservations at the exact boundary", () => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env, {
      maxSetups: 10,
      maxSerializedBytes: 5_632 + 192,
    });
    expect(recorder.startSetup("a".repeat(64))).toEqual({ kind: "setup", setup_id: 1 });
    expect(recorder.startSetup("source-2")).toBeNull();
    expect(recorder.snapshot()?.failure).toEqual({
      code: "capacity_accounting",
      phase: "setup",
      count: 1,
    });
  });

  it("serializes once deterministically and enforces the emitted byte cap", () => {
    const size = vi.fn((value: string) => new TextEncoder().encode(value).byteLength);
    const { env } = fixture({ byteSize: size });
    const recorder = createResponsivenessRecorder(descriptor, {
      ...env,
      utf8ByteLength: (value) => {
        const actual = size(value);
        return value.startsWith("{") ? 10_000_000 : actual;
      },
    });
    const owner = recorder.startSetup("source-1")!;
    recorder.settleSetup(owner);
    recorder.recordEvent({ owner, kind: "scenario_settled" });
    size.mockClear();
    const first = recorder.finalize();
    const second = recorder.finalize();
    expect(first?.failure).toEqual({ code: "serialization", phase: "serialize", count: 1 });
    expect(first?.settled).toBe(false);
    expect(second).toBe(first);
    expect(size).toHaveBeenCalledTimes(1);
    expect(recorder.snapshot()?.failure).toEqual({ code: "serialization", phase: "serialize", count: 1 });
  });

  it("installs once before start and resolves the recorder late", () => {
    const registry = createPageRecorderRegistry();
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    expect(registry.get()).toBe(NOOP_RESPONSIVENESS_RECORDER);
    const token = registry.install(recorder, descriptor.pageInstanceId);
    expect(token).not.toBeNull();
    expect(registry.get()).toBe(recorder);
    expect(registry.install(recorder, descriptor.pageInstanceId)).toBeNull();
    registry.markScenarioStarted();
    expect(registry.install(recorder, descriptor.pageInstanceId)).toBeNull();
    expect(registry.teardown("wrong-token")).toBe(false);
    expect(registry.teardown(token!)).toBe(true);
    expect(registry.get()).toBe(NOOP_RESPONSIVENESS_RECORDER);
    expect(registry.install(recorder, descriptor.pageInstanceId)).toBeNull();
  });

  it("seals permanently when the scenario starts before recorder installation", () => {
    const registry = createPageRecorderRegistry();
    const { env, disconnect } = fixture({ supported: ["event_timing"] });
    registry.markScenarioStarted();
    const recorder = createResponsivenessRecorder(descriptor, env);
    expect(registry.install(recorder, descriptor.pageInstanceId)).toBeNull();
    expect(recorder.snapshot()?.failure).toEqual({ code: "state_transition", phase: "install", count: 1 });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("settles the scenario exactly once and invalidates later events", () => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    arm(recorder, 1, "source-1");
    claim(recorder);
    completeHandler(recorder, 1);
    recorder.settleAction(1);
    const owner = { kind: "action" as const, action_id: 1 };
    recorder.recordEvent({ owner, kind: "scenario_settled" });
    expect(recorder.snapshot()?.settled).toBe(true);
    recorder.recordEvent({ owner, kind: "scenario_settled" });
    expect(recorder.snapshot()?.settled).toBe(false);
    expect(recorder.snapshot()?.late_events).toBe(1);
    expect(recorder.snapshot()?.failure?.code).toBe("state_transition");
  });

  it("fails finalization when scenario_settled was never recorded", () => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    const owner = recorder.startSetup("source-1")!;
    recorder.settleSetup(owner);
    const trace = recorder.finalize();
    expect(trace?.settled).toBe(false);
    expect(trace?.failure).toEqual({ code: "state_transition", phase: "serialize", count: 1 });
  });

  it("keeps a generated maximum-event component within conservative and emitted-byte limits", () => {
    const { env } = fixture();
    const recorder = createResponsivenessRecorder(descriptor, env);
    const owner = recorder.startSetup("source-1")!;
    for (let index = 0; index < 16_383; index += 1) {
      recorder.recordEvent({ owner, kind: "inspection_queued" });
    }
    recorder.settleSetup(owner);
    recorder.recordEvent({ owner, kind: "scenario_settled" });
    const trace = recorder.finalize();
    expect(trace?.failure).toBeNull();
    expect(trace?.events).toHaveLength(16_384);
    expect(new TextEncoder().encode(JSON.stringify(trace)).byteLength).toBeLessThanOrEqual(6 * 1024 * 1024);
  });

  it("seals disabled permanently and never allows a late enable", () => {
    const registry = createPageRecorderRegistry();
    const { env } = fixture();
    registry.sealDisabled();
    expect(registry.install(createResponsivenessRecorder(descriptor, env), descriptor.pageInstanceId)).toBeNull();
    expect(registry.get()).toBe(NOOP_RESPONSIVENESS_RECORDER);
  });
});
