import { useEffect, useState } from "react";
import type { CompressMode, ProbeResult } from "@/types";
import { useProbe } from "@/hooks/useProbe";
import CompressControls from "./CompressControls";

/**
 * Default compression mode for a given source file.
 *
 * - Video / audio / JPEG / WebP → Quality(75)
 * - PNG → LosslessReoptimize
 * - BMP → Quality(75) but the row will show a hint and the submit will no-op.
 */
function defaultMode(probe: ProbeResult): CompressMode {
  if (probe.source_kind === "image") {
    const fmt = (probe.image_format ?? "").toLowerCase();
    if (fmt === "png") return { kind: "lossless_reoptimize" };
  }
  return { kind: "quality", value: 75 };
}

export interface CompressRowOptions {
  mode: CompressMode;
}

interface CompressFileRowProps {
  path: string;
  index?: number;
  onOptionsChange: (path: string, opts: CompressRowOptions) => void;
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

export default function CompressFileRow({
  path,
  index = 0,
  onOptionsChange,
  onRemove,
}: CompressFileRowProps) {
  const { state, retry } = useProbe(path);
  const [mode, setMode] = useState<CompressMode | null>(null);

  useEffect(() => {
    if (state.phase === "ready" && mode === null) {
      const m = defaultMode(state.probe);
      setMode(m);
      onOptionsChange(path, { mode: m });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see FileRow comment
  }, [state, path]);

  if (state.phase === "probing") {
    return (
      <div
        className="enter-stagger animate-pulse rounded-lg bg-surface-1 p-3"
        style={{ "--i": index } as React.CSSProperties}
      >
        <div className="h-4 w-48 rounded bg-surface-3" />
        <div className="mt-2 h-3 w-32 rounded bg-surface-2" />
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div
        className="enter-stagger rounded-lg bg-error-subtle p-3"
        style={{ "--i": index } as React.CSSProperties}
      >
        <div className="flex items-center justify-between">
          <span className="truncate text-sm font-medium text-error">{basename(path)}</span>
          <button
            type="button"
            onClick={() => onRemove(path)}
            className="btn-press shrink-0 text-xs text-fg-muted transition duration-fast ease-out hover:text-error"
          >
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

  if (mode === null) {
    return (
      <div
        className="enter-stagger animate-pulse rounded-lg bg-surface-1 p-3"
        style={{ "--i": index } as React.CSSProperties}
      >
        <div className="h-4 w-48 rounded bg-surface-3" />
      </div>
    );
  }

  const p = state.probe;
  const updateMode = (next: CompressMode) => {
    setMode(next);
    onOptionsChange(path, { mode: next });
  };

  const meta: string[] = [];
  if (Number(p.duration_ms) > 0) meta.push(formatDuration(Number(p.duration_ms)));
  if (p.width && p.height) meta.push(`${p.width}×${p.height}`);
  if (p.video_codec) meta.push(p.video_codec);
  if (p.audio_codec) meta.push(p.audio_codec);
  if (p.image_format) meta.push(p.image_format);
  if (Number(p.file_size) > 0) meta.push(formatSize(Number(p.file_size)));

  return (
    <div
      className="enter-stagger hover-lift rounded-lg bg-surface-1 p-3"
      style={{ "--i": index } as React.CSSProperties}
    >
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
      <CompressControls probe={p} mode={mode} onChange={updateMode} />
    </div>
  );
}
