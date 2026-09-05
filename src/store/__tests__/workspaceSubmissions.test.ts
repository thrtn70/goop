import { expect, it } from "vitest";
import {
  tryBegin,
  finishSubmission,
  useWorkspaceSubmissions,
} from "../workspaceSubmissions";
it("serializes per tool independently and ignores a stale finish", () => {
  const first = tryBegin("convert")!;
  expect(tryBegin("convert")).toBeNull();
  const sibling = tryBegin("compress")!;
  finishSubmission("convert", first, null);
  const second = tryBegin("convert")!;
  finishSubmission("convert", first, "old error");
  expect(useWorkspaceSubmissions.getState().convert.active?.id).toBe(second);
  expect(useWorkspaceSubmissions.getState().compress.active?.id).toBe(sibling);
  finishSubmission("convert", second, null);
  finishSubmission("compress", sibling, null);
});
it("retires an older destination dialog across controller lifetimes", async () => {
  const { beginDestinationChoice, isCurrentDestinationChoice } = await import(
    "../workspaceSubmissions"
  );
  const old = beginDestinationChoice("convert");
  const latest = beginDestinationChoice("convert");
  expect(isCurrentDestinationChoice("convert", old)).toBe(false);
  expect(isCurrentDestinationChoice("convert", latest)).toBe(true);
  expect(isCurrentDestinationChoice("compress", latest)).toBe(false);
});
