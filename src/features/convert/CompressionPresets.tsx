import clsx from "clsx";
import type { QualityPreset, ResolutionCap } from "@/types";

const QUALITY_OPTIONS: { value: QualityPreset; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "small", label: "Small" },
];

const RESOLUTION_OPTIONS: { value: ResolutionCap; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "r1080p", label: "1080p" },
  { value: "r720p", label: "720p" },
  { value: "r480p", label: "480p" },
];

interface CompressionPresetsProps {
  qualityPreset: QualityPreset;
  resolutionCap: ResolutionCap;
  onQualityChange: (p: QualityPreset) => void;
  onResolutionChange: (r: ResolutionCap) => void;
  visible: boolean;
}

export default function CompressionPresets({
  qualityPreset,
  resolutionCap,
  onQualityChange,
  onResolutionChange,
  visible,
}: CompressionPresetsProps) {
  if (!visible) return null;

  return (
    <div className="mt-3 space-y-2 rounded border border-neutral-800 bg-neutral-950 p-3">
      <div>
        <span className="mb-1 block text-[10px] uppercase text-neutral-500">Quality</span>
        <div className="flex gap-1.5">
          {QUALITY_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onQualityChange(o.value)}
              className={clsx(
                "rounded px-2.5 py-1 text-xs font-medium transition",
                qualityPreset === o.value
                  ? "bg-sky-600 text-white"
                  : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="mb-1 block text-[10px] uppercase text-neutral-500">Max resolution</span>
        <div className="flex gap-1.5">
          {RESOLUTION_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onResolutionChange(o.value)}
              className={clsx(
                "rounded px-2.5 py-1 text-xs font-medium transition",
                resolutionCap === o.value
                  ? "bg-sky-600 text-white"
                  : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
