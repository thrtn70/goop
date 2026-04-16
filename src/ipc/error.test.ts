import { describe, it, expect } from "vitest";
import { formatError } from "./error";

describe("formatError", () => {
  it("unwraps Error instances", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("passes strings through", () => {
    expect(formatError("already a string")).toBe("already a string");
  });

  it("returns friendly message for known error codes", () => {
    expect(formatError({ code: "sidecar_missing", message: "yt-dlp" }))
      .toBe("A required helper tool is missing. Try reinstalling Goop.");
  });

  it("falls back to raw message for unknown codes", () => {
    expect(formatError({ code: "cancelled", message: "user cancelled" })).toBe("user cancelled");
  });

  it("falls back to code-only when message missing", () => {
    expect(formatError({ code: "cancelled" })).toBe("cancelled");
  });

  it("falls back to JSON for unknown object shapes", () => {
    expect(formatError({ foo: "bar" })).toBe('{"foo":"bar"}');
  });

  it("never returns the literal [object Object]", () => {
    expect(formatError({ anything: 1 })).not.toBe("[object Object]");
  });
});
