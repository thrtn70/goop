import { describe, expect, it } from "vitest";
import { parseRanges } from "@/features/pdf/PdfSplitEditor";

describe("PdfSplitEditor parseRanges", () => {
  it("parses a single page", () => {
    expect(parseRanges("3", 5)).toEqual({
      ranges: [{ start: 3, end: 3 }],
      error: null,
    });
  });

  it("parses a simple range", () => {
    expect(parseRanges("1-3", 5)).toEqual({
      ranges: [{ start: 1, end: 3 }],
      error: null,
    });
  });

  it("parses multiple ranges with whitespace", () => {
    expect(parseRanges("1-3, 7-10", 12)).toEqual({
      ranges: [
        { start: 1, end: 3 },
        { start: 7, end: 10 },
      ],
      error: null,
    });
  });

  it("rejects empty input with a hint", () => {
    const out = parseRanges("", 5);
    expect(out.ranges).toEqual([]);
    expect(out.error).toMatch(/range/i);
  });

  it("rejects reversed ranges", () => {
    const out = parseRanges("3-1", 5);
    expect(out.ranges).toEqual([]);
    expect(out.error).toMatch(/end before start/);
  });

  it("rejects out-of-bounds ranges", () => {
    const out = parseRanges("1-999", 5);
    expect(out.ranges).toEqual([]);
    expect(out.error).toMatch(/past page 5/);
  });

  it("rejects non-integer inputs", () => {
    const out = parseRanges("1-abc", 5);
    expect(out.ranges).toEqual([]);
    expect(out.error).not.toBeNull();
  });

  it("rejects zero-page documents", () => {
    const out = parseRanges("1", 0);
    expect(out.ranges).toEqual([]);
    expect(out.error).toMatch(/no pages/);
  });

  it("rejects extra commas", () => {
    const out = parseRanges("1,,3", 5);
    expect(out.ranges).toEqual([]);
    expect(out.error).toMatch(/Extra comma/);
  });
});
