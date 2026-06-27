import { useState } from "react";
import type { DirectFileInfo, FormatOption, UrlProbe } from "@/types";

export interface StartOptions {
  format: FormatOption | null;
  audioOnly: boolean;
}

type Props = { probe: UrlProbe; onStart: (opts: StartOptions) => void };

export default function ProbeCard({ probe, onStart }: Props) {
  if (probe.direct) {
    return <DirectCard info={probe.direct} onStart={onStart} />;
  }
  return <MediaCard probe={probe} onStart={onStart} />;
}

function MediaCard({ probe, onStart }: Props) {
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
          onClick={() => onStart({ format: fmt, audioOnly })}
        >
          Start
        </button>
      </div>
    </div>
  );
}

function DirectCard({ info, onStart }: { info: DirectFileInfo; onStart: (opts: StartOptions) => void }) {
  const meta = [
    "Direct download",
    info.content_type,
    info.size_bytes != null ? humanSize(info.size_bytes) : null,
  ]
    .filter((s): s is string => s != null)
    .join(" · ");

  return (
    <div className="rounded-lg bg-surface-1 p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-secondary">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" focusable="false">
            <path d="M14 3v5h5M14 3l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-lg font-semibold text-fg">{info.filename}</h3>
          <p className="mt-1 text-sm text-fg-secondary">{meta}</p>
          {!info.resumable && (
            <p className="mt-1 text-xs text-fg-muted">This server may not support resuming.</p>
          )}
        </div>
      </div>

      <div className="mt-4 flex">
        <button
          type="button"
          className="btn-press ml-auto rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
          onClick={() => onStart({ format: null, audioOnly: false })}
        >
          Download
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

// `size_bytes` is `u64` in Rust → typed `bigint` by ts-rs, but Tauri serializes
// it as a plain JSON number on the wire (same as duration_secs/filesize, which
// the rest of this file already passes through `Number(...)`). Accept both and
// normalize, so bigint arithmetic never runs against a runtime number.
function humanSize(bytes: number | bigint): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
  let v = Number(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(v).toString() : v.toFixed(1)} ${units[i]}`;
}
