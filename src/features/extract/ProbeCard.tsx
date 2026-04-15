import { useState } from "react";
import type { UrlProbe, FormatOption } from "@/types";

type Props = { probe: UrlProbe; onStart: (format: FormatOption | null, audioOnly: boolean) => void };

export default function ProbeCard({ probe, onStart }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [audioOnly, setAudioOnly] = useState(false);
  const fmt = probe.formats.find((f) => f.format_id === selected) ?? null;
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex gap-4">
        {probe.thumbnail_url && (
          <img src={probe.thumbnail_url} alt="" className="h-24 w-40 rounded object-cover" />
        )}
        <div className="flex-1">
          <h3 className="text-lg font-semibold">{probe.title}</h3>
          {probe.uploader && <p className="text-sm text-neutral-400">{probe.uploader}</p>}
          {probe.duration_secs != null && (
            <p className="text-xs text-neutral-500">{formatSecs(Number(probe.duration_secs))}</p>
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-neutral-300">Format:</label>
        <select
          className="rounded bg-neutral-800 px-2 py-1 text-sm"
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
        <label className="ml-2 flex items-center gap-1 text-sm text-neutral-300">
          <input type="checkbox" checked={audioOnly} onChange={(e) => setAudioOnly(e.target.checked)} />
          audio only
        </label>
        <button
          className="ml-auto rounded bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500"
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
