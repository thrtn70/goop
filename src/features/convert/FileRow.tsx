import { useEffect, useState } from "react";
import type { GifOptions, MetadataPolicy, TargetFormat } from "@/types";
import { useProbe } from "@/hooks/useProbe";
import TargetPicker, { smartDefault } from "./TargetPicker";
import GifOptionsPanel from "./GifOptionsPanel";

interface RowOptionsState {
  target: TargetFormat;
  gifOptions: GifOptions | null;
  metadataPolicy: MetadataPolicy;
}

export interface FileRowOptions {
  target: TargetFormat;
  gifOptions: GifOptions | null;
  metadataPolicy: MetadataPolicy;
}

interface FileRowProps {
  path: string;
  index?: number;
  onOptionsChange: (path: string, opts: FileRowOptions) => void;
  onRemove: (path: string) => void;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function defaultGifOptions(): GifOptions {
  return { size_preset: "medium", trim_start_ms: null, trim_end_ms: null };
}

export default function FileRow({ path, index = 0, onOptionsChange, onRemove }: FileRowProps) {
  const { state, retry } = useProbe(path);
  const [opts, setOpts] = useState<RowOptionsState | null>(null);

  // Seed options once the probe lands; derive smart defaults from the probe.
  useEffect(() => {
    if (state.phase === "ready" && opts === null) {
      const target = smartDefault(state.probe);
      const seeded: RowOptionsState = {
        target,
        gifOptions: target === "gif" ? defaultGifOptions() : null,
        metadataPolicy: "preserve",
      };
      setOpts(seeded);
      onOptionsChange(path, seeded);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onOptionsChange is stable via parent useCallback; depending on it would re-seed on every parent render
  }, [state, path]);

  if (state.phase === "probing") {
    return (
      <div className="enter-stagger animate-pulse rounded-lg bg-surface-1 p-3" style={{ "--i": index } as React.CSSProperties}>
        <div className="h-4 w-48 rounded bg-surface-3" />
        <div className="mt-2 h-3 w-32 rounded bg-surface-2" />
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="enter-stagger rounded-lg bg-error-subtle p-3" style={{ "--i": index } as React.CSSProperties}>
        <div className="flex items-center justify-between">
          <span className="truncate text-sm font-medium text-error">{basename(path)}</span>
          <button type="button" onClick={() => onRemove(path)} className="btn-press shrink-0 text-xs text-fg-muted transition duration-fast ease-out hover:text-error">
            Remove
          </button>
        </div>
        <p className="mt-1 text-xs text-error/80">{state.message}</p>
        <button
          type="button"
          onClick={() => retry()}
          className="btn-press mt-2 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
        >
          Try again
        </button>
      </div>
    );
  }

  if (opts === null) {
    // Probe finished but effect hasn't seeded opts yet — render a skeleton for this frame.
    return (
      <div className="enter-stagger animate-pulse rounded-lg bg-surface-1 p-3" style={{ "--i": index } as React.CSSProperties}>
        <div className="h-4 w-48 rounded bg-surface-3" />
      </div>
    );
  }

  const p = state.probe;
  const { target, gifOptions, metadataPolicy } = opts;

  const update = (partial: Partial<RowOptionsState>) => {
    const next: RowOptionsState = {
      target: partial.target ?? target,
      gifOptions: partial.gifOptions !== undefined ? partial.gifOptions : gifOptions,
      metadataPolicy: partial.metadataPolicy ?? metadataPolicy,
    };
    setOpts(next);
    onOptionsChange(path, next);
  };

  const showGifOpts = target === "gif" && p.source_kind === "video";
  const showMetadataPolicy = p.source_kind === "image";

  const meta: string[] = [];
  if (Number(p.duration_ms) > 0) meta.push(formatDuration(Number(p.duration_ms)));
  if (p.width && p.height) meta.push(`${p.width}×${p.height}`);
  if (p.video_codec) meta.push(p.video_codec);
  if (p.audio_codec) meta.push(p.audio_codec);
  if (p.image_format) meta.push(p.image_format);
  if (Number(p.file_size) > 0) meta.push(formatSize(Number(p.file_size)));

  return (
    <div className="enter-stagger hover-lift rounded-lg bg-surface-1 p-3" style={{ "--i": index } as React.CSSProperties}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-fg">{basename(path)}</span>
        <button
          type="button"
          onClick={() => onRemove(path)}
          className="text-xs text-fg-muted transition duration-fast ease-out hover:text-error"
        >
          Remove
        </button>
      </div>
      <p className="mt-1 text-xs tabular-nums text-fg-muted">{meta.join(" · ")}</p>
      <div className="mt-2">
        <TargetPicker
          probe={p}
          selected={target}
          onChange={(t) =>
            update({
              target: t,
              gifOptions: t === "gif" ? (gifOptions ?? defaultGifOptions()) : null,
            })
          }
        />
      </div>
      {showGifOpts && gifOptions && (
        <GifOptionsPanel
          gifOptions={gifOptions}
          onChange={(o) => update({ gifOptions: o })}
          maxDurationMs={Number(p.duration_ms)}
        />
      )}
      {showMetadataPolicy && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-fg-muted">Metadata:</span>
          <button
            type="button"
            aria-pressed={metadataPolicy === "preserve"}
            onClick={() => update({ metadataPolicy: "preserve" })}
            className={`btn-press rounded-md px-2 py-1 transition duration-fast ease-out ${
              metadataPolicy === "preserve"
                ? "bg-accent text-accent-fg"
                : "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg"
            }`}
            title="Copy EXIF + ICC from source (JPEG↔JPEG and PNG↔PNG only)"
          >
            Preserve
          </button>
          <button
            type="button"
            aria-pressed={metadataPolicy === "strip_all"}
            onClick={() => update({ metadataPolicy: "strip_all" })}
            className={`btn-press rounded-md px-2 py-1 transition duration-fast ease-out ${
              metadataPolicy === "strip_all"
                ? "bg-accent text-accent-fg"
                : "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg"
            }`}
            title="Drop EXIF + ICC (smaller output, no GPS/camera info)"
          >
            Strip
          </button>
        </div>
      )}
    </div>
  );
}
