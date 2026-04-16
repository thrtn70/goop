import clsx from "clsx";
import type { QualityPreset, ResolutionCap } from "@/types";

const QUALITY_OPTIONS: { value: QualityPreset; label: string; hint: string }[] = [
  { value: "original", label: "Original", hint: "Keep as-is, no re-encoding" },
  { value: "fast", label: "Fast", hint: "Quick export, good quality" },
  { value: "balanced", label: "Balanced", hint: "Smaller file, takes a bit longer" },
  { value: "small", label: "Small", hint: "Smallest file, slowest export" },
];

const RESOLUTION_OPTIONS: { value: ResolutionCap; label: string; hint: string }[] = [
  { value: "original", label: "Original", hint: "Keep the source resolution" },
  { value: "r1080p", label: "1080p", hint: "Full HD" },
  { value: "r720p", label: "720p", hint: "HD, good for sharing" },
  { value: "r480p", label: "480p", hint: "SD, small files" },
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
    <div className="mt-3 space-y-2 rounded-md bg-surface-0 p-3">
      <div>
        <span className="mb-1 block text-xs uppercase tracking-wide text-fg-muted">Quality</span>
        <div className="flex gap-1.5">
          {QUALITY_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              title={o.hint}
              onClick={() => onQualityChange(o.value)}
              className={clsx(
                "btn-press rounded-md px-2.5 py-1 text-xs font-medium transition duration-fast ease-out",
                qualityPreset === o.value
                  ? "bg-accent text-accent-fg"
                  : "bg-surface-2 text-fg-secondary hover:bg-surface-3",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="mb-1 block text-xs uppercase tracking-wide text-fg-muted">Max resolution</span>
        <div className="flex gap-1.5">
          {RESOLUTION_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              title={o.hint}
              onClick={() => onResolutionChange(o.value)}
              className={clsx(
                "btn-press rounded-md px-2.5 py-1 text-xs font-medium transition duration-fast ease-out",
                resolutionCap === o.value
                  ? "bg-accent text-accent-fg"
                  : "bg-surface-2 text-fg-secondary hover:bg-surface-3",
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
