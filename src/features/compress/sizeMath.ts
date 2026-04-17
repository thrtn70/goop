/**
 * Unit parsing helpers for the Compress tab's target-size input.
 *
 * The Rust backend takes `TargetSizeBytes(u64)` — always bytes. The frontend
 * shows KB or MB for user-friendliness and converts on submit.
 */

export type SizeUnit = "kb" | "mb";

export function bytesFromInput(value: number, unit: SizeUnit): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const multiplier = unit === "kb" ? 1024 : 1024 * 1024;
  return Math.round(value * multiplier);
}

export function bytesToInput(bytes: number, unit: SizeUnit): number {
  const divisor = unit === "kb" ? 1024 : 1024 * 1024;
  return bytes / divisor;
}

/**
 * Format a byte count for display, picking a reasonable unit.
 * e.g. formatBytes(3_500_000) -> "3.3 MB", formatBytes(850) -> "850 B"
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Warning check for target-size sanity. Returns a user-readable string if the
 * target is too aggressive to yield acceptable quality, or `null` if fine.
 */
export interface TargetSizeAdvice {
  level: "ok" | "warn" | "error";
  message: string | null;
}

export function adviseTargetSize(
  targetBytes: number,
  sourceBytes: number,
  durationMs: number,
  sourceKind: "video" | "audio" | "image" | "pdf",
): TargetSizeAdvice {
  if (targetBytes <= 0) {
    return { level: "error", message: "Enter a size greater than zero." };
  }
  if (targetBytes >= sourceBytes) {
    return {
      level: "warn",
      message: "Target is larger than the source. Compression won't save space.",
    };
  }
  // PDFs and images skip the duration-based bitrate advice — they don't
  // have a duration. CompressControls shouldn't render for PDFs in v0.1.8
  // (PdfOperationPicker handles that flow), but widen here defensively.
  if (sourceKind === "image" || sourceKind === "pdf") return { level: "ok", message: null };

  if (durationMs > 0) {
    const kbps = (targetBytes * 8) / 1000 / (durationMs / 1000);
    if (sourceKind === "audio" && kbps < 32) {
      return {
        level: "warn",
        message: "That's below 32 kbps — audio will sound rough.",
      };
    }
    if (sourceKind === "video" && kbps < 100) {
      return {
        level: "warn",
        message: "That's below 100 kbps total — video will look rough.",
      };
    }
  }
  return { level: "ok", message: null };
}
