import clsx from "clsx";
import type { GifOptions, GifSizePreset } from "@/types";

const SIZE_OPTIONS: { value: GifSizePreset; label: string; px: number }[] = [
  { value: "small", label: "Small", px: 320 },
  { value: "medium", label: "Medium", px: 480 },
  { value: "large", label: "Large", px: 720 },
];

interface GifOptionsPanelProps {
  gifOptions: GifOptions;
  onChange: (opts: GifOptions) => void;
  maxDurationMs: number;
}

function msToMmSs(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function mmSsToMs(str: string): number | null {
  const parts = str.split(":");
  if (parts.length !== 2) return null;
  const m = parseInt(parts[0], 10);
  const s = parseInt(parts[1], 10);
  if (isNaN(m) || isNaN(s) || m < 0 || s < 0 || s >= 60) return null;
  return (m * 60 + s) * 1000;
}

export default function GifOptionsPanel({
  gifOptions,
  onChange,
  maxDurationMs,
}: GifOptionsPanelProps) {
  return (
    <div className="mt-3 space-y-2 rounded-md bg-surface-0 p-3">
      <div>
        <span className="mb-1 block text-xs uppercase tracking-wide text-fg-muted">GIF size</span>
        <div className="flex gap-1.5">
          {SIZE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange({ ...gifOptions, size_preset: o.value })}
              className={clsx(
                "rounded-md px-2.5 py-1 text-xs font-medium transition duration-fast ease-out",
                gifOptions.size_preset === o.value
                  ? "bg-accent text-accent-fg"
                  : "bg-surface-2 text-fg-secondary hover:bg-surface-3",
              )}
            >
              {o.label} ({o.px}px)
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="mb-1 block text-xs uppercase tracking-wide text-fg-muted">
          Trim (optional) — source: {msToMmSs(maxDurationMs)}
        </span>
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1 text-fg-secondary">
            Start
            <input
              type="text"
              placeholder="00:00"
              className="w-16 rounded-md bg-surface-2 px-2 py-1 text-fg tabular-nums transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
              defaultValue={
                gifOptions.trim_start_ms != null
                  ? msToMmSs(Number(gifOptions.trim_start_ms))
                  : ""
              }
              onBlur={(e) => {
                const ms = mmSsToMs(e.target.value);
                onChange({ ...gifOptions, trim_start_ms: ms != null ? BigInt(ms) : null });
              }}
            />
          </label>
          <label className="flex items-center gap-1 text-fg-secondary">
            End
            <input
              type="text"
              placeholder={msToMmSs(maxDurationMs)}
              className="w-16 rounded-md bg-surface-2 px-2 py-1 text-fg tabular-nums transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
              defaultValue={
                gifOptions.trim_end_ms != null
                  ? msToMmSs(Number(gifOptions.trim_end_ms))
                  : ""
              }
              onBlur={(e) => {
                const ms = mmSsToMs(e.target.value);
                onChange({ ...gifOptions, trim_end_ms: ms != null ? BigInt(ms) : null });
              }}
            />
          </label>
        </div>
      </div>
    </div>
  );
}
