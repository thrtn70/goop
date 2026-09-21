import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { scheduleInspection } from "../sourceInspectionScheduler";
const { inspect, recorder } = vi.hoisted(() => ({
  inspect: vi.fn(),
  recorder: {
    startSetup: vi.fn(),
    settleSetup: vi.fn(),
    cancelSetup: vi.fn(),
    startSpan: vi.fn(),
    endSpan: vi.fn(),
    cancelSpan: vi.fn(),
    recordEvent: vi.fn(),
  },
}));
vi.mock("@/ipc/commands", () => ({ api: { convert: { inspect } } }));
vi.mock("@/performance/responsiveness", () => ({
  getResponsivenessRecorder: () => recorder,
}));

beforeEach(() => {
  let nextSpanId = 1;
  recorder.startSetup.mockImplementation((sourceId: string) => ({
    kind: "setup",
    setup_id: sourceId === "source-a" ? 1 : 2,
  }));
  recorder.startSpan.mockImplementation(() => nextSpanId++);
});

afterEach(() => {
  vi.clearAllMocks();
});

it("holds the global slot across retired routes, skips queued work, and releases on rejection", async () => {
  let reject!: (e: Error) => void;
  inspect
    .mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    )
    .mockResolvedValue({ probe: {}, capabilities: {} });
  const stale = vi.fn(),
    live = vi.fn();
  const retireA = scheduleInspection(
    { sourceId: "source-a", path: "/a.jxl" },
    stale,
  );
  const retireB = scheduleInspection(
    { sourceId: "source-b", path: "/b.dng" },
    vi.fn(),
  );
  await Promise.resolve();
  expect(inspect).toHaveBeenCalledTimes(1);
  retireA();
  retireB();
  scheduleInspection({ sourceId: "source-c", path: "/c.png" }, live);
  await Promise.resolve();
  expect(inspect).toHaveBeenCalledTimes(1);
  reject(new Error("old decoder failed"));
  await vi.waitFor(() => expect(live).toHaveBeenCalledOnce());
  expect(inspect.mock.calls.map((c) => c[0])).toEqual(["/a.jxl", "/c.png"]);
  expect(stale).not.toHaveBeenCalled();
});
it("coalesces discarded StrictMode setup before issuing IPC", async () => {
  inspect.mockClear();
  scheduleInspection(
    { sourceId: "throwaway", path: "/throwaway.png" },
    vi.fn(),
  )();
  const ready = vi.fn();
  scheduleInspection({ sourceId: "retained", path: "/retained.png" }, ready);
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  expect(inspect.mock.calls.map((c) => c[0])).toEqual(["/retained.png"]);
});

it("preserves inspection behavior when the recorder is disabled", async () => {
  recorder.startSetup.mockReturnValueOnce(null);
  inspect.mockResolvedValue({ probe: {}, capabilities: {} });
  const deliver = vi.fn();

  scheduleInspection(
    { sourceId: "disabled-source", path: "/disabled.png" },
    deliver,
  );

  await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
  expect(inspect).toHaveBeenCalledWith("/disabled.png");
  expect(deliver.mock.calls[0][0].phase).toBe("ready");
  expect(recorder.startSpan).not.toHaveBeenCalled();
  expect(recorder.recordEvent).not.toHaveBeenCalled();
});

it("records setup-owned queue, native, and delivery spans without exposing paths", async () => {
  inspect.mockResolvedValue({ probe: {}, capabilities: {} });
  const deliver = vi.fn();

  scheduleInspection(
    { sourceId: "source-a", path: "/private/fixture-a.dng" },
    deliver,
  );

  await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

  const owner = { kind: "setup", setup_id: 1 };
  expect(recorder.startSetup).toHaveBeenCalledWith("source-a");
  expect(recorder.startSpan.mock.calls.map(([span]) => span)).toEqual([
    {
      owner,
      kind: "inspection_queue",
      subjectId: "source-a",
    },
    {
      owner,
      kind: "inspection_native",
      subjectId: "source-a",
    },
    {
      owner,
      kind: "inspection_delivery",
      subjectId: "source-a",
    },
  ]);
  expect(recorder.recordEvent.mock.calls.map(([event]) => event.kind)).toEqual([
    "inspection_queued",
    "inspection_started",
    "inspection_settled",
    "inspection_delivered",
  ]);
  expect(recorder.endSpan.mock.calls.map(([spanId]) => spanId)).toEqual([
    1, 2, 3,
  ]);
  expect(recorder.settleSetup).toHaveBeenCalledWith(owner);
  const recorderCalls = Object.values(recorder).flatMap((mock) =>
    mock.mock.calls,
  );
  expect(JSON.stringify(recorderCalls)).not.toContain("/private/fixture-a.dng");
});

it("cancels the open span for active and queued retired sources without delivery", async () => {
  let resolve!: (value: { probe: object; capabilities: object }) => void;
  inspect.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const activeDelivery = vi.fn();
  const queuedDelivery = vi.fn();

  const retireActive = scheduleInspection(
    { sourceId: "source-a", path: "/private/a.dng" },
    activeDelivery,
  );
  const retireQueued = scheduleInspection(
    { sourceId: "source-b", path: "/private/b.dng" },
    queuedDelivery,
  );
  await Promise.resolve();

  retireQueued(42);
  retireActive(41);
  resolve({ probe: {}, capabilities: {} });
  await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
  await Promise.resolve();

  expect(activeDelivery).not.toHaveBeenCalled();
  expect(queuedDelivery).not.toHaveBeenCalled();
  expect(recorder.cancelSpan.mock.calls).toEqual([
    [2, 42],
    [3, 41],
  ]);
  expect(recorder.cancelSetup).toHaveBeenCalledTimes(2);
  expect(
    recorder.startSpan.mock.calls.some(
      ([span]) => span.kind === "inspection_delivery",
    ),
  ).toBe(false);
  const recorderCalls = Object.values(recorder).flatMap((mock) =>
    mock.mock.calls,
  );
  expect(JSON.stringify(recorderCalls)).not.toContain("/private/");
});

it("does not settle a delivery that retires its source", async () => {
  inspect.mockResolvedValue({ probe: {}, capabilities: {} });
  const retirement: {
    current?: (terminalCauseActionId?: number) => void;
  } = {};
  const deliver = vi.fn(() => retirement.current?.(7));
  retirement.current = scheduleInspection(
    { sourceId: "source-a", path: "/private/a.dng" },
    deliver,
  );

  await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

  expect(recorder.cancelSpan).toHaveBeenCalledWith(3, 7);
  expect(recorder.cancelSetup).toHaveBeenCalledOnce();
  expect(recorder.settleSetup).not.toHaveBeenCalled();
  expect(recorder.recordEvent.mock.calls.map(([event]) => event.kind)).toEqual([
    "inspection_queued",
    "inspection_started",
    "inspection_settled",
    "inspection_cancelled",
  ]);
});
