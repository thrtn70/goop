import { useMemo, useState } from "react";
import clsx from "clsx";
import type { CompressMode, ProbeResult } from "@/types";
import { adviseTargetSize, bytesFromInput, formatBytes, type SizeUnit } from "./sizeMath";

/**
 * Which controls the current source type + target format allow.
 *
 * The backend rejects invalid combinations (e.g., target-size on PNG), but
 * the UI disables them up-front to make the affordance obvious.
 */
interface Availability {
  quality: boolean;
  targetSize: boolean;
  lossless: boolean;
  hint: string | null;
}

function availabilityFor(probe: ProbeResult): Availability {
  if (probe.source_kind === "image") {
    const fmt = (probe.image_format ?? "").toLowerCase();
    if (fmt === "jpeg" || fmt === "webp") {
      return { quality: true, targetSize: true, lossless: false, hint: null };
    }
    if (fmt === "png") {
      return {
        quality: false,
        targetSize: false,
        lossless: true,
        hint: "PNG is lossless. Re-optimize shrinks without quality loss. For target-size compression, convert to JPEG or WebP first.",
      };
    }
    if (fmt === "bmp") {
      return {
        quality: false,
        targetSize: false,
        lossless: false,
        hint: "BMP has no compression. Convert to PNG first.",
      };
    }
    return { quality: true, targetSize: true, lossless: false, hint: null };
  }
  // Video / audio: both modes available
  return { quality: true, targetSize: true, lossless: false, hint: null };
}

function sourceKindLabel(probe: ProbeResult): "video" | "audio" | "image" | "pdf" {
  return probe.source_kind;
}

interface CompressControlsProps {
  probe: ProbeResult;
  mode: CompressMode;
  onChange: (mode: CompressMode) => void;
}

export default function CompressControls({ probe, mode, onChange }: CompressControlsProps) {
  const avail = useMemo(() => availabilityFor(probe), [probe]);
  const sourceBytes = Number(probe.file_size);
  const durationMs = Number(probe.duration_ms);

  // Local draft for the Target size input (so the user can type freely before we parse on blur).
  const [sizeInput, setSizeInput] = useState<string>(() => {
    if (mode.kind === "target_size_bytes") {
      const mb = Number(mode.value) / (1024 * 1024);
      if (mb >= 1) return mb.toFixed(1);
      const kb = Number(mode.value) / 1024;
      return kb.toFixed(0);
    }
    return "10";
  });
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>(() => {
    if (mode.kind === "target_size_bytes" && Number(mode.value) < 1024 * 1024) return "kb";
    return "mb";
  });

  const currentTab: "quality" | "target_size" =
    mode.kind === "target_size_bytes" ? "target_size" : "quality";

  const commitTargetSize = (raw: string, unit: SizeUnit) => {
    const num = parseFloat(raw);
    if (!Number.isFinite(num) || num <= 0) return;
    const bytes = bytesFromInput(num, unit);
    onChange({ kind: "target_size_bytes", value: BigInt(bytes) });
  };

  const switchToQuality = () => {
    if (avail.lossless && !avail.quality) {
      onChange({ kind: "lossless_reoptimize" });
    } else {
      onChange({ kind: "quality", value: 75 });
    }
  };

  const switchToTargetSize = () => {
    const num = parseFloat(sizeInput);
    const safe = Number.isFinite(num) && num > 0 ? num : 10;
    onChange({ kind: "target_size_bytes", value: BigInt(bytesFromInput(safe, sizeUnit)) });
  };

  const targetBytes =
    mode.kind === "target_size_bytes" ? Number(mode.value) : 0;
  const advice =
    currentTab === "target_size" && targetBytes > 0
      ? adviseTargetSize(targetBytes, sourceBytes, durationMs, sourceKindLabel(probe))
      : { level: "ok" as const, message: null };

  const qualityValue = mode.kind === "quality" ? mode.value : 75;

  return (
    <div className="mt-3 rounded-lg bg-surface-2 p-3">
      {/* Hint banner for formats with restrictions */}
      {avail.hint && (
        <p className="mb-3 text-xs text-fg-secondary">{avail.hint}</p>
      )}

      {/* Tab toggle */}
      <div className="mb-3 inline-flex rounded-md bg-surface-1 p-0.5">
        <button
          type="button"
          disabled={!avail.quality && !avail.lossless}
          onClick={switchToQuality}
          className={clsx(
            "btn-press rounded px-3 py-1 text-xs font-medium transition duration-fast ease-out",
            currentTab === "quality"
              ? "bg-accent text-accent-fg"
              : "text-fg-secondary hover:text-fg",
            !avail.quality && !avail.lossless && "cursor-not-allowed opacity-40",
          )}
        >
          {avail.lossless && !avail.quality ? "Re-optimize" : "Quality"}
        </button>
        <button
          type="button"
          disabled={!avail.targetSize}
          onClick={switchToTargetSize}
          className={clsx(
            "btn-press rounded px-3 py-1 text-xs font-medium transition duration-fast ease-out",
            currentTab === "target_size"
              ? "bg-accent text-accent-fg"
              : "text-fg-secondary hover:text-fg",
            !avail.targetSize && "cursor-not-allowed opacity-40",
          )}
        >
          Target size
        </button>
      </div>

      {/* Body */}
      {currentTab === "quality" && avail.quality && (
        <div>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={100}
              value={qualityValue}
              onChange={(e) =>
                onChange({ kind: "quality", value: parseInt(e.target.value, 10) })
              }
              className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-surface-3 accent-accent"
              aria-label="Compression quality"
            />
            <span className="w-10 text-right text-sm tabular-nums text-fg">
              {qualityValue}
            </span>
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-fg-muted">
            <span>Smaller</span>
            <span>Better quality</span>
          </div>
        </div>
      )}

      {currentTab === "quality" && !avail.quality && avail.lossless && (
        <button
          type="button"
          onClick={() => onChange({ kind: "lossless_reoptimize" })}
          className={clsx(
            "btn-press rounded-md px-3 py-2 text-sm font-medium transition duration-fast ease-out",
            mode.kind === "lossless_reoptimize"
              ? "bg-accent text-accent-fg"
              : "bg-surface-1 text-fg-secondary hover:bg-surface-3",
          )}
        >
          Re-optimize losslessly
        </button>
      )}

      {currentTab === "target_size" && (
        <div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={sizeInput}
              onChange={(e) => setSizeInput(e.target.value)}
              onBlur={() => commitTargetSize(sizeInput, sizeUnit)}
              className="w-24 rounded-md bg-surface-1 px-2 py-1 text-sm tabular-nums text-fg focus:outline-none focus:ring-2 focus:ring-accent"
              aria-label="Target size value"
            />
            <select
              value={sizeUnit}
              onChange={(e) => {
                const u = e.target.value as SizeUnit;
                setSizeUnit(u);
                commitTargetSize(sizeInput, u);
              }}
              className="rounded-md bg-surface-1 px-2 py-1 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent"
              aria-label="Target size unit"
            >
              <option value="kb">KB</option>
              <option value="mb">MB</option>
            </select>
            {sourceBytes > 0 && (
              <span className="text-xs text-fg-muted">
                source: {formatBytes(sourceBytes)}
              </span>
            )}
          </div>
          {advice.message && (
            <p
              className={clsx(
                "mt-2 text-xs",
                advice.level === "warn" && "text-warning",
                advice.level === "error" && "text-error",
                advice.level === "ok" && "text-fg-muted",
              )}
              role="status"
            >
              {advice.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
