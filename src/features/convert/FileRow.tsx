import { useEffect, useState } from "react";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { ProbeResult, TargetFormat } from "@/types";
import TargetPicker, { smartDefault } from "./TargetPicker";

type FileState =
  | { phase: "probing" }
  | { phase: "ready"; probe: ProbeResult; target: TargetFormat }
  | { phase: "error"; message: string };

interface FileRowProps {
  path: string;
  onTargetChange: (path: string, target: TargetFormat) => void;
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

export default function FileRow({ path, onTargetChange, onRemove }: FileRowProps) {
  const [state, setState] = useState<FileState>({ phase: "probing" });

  const probe = async () => {
    setState({ phase: "probing" });
    try {
      const result = await api.convert.probe(path);
      const target = smartDefault(result);
      setState({ phase: "ready", probe: result, target });
      onTargetChange(path, target);
    } catch (e) {
      setState({ phase: "error", message: formatError(e) });
    }
  };

  useEffect(() => {
    void probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  if (state.phase === "probing") {
    return (
      <div className="animate-pulse rounded border border-neutral-800 bg-neutral-900 p-3">
        <div className="h-4 w-48 rounded bg-neutral-800" />
        <div className="mt-2 h-3 w-32 rounded bg-neutral-800" />
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="rounded border border-red-800 bg-red-950 p-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="truncate font-medium text-red-300">{basename(path)}</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => void probe()} className="text-xs text-sky-400 hover:text-sky-200">
              Retry
            </button>
            <button type="button" onClick={() => onRemove(path)} className="text-xs text-red-400 hover:text-red-200">
              Remove
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-red-400">{state.message}</p>
      </div>
    );
  }

  const { probe: p, target } = state;
  const meta: string[] = [];
  if (Number(p.duration_ms) > 0) meta.push(formatDuration(Number(p.duration_ms)));
  if (p.width && p.height) meta.push(`${p.width}×${p.height}`);
  if (p.video_codec) meta.push(p.video_codec);
  if (p.audio_codec) meta.push(p.audio_codec);
  if (Number(p.file_size) > 0) meta.push(formatSize(Number(p.file_size)));

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-neutral-200">{basename(path)}</span>
        <button type="button" onClick={() => onRemove(path)} className="text-xs text-neutral-500 hover:text-red-400">
          Remove
        </button>
      </div>
      <p className="mt-1 text-xs text-neutral-500">{meta.join(" · ")}</p>
      <div className="mt-2">
        <TargetPicker
          probe={p}
          selected={target}
          onChange={(t) => {
            setState({ ...state, target: t });
            onTargetChange(path, t);
          }}
        />
      </div>
    </div>
  );
}
