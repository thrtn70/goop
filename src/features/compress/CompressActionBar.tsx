import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, type IpcCompressMode } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { CompressMode, TargetFormat } from "@/types";

export interface CompressFileEntry {
  path: string;
  /** Target format = source format (Compress keeps the container). */
  target: TargetFormat;
  sourceDir: string;
  mode: CompressMode;
}

interface CompressActionBarProps {
  files: CompressFileEntry[];
  disabled: boolean;
  onEnqueued: () => void;
}

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const last = normalized.lastIndexOf("/");
  return last > 0 ? normalized.slice(0, last) : ".";
}

function normalizeCompressMode(mode: CompressMode | null): IpcCompressMode | null {
  if (mode === null) return null;
  if (mode.kind === "target_size_bytes") {
    return { kind: "target_size_bytes", value: Number(mode.value) };
  }
  return mode;
}

function newBatchId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function stemOf(p: string): string {
  const name = p.replace(/\\/g, "/").split("/").pop() ?? "output";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function extFor(target: TargetFormat): string {
  const map: Record<TargetFormat, string> = {
    mp4: "mp4",
    mkv: "mkv",
    webm: "webm",
    gif: "gif",
    avi: "avi",
    mov: "mov",
    mp3: "mp3",
    m4a: "m4a",
    opus: "opus",
    wav: "wav",
    flac: "flac",
    ogg: "ogg",
    aac: "aac",
    extract_audio_keep_codec: "audio",
    png: "png",
    jpeg: "jpg",
    webp: "webp",
    bmp: "bmp",
  };
  return map[target];
}

function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 2 ? `\u2026/${parts.slice(-2).join("/")}` : p;
}

export default function CompressActionBar({
  files,
  disabled,
  onEnqueued,
}: CompressActionBarProps) {
  const [overrideDir, setOverrideDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const count = files.length;

  async function pickOverrideDir() {
    const picked = await open({ directory: true, title: "Choose output folder" });
    if (typeof picked === "string") {
      setOverrideDir(picked);
    }
  }

  async function handleCompress() {
    if (count === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (count === 1) {
        const f = files[0];
        const dest = await save({
          defaultPath: `${stemOf(f.path)}-compressed.${extFor(f.target)}`,
          title: "Save compressed file",
        });
        if (!dest) {
          setBusy(false);
          return;
        }
        await api.convert.fromFile({
          input_path: f.path,
          output_path: dest,
          target: f.target,
          quality_preset: null,
          resolution_cap: null,
          gif_options: null,
          compress_mode: normalizeCompressMode(f.mode),
          batch_id: null,
        });
      } else {
        const batchId = newBatchId();
        await Promise.all(
          files.map((f) =>
            api.convert.fromFile({
              input_path: f.path,
              output_path: overrideDir ?? dirname(f.path),
              target: f.target,
              quality_preset: null,
              resolution_cap: null,
              gif_options: null,
              compress_mode: normalizeCompressMode(f.mode),
              batch_id: batchId,
            }),
          ),
        );
      }
      setOverrideDir(null);
      onEnqueued();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={disabled || busy || count === 0}
        onClick={() => void handleCompress()}
        className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out
          enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Enqueuing..." : `Compress ${count} file${count !== 1 ? "s" : ""}`}
      </button>
      {count > 1 && (
        <button
          type="button"
          onClick={() => void pickOverrideDir()}
          className="text-xs text-fg-secondary transition duration-fast ease-out hover:text-accent"
        >
          {overrideDir ? `\u2192 ${shortenPath(overrideDir)}` : "Change output folder..."}
        </button>
      )}
      {error && <span className="text-xs text-error">{error}</span>}
    </div>
  );
}
