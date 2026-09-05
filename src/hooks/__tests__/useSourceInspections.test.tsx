import { StrictMode, type ReactNode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSourceInspections } from "../useSourceInspections";
const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("@/ipc/commands", () => ({ api: { convert: { inspect } } }));
afterEach(cleanup);
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
});
