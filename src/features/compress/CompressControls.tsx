import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { useEffect, useMemo } from "react";
import clsx from "clsx";
import type { CompressMode, ProbeResult, CompressionCapabilities } from "@/types";
import { adviseTargetSize, bytesFromInput, formatBytes, type SizeUnit } from "./sizeMath";

function sourceKindLabel(probe: ProbeResult): "video" | "audio" | "image" | "pdf" {
  // A subtitle file has no size worth compressing and the Compress tab
  // offers it no useful controls, but nothing stops one being dropped
  // here. Fall back to the video labels rather than widening the union.
  return probe.source_kind === "subtitle" ? "video" : probe.source_kind;
}

interface CompressControlsProps {
  probe: ProbeResult;
  capabilities: CompressionCapabilities;
  mode: CompressMode;
  onChange: (mode: CompressMode) => void;
  /** A partial value/unit edit must survive an earlier request completing. */
  onDraftEdit?: () => void;
}

export default function CompressControls({ probe, mode, onChange, capabilities, onDraftEdit }: CompressControlsProps) {
  const avail = useMemo(() => ({ quality: capabilities.quality, targetSize: capabilities.target_size, lossless: capabilities.lossless, hint: capabilities.reason }), [capabilities]);
  const sourceBytes = Number(probe.file_size);
  const durationMs = Number(probe.duration_ms);

  // Local draft for the Target size input (so the user can type freely before we parse on blur).
  const [sizeInput, setSizeInput] = useWorkspaceDraftState<string>("CompressControls.sizeInput", () => {
    if (mode.kind === "target_size_bytes") {
      const mb = Number(mode.value) / (1024 * 1024);
      if (mb >= 1) return String(mb);
      const kb = Number(mode.value) / 1024;
      return String(kb);
    }
    return "10";
  });
  const [sizeUnit, setSizeUnit] = useWorkspaceDraftState<SizeUnit>("CompressControls.sizeUnit", () => {
    if (mode.kind === "target_size_bytes" && Number(mode.value) < 1024 * 1024) return "kb";
    return "mb";
  });

  const modeKey = mode.kind === "lossless_reoptimize" ? mode.kind : `${mode.kind}:${mode.value}`;
  const [appliedMode, setAppliedMode] = useWorkspaceDraftState("CompressControls.appliedMode", modeKey);
  useEffect(() => {
    if (appliedMode === modeKey) return;
    setAppliedMode(modeKey);
    if (mode.kind !== "target_size_bytes") return;
    const bytes = Number(mode.value);
    const unit: SizeUnit = bytes < 1024 * 1024 ? "kb" : "mb";
    setSizeUnit(unit);
    setSizeInput(String(bytes / (unit === "kb" ? 1024 : 1024 * 1024)));
  }, [mode, modeKey, appliedMode, setAppliedMode, setSizeUnit, setSizeInput]);

  const modeAllowed = mode.kind === "quality" ? avail.quality : mode.kind === "target_size_bytes" ? avail.targetSize : avail.lossless;
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
      {!modeAllowed && <p className="mb-3 text-xs text-warning" role="alert">The selected compression mode is unavailable. Choose a supported mode before starting.</p>}
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
          <div className="mt-1 flex justify-between text-xs text-fg-muted">
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

      {currentTab === "target_size" && avail.targetSize && (
        <div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={sizeInput}
              onChange={(e) => {
                setSizeInput(e.target.value);
                onDraftEdit?.();
              }}
              onBlur={() => commitTargetSize(sizeInput, sizeUnit)}
              className="w-24 rounded-md bg-surface-1 px-2 py-1 text-sm tabular-nums text-fg focus:outline-none focus:ring-2 focus:ring-accent"
              aria-label="Target size value"
            />
            <select
              value={sizeUnit}
              onChange={(e) => {
                const u = e.target.value as SizeUnit;
                setSizeUnit(u);
                onDraftEdit?.();
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
