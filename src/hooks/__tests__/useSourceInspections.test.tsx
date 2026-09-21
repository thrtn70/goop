import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSourceInspections } from "../useSourceInspections";
const { inspect, recorder } = vi.hoisted(() => ({
  inspect: vi.fn(),
  recorder: {
    startSetup: vi.fn(() => ({ kind: "setup", setup_id: 1 })),
    settleSetup: vi.fn(),
    cancelSetup: vi.fn(),
    startSpan: vi.fn(() => 1),
    endSpan: vi.fn(),
    cancelSpan: vi.fn(),
    recordEvent: vi.fn(),
  },
}));
vi.mock("@/ipc/commands", () => ({ api: { convert: { inspect } } }));
vi.mock("@/performance/responsiveness", () => ({
  getResponsivenessRecorder: () => recorder,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("issues one inspection after StrictMode replay and does not re-probe option or selection renders", async () => {
  inspect.mockResolvedValue({ probe: {}, capabilities: {} });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StrictMode>{children}</StrictMode>
  );
  const { result, rerender } = renderHook(
    ({ revision }) =>
      useSourceInspections([{ id: "a", path: "/a.dng", revision }]),
    { wrapper, initialProps: { revision: 0 } },
  );
  await waitFor(() => expect(result.current.byId.a?.phase).toBe("ready"));
  rerender({ revision: 1 });
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(recorder.startSetup).toHaveBeenCalledWith("a");
  const recorderCalls = Object.values(recorder).flatMap((mock) =>
    mock.mock.calls,
  );
  expect(JSON.stringify(recorderCalls)).not.toContain("/a.dng");
});

it("forwards the measured remove action when retiring an active inspection", async () => {
  let resolveInspection!: (value: {
    probe: object;
    capabilities: object;
  }) => void;
  inspect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveInspection = resolve;
      }),
  );
  const { result } = renderHook(() =>
    useSourceInspections([{ id: "a", path: "/a.dng" }]),
  );
  await waitFor(() => expect(inspect).toHaveBeenCalledWith("/a.dng"));

  act(() => result.current.retire("a", 37));

  expect(recorder.cancelSpan).toHaveBeenCalledWith(1, 37);
  expect(recorder.cancelSetup).toHaveBeenCalledWith({
    kind: "setup",
    setup_id: 1,
  });
  await act(async () => {
    resolveInspection({ probe: {}, capabilities: {} });
    await Promise.resolve();
  });
});
