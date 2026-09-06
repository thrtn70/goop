import { expect, it, vi } from "vitest";
it("new draft identities cannot collide with entries restored from a prior session", async () => {
  const first = await import("../entries");
  const saved = first.newIdentity();
  vi.resetModules();
  const restarted = await import("../entries");
  expect(restarted.newIdentity().id).not.toBe(saved.id);
});
