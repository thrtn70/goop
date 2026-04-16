import { useState } from "react";
import type { UrlProbe, FormatOption } from "@/types";

type Props = { probe: UrlProbe; onStart: (format: FormatOption | null, audioOnly: boolean) => void };

export default function ProbeCard({ probe, onStart }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [audioOnly, setAudioOnly] = useState(false);
  const fmt = probe.formats.find((f) => f.format_id === selected) ?? null;
  return (
    <div className="rounded-lg bg-surface-1 p-4">
      <div className="flex gap-4">
        {probe.thumbnail_url && (
          <img src={probe.thumbnail_url} alt={`Thumbnail for ${probe.title}`} className="h-24 w-40 rounded-md object-cover" />
        )}
        <div className="flex-1">
          <h3 className="font-display text-lg font-semibold text-fg">{probe.title}</h3>
          {probe.uploader && <p className="mt-1 text-sm text-fg-secondary">{probe.uploader}</p>}
          {probe.duration_secs != null && (
            <p className="mt-1 text-xs tabular-nums text-fg-muted">{formatSecs(Number(probe.duration_secs))}</p>
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-fg-secondary">Format:</label>
        <select
          className="rounded-md bg-surface-2 px-2 py-1 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value || null)}
        >
          <option value="">Best (auto)</option>
          {probe.formats.slice(0, 20).map((f) => (
            <option key={f.format_id} value={f.format_id}>
              {f.ext}
              {f.resolution ? ` ${f.resolution}` : ""}
              {f.filesize != null ? ` (${humanMB(Number(f.filesize))})` : ""}
            </option>
          ))}
        </select>
        <label className="ml-2 flex items-center gap-2 text-sm text-fg-secondary">
          <input
            type="checkbox"
            checked={audioOnly}
            onChange={(e) => setAudioOnly(e.target.checked)}
            className="rounded accent-accent"
          />
          audio only
        </label>
        <button
          type="button"
          className="btn-press ml-auto rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
          onClick={() => onStart(fmt, audioOnly)}
        >
          Start
        </button>
      </div>
    </div>
  );
}

function formatSecs(s: number): string {
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

function humanMB(b: number): string {
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
