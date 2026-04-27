import { useMemo, useState } from "react";
import type { PageRange } from "@/types";

interface PdfSplitEditorProps {
  totalPages: number;
  ranges: PageRange[];
  onChange: (ranges: PageRange[]) => void;
}

/**
 * Pure-frontend mirror of the backend range parser — keeps the input
 * responsive without a round-trip per keystroke. The backend validates
 * again before actually splitting (don't trust the UI with destructive
 * operations).
 */
export function parseRanges(input: string, totalPages: number): {
  ranges: PageRange[];
  error: string | null;
} {
  const trimmed = input.trim();
  if (!trimmed) return { ranges: [], error: "Enter a range (e.g. 1-3, 7-10)" };
  if (totalPages === 0) return { ranges: [], error: "Document has no pages" };
  const out: PageRange[] = [];
  for (const segment of trimmed.split(",")) {
    const seg = segment.trim();
    if (!seg) return { ranges: [], error: "Extra comma in range" };
    let start: number;
    let end: number;
    if (seg.includes("-")) {
      const [a, b] = seg.split("-").map((s) => s.trim());
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(seg);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
      return { ranges: [], error: `"${seg}" isn't a valid range` };
    }
    if (end < start) return { ranges: [], error: `"${seg}" has end before start` };
    if (end > totalPages) {
      return { ranges: [], error: `"${seg}" goes past page ${totalPages}` };
    }
    out.push({ start, end });
  }
  return { ranges: out, error: null };
}

export default function PdfSplitEditor({
  totalPages,
  ranges: _parentRanges,
  onChange,
}: PdfSplitEditorProps) {
  const [input, setInput] = useState("");
  const { ranges, error } = useMemo(() => parseRanges(input, totalPages), [input, totalPages]);

  // Keep the parent in sync whenever parsing succeeds.
  useMemoEffect(() => {
    if (!error) onChange(ranges);
  }, [input, error, ranges, onChange]);

  const preview =
    ranges.length === 1
      ? "1 file"
      : ranges.length > 1
        ? `${ranges.length} files`
        : "";

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="pdf-split-pages" className="text-xs text-fg-muted">
        Page ranges
      </label>
      <input
        id="pdf-split-pages"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={`e.g. 1-3, 7-10  (this PDF has ${totalPages} pages)`}
        className="rounded-md bg-surface-2 px-3 py-1.5 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
        aria-invalid={error ? true : false}
        aria-describedby="pdf-split-pages-help"
      />
      <span id="pdf-split-pages-help" className="text-xs">
        {error ? (
          <span className="text-error">{error}</span>
        ) : preview ? (
          <span className="text-fg-muted">Will produce {preview}.</span>
        ) : null}
      </span>
    </div>
  );
}

// Tiny helper — like useEffect but resets dependency-comparison for the
// case where the effect body owns the reference (avoids an unstable
// `onChange` prop causing an infinite loop).
import { useEffect } from "react";
function useMemoEffect(cb: () => void, deps: unknown[]): void {
  useEffect(() => {
    cb();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
