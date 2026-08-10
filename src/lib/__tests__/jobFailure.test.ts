import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_MESSAGE,
  INTERRUPTED_MESSAGE_RETRYABLE,
  canRetryKind,
  failureView,
} from "@/lib/jobFailure";
import type { JobState } from "@/types";

function failed(message: string, detail: string | null = null): JobState {
  return { error: { message, detail } };
}

describe("failureView", () => {
  it("returns null for every state that is not a failure", () => {
    for (const s of ["queued", "running", "paused", "done", "cancelled"] as const) {
      expect(failureView(s)).toBeNull();
    }
  });

  it("shows the message on its own when there is no detail", () => {
    // Every row written before the `error_detail` column existed looks
    // like this. There is nothing to backfill, so the affordance has to be
    // absent rather than empty.
    expect(failureView(failed("The site blocked the request."))).toEqual({
      message: "The site blocked the request.",
      detail: null,
      note: null,
    });
  });

  it("keeps the raw stderr when the friendly message replaced it", () => {
    const raw = "ERROR: [youtube] abc: Sign in to confirm your age\n  File \"...\"";
    expect(failureView(failed("age verification required", raw))).toEqual({
      message: "age verification required",
      detail: raw,
      note: null,
    });
  });

  // --- the duplicate-suppression rules ---------------------------------

  it("suppresses a detail that only repeats the message", () => {
    const v = failureView(failed("yt-dlp: boom", "yt-dlp: boom"));
    expect(v?.detail).toBeNull();
  });

  it("suppresses a detail the message already contains", () => {
    // `GoopError::Network`'s message is its detail under a `network error:`
    // prefix, so a details block would say the same thing twice. Documented
    // on `detail()` itself, and PR-J routes more failures through it.
    const v = failureView(
      failed("network error: connection reset by peer", "connection reset by peer"),
    );
    expect(v?.detail).toBeNull();
    expect(v?.message).toBe("network error: connection reset by peer");
  });

  it("suppresses the unfriendly-stderr case, where the message IS the stderr", () => {
    // No `friendly_message` pattern matched, so `user_message` fell through
    // to the raw text under a binary prefix. Showing it again below itself
    // is pure noise.
    const stderr = "ERROR: [youtube] abc: unexpected token '<' in JSON";
    const v = failureView(failed(`yt-dlp: ${stderr}`, stderr));
    expect(v?.detail).toBeNull();
  });

  it("keeps a detail that differs by more than whitespace", () => {
    const v = failureView(failed("yt-dlp: boom", "  boom\nand the traceback\n"));
    expect(v?.detail).toBe("  boom\nand the traceback");
  });

  it("treats a whitespace-only detail as absent", () => {
    expect(failureView(failed("boom", "   \n  "))?.detail).toBeNull();
    expect(failureView(failed("boom", ""))?.detail).toBeNull();
  });

  // --- the clipped-headline invariant -----------------------------------

  it("keeps the detail reachable when the message is a raw dump", () => {
    // The failures with the MOST raw text are the ones no friendly pattern
    // matched, so `user_message` fell through to the stderr and the message
    // IS the dump. A pure substring test suppressed the details block for
    // exactly those — leaving an 8KB ffmpeg log inside a one-line `truncate`
    // div with no way to expand or copy it. That inverted the whole point.
    const stderr = [
      "ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers",
      "  configuration: --enable-gpl --enable-libx264",
      "[matroska @ 0x7f8] Could not find codec parameters for stream 2",
      "Conversion failed!",
    ].join("\n");
    const v = failureView(failed(`ffmpeg: ${stderr}`, stderr));

    expect(v?.message).toBe("ffmpeg: ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers…");
    expect(v?.detail).toBe(stderr);
    expect(v?.detail).toContain("Conversion failed!");
  });

  it("clips a single enormous line and still hands over the whole thing", () => {
    const long = `ERROR: ${"x".repeat(500)}`;
    const v = failureView(failed(`yt-dlp: ${long}`, long));
    expect(v?.message.length).toBeLessThanOrEqual(181);
    expect(v?.message.endsWith("…")).toBe(true);
    expect(v?.detail).toBe(long);
  });

  it("falls back to the message when a clipped failure has no detail column", () => {
    // Nothing to fall back to otherwise: the rest of the text would only
    // exist in a tooltip.
    const long = "x".repeat(400);
    const v = failureView(failed(long, null));
    expect(v?.message.endsWith("…")).toBe(true);
    expect(v?.detail).toBe(long);
  });

  it("still suppresses a short duplicate that fits on the line", () => {
    // The suppression rule has to survive the clipping change, or every
    // ordinary failure grows a details block that repeats its own headline.
    expect(failureView(failed("yt-dlp: boom", "boom"))?.detail).toBeNull();
    expect(
      failureView(failed("network error: connection reset", "connection reset"))?.detail,
    ).toBeNull();
  });

  // --- Goop's own note --------------------------------------------------

  it("lifts the auto-update note out of the detail", () => {
    const marker = "[goop] yt-dlp auto-updated 2026.01.01 -> 2026.08.09; retried once";
    const v = failureView(
      failed("The site blocked the request.", `ERROR: HTTP Error 403\n${marker}`),
    );
    expect(v?.note).toBe(marker);
    expect(v?.detail).toBe("ERROR: HTTP Error 403");
    expect(v?.detail).not.toContain("[goop]");
  });

  it("lifts the note out of the message too, and still suppresses the duplicate", () => {
    // An unrecognised failure puts the raw stderr in BOTH fields, so the
    // marker lands in both. It must be rendered once, as a note — not
    // buried in a truncated headline, and not left to make the two fields
    // look different enough to show a redundant details block.
    const marker = "[goop] yt-dlp auto-updated 2026.01.01 -> 2026.08.09; retried once";
    const stderr = "ERROR: [youtube] abc: unexpected token '<'";
    const v = failureView(failed(`yt-dlp: ${stderr}\n${marker}`, `${stderr}\n${marker}`));
    expect(v?.note).toBe(marker);
    expect(v?.message).toBe(`yt-dlp: ${stderr}`);
    expect(v?.detail).toBeNull();
  });

  it("does not mistake the tool's own output for a Goop note", () => {
    // Only a line Goop wrote itself counts. A stderr that merely mentions
    // the marker mid-line, or uses the prefix without the space, is the
    // extractor talking.
    const v = failureView(
      failed("boom", "ERROR: saw [goop] in the page title\n[goop]not-a-note"),
    );
    expect(v?.note).toBeNull();
    expect(v?.detail).toContain("[goop]not-a-note");
  });

  it("keeps a note that is the whole of the detail", () => {
    const marker = "[goop] yt-dlp auto-updated 2026.01.01 -> 2026.08.09; retried once";
    const v = failureView(failed("boom", marker));
    expect(v?.note).toBe(marker);
    expect(v?.detail).toBeNull();
  });

  // --- interrupted ------------------------------------------------------

  it("explains an interrupted job instead of showing the bare word", () => {
    // Boot reconcile writes exactly "interrupted" for rows that were
    // running when the app died. On its own it reads like a bug.
    const v = failureView(failed("interrupted"));
    expect(v?.message).toBe(INTERRUPTED_MESSAGE);
    expect(v?.detail).toBeNull();
  });

  it("only tells a job to retry when it actually has a Retry button", () => {
    // Reconcile flips conversions too, and neither surface offers Retry for
    // them. "Retry to resume" would send their owner hunting for a control
    // that does not exist.
    expect(failureView(failed("interrupted"), true)?.message).toBe(
      INTERRUPTED_MESSAGE_RETRYABLE,
    );
    expect(failureView(failed("interrupted"), false)?.message).not.toContain("Retry");
    expect(canRetryKind("extract")).toBe(true);
    expect(canRetryKind("convert")).toBe(false);
  });

  it("only maps the exact interrupted marker", () => {
    // An extractor is entitled to use the word. Matching loosely would
    // relabel a real failure as an app restart.
    for (const m of [
      "ERROR: the connection was interrupted",
      "interrupted by the server",
      "Interrupted",
    ]) {
      expect(failureView(failed(m))?.message).toBe(m);
    }
  });

  it("tolerates surrounding whitespace on the interrupted marker", () => {
    expect(failureView(failed(" interrupted "))?.message).toBe(INTERRUPTED_MESSAGE);
  });
});
