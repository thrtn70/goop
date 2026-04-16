import { useEffect, useState } from "react";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { GifOptions, ProbeResult, QualityPreset, ResolutionCap, TargetFormat } from "@/types";
import TargetPicker, { smartDefault } from "./TargetPicker";
import CompressionPresets from "./CompressionPresets";
import GifOptionsPanel from "./GifOptionsPanel";

const IMAGE_TARGETS: TargetFormat[] = ["png", "jpeg", "webp", "bmp"];

type FileState =
  | { phase: "probing" }
  | {
      phase: "ready";
      probe: ProbeResult;
      target: TargetFormat;
      qualityPreset: QualityPreset;
      resolutionCap: ResolutionCap;
      gifOptions: GifOptions | null;
    }
  | { phase: "error"; message: string };

export interface FileRowOptions {
  target: TargetFormat;
  qualityPreset: QualityPreset;
  resolutionCap: ResolutionCap;
  gifOptions: GifOptions | null;
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
  const [state, setState] = useState<FileState>({ phase: "probing" });

  const doProbe = async () => {
    setState({ phase: "probing" });
    try {
      const result = await api.convert.probe(path);
      const target = smartDefault(result);
      const opts: FileRowOptions = {
        target,
        qualityPreset: "original",
        resolutionCap: "original",
        gifOptions: target === "gif" ? defaultGifOptions() : null,
      };
      setState({ phase: "ready", probe: result, ...opts });
      onOptionsChange(path, opts);
    } catch (e) {
      setState({ phase: "error", message: formatError(e) });
    }
  };

  useEffect(() => {
    void doProbe();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doProbe depends on path via closure; including it causes infinite re-probe loops
  }, [path]);

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
          onClick={() => void doProbe()}
          className="btn-press mt-2 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
        >
          Try again
        </button>
      </div>
    );
  }

  const { probe: p, target, qualityPreset, resolutionCap, gifOptions } = state;

  const update = (partial: Partial<FileRowOptions>) => {
    const next = {
      target: partial.target ?? target,
      qualityPreset: partial.qualityPreset ?? qualityPreset,
      resolutionCap: partial.resolutionCap ?? resolutionCap,
      gifOptions: partial.gifOptions !== undefined ? partial.gifOptions : gifOptions,
    };
    setState({ ...state, ...next });
    onOptionsChange(path, next);
  };

  const isImageTarget = IMAGE_TARGETS.includes(target);
  const showCompression = !isImageTarget && p.source_kind !== "image";
  const showGifOpts = target === "gif" && p.source_kind === "video";

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
      <CompressionPresets
        qualityPreset={qualityPreset}
        resolutionCap={resolutionCap}
        onQualityChange={(q) => update({ qualityPreset: q })}
        onResolutionChange={(r) => update({ resolutionCap: r })}
        visible={showCompression}
      />
      {showGifOpts && gifOptions && (
        <GifOptionsPanel
          gifOptions={gifOptions}
          onChange={(o) => update({ gifOptions: o })}
          maxDurationMs={Number(p.duration_ms)}
        />
      )}
    </div>
  );
}
