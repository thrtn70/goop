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
    <div className="mt-3 space-y-2 rounded border border-neutral-800 bg-neutral-950 p-3">
      <div>
        <span className="mb-1 block text-[10px] uppercase text-neutral-500">GIF size</span>
        <div className="flex gap-1.5">
          {SIZE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange({ ...gifOptions, size_preset: o.value })}
              className={clsx(
                "rounded px-2.5 py-1 text-xs font-medium transition",
                gifOptions.size_preset === o.value
                  ? "bg-sky-600 text-white"
                  : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700",
              )}
            >
              {o.label} ({o.px}px)
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="mb-1 block text-[10px] uppercase text-neutral-500">
          Trim (optional) — source: {msToMmSs(maxDurationMs)}
        </span>
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1 text-neutral-400">
            Start
            <input
              type="text"
              placeholder="00:00"
              className="w-16 rounded bg-neutral-800 px-2 py-1 text-neutral-200"
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
          <label className="flex items-center gap-1 text-neutral-400">
            End
            <input
              type="text"
              placeholder={msToMmSs(maxDurationMs)}
              className="w-16 rounded bg-neutral-800 px-2 py-1 text-neutral-200"
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
