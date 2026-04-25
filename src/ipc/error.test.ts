import { describe, it, expect } from "vitest";
import { formatError, parseIpcError } from "./error";

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

  it("formats subprocess failures from structured IPC errors", () => {
    expect(formatError({ code: "subprocess_failed", message: "ffmpeg: bad input" })).toBe(
      "ffmpeg: bad input",
    );
  });

  it("formats cancellation without a message", () => {
    expect(formatError({ code: "cancelled" })).toBe("cancelled");
  });

  it("maps unrecognized structured codes to the unknown variant", () => {
    expect(parseIpcError({ code: "future_error", message: "new shape" })).toEqual({
      code: "unknown",
      message: "new shape",
    });
  });

  it("falls back to JSON for unknown object shapes", () => {
    expect(formatError({ foo: "bar" })).toBe('{"foo":"bar"}');
  });

  it("never returns the literal [object Object]", () => {
    expect(formatError({ anything: 1 })).not.toBe("[object Object]");
  });
});
