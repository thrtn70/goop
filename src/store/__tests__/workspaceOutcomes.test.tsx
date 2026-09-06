import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ReactNode } from "react";
import { WorkspaceDraftProvider, clearWorkspaceDrafts, forgetWorkspaceSource, resetWorkspaceDrafts } from "../workspaceDrafts";
import { useWorkspaceOutcomeState } from "../workspaceOutcomes";
import { useWorkspaceOperation } from "../workspaceOperations";
const wrapper = (source: string, tool: "image" | "metadata" = "image") => ({children}: {children: ReactNode}) => <WorkspaceDraftProvider tool={tool} scope={["source", source]} sourcePaths={[source]}>{children}</WorkspaceDraftProvider>;
const mount = (source = "/a.png", slot = "resize.error", tool: "image" | "metadata" = "image") => renderHook(() => useWorkspaceOutcomeState<string | null>(slot, null), {wrapper: wrapper(source, tool)});
afterEach(cleanup);
it("retains outcomes off-route while separating source, operation and tool", () => {
 const first = mount(); const set = first.result.current[1]; first.unmount();
 act(() => set("Disk unavailable"));
 expect(mount().result.current[0]).toBe("Disk unavailable");
 expect(mount("/b.png").result.current[0]).toBeNull();
 expect(mount("/a.png", "crop.error").result.current[0]).toBeNull();
 expect(mount("/a.png", "resize.error", "metadata").result.current[0]).toBeNull();
});
for (const retire of [() => clearWorkspaceDrafts("image"), () => forgetWorkspaceSource("image", "/a.png"), resetWorkspaceDrafts]) it("retires an unmounted outcome-only scope without reviving old callbacks", () => {
 const first = mount(); const oldSet = first.result.current[1]; first.unmount();
 act(retire);
 const replacement = mount();
 act(() => oldSet("Old failure"));
 expect(replacement.result.current[0]).toBeNull();
 act(() => replacement.result.current[1]("New failure"));
 expect(replacement.result.current[0]).toBe("New failure");
});
it("bounds errors and evicts oldest inactive outcomes while preserving pending operation", () => {
 const pending = renderHook(() => ({outcome: useWorkspaceOutcomeState<string | null>("resize.error", null), operation: useWorkspaceOperation()}), {wrapper: wrapper("/active.png")});
 let finish: (() => void) | null = null;
 act(() => {finish = pending.result.current.operation.begin(); pending.result.current.outcome[1]("Pending");});
 pending.unmount();
 for (let i = 0; i < 105; i++) {
  const value = mount("/" + i + ".png"); act(() => value.result.current[1]("x".repeat(9000))); value.unmount();
 }
 expect(mount("/0.png").result.current[0]).toBeNull();
 expect(mount("/active.png").result.current[0]).toBe("Pending");
 expect(mount("/104.png").result.current[0]?.length).toBe(8192);
 act(() => finish?.());
});
it("refreshes mounted empty-scope setters after reset while retiring captured callbacks", () => {
 const value = mount(); const oldSet = value.result.current[1];
 act(resetWorkspaceDrafts);
 act(() => {oldSet("Old"); value.result.current[1]("New");});
 expect(value.result.current[0]).toBe("New");
});
