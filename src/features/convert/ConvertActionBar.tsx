import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { GifOptions, QualityPreset, ResolutionCap, TargetFormat } from "@/types";

export interface FileEntry {
  path: string;
  target: TargetFormat;
  sourceDir: string;
  qualityPreset: QualityPreset;
  resolutionCap: ResolutionCap;
  gifOptions: GifOptions | null;
}

interface ConvertActionBarProps {
  files: FileEntry[];
  disabled: boolean;
  onEnqueued: () => void;
}

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const last = normalized.lastIndexOf("/");
  return last > 0 ? normalized.slice(0, last) : ".";
}

export default function ConvertActionBar({ files, disabled, onEnqueued }: ConvertActionBarProps) {
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

  async function handleConvert() {
    if (count === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (count === 1) {
        const f = files[0];
        const dest = await save({
          defaultPath: `${stemOf(f.path)}.${extFor(f.target)}`,
          title: "Save converted file",
        });
        if (!dest) {
          setBusy(false);
          return;
        }
        await api.convert.fromFile({
          input_path: f.path,
          output_path: dest,
          target: f.target,
          quality_preset: f.qualityPreset === "original" ? null : f.qualityPreset,
          resolution_cap: f.resolutionCap === "original" ? null : f.resolutionCap,
          gif_options: f.gifOptions,
        });
      } else {
        for (const f of files) {
          const outDir = overrideDir ?? dirname(f.path);
          await api.convert.fromFile({
            input_path: f.path,
            output_path: outDir,
            target: f.target,
            quality_preset: f.qualityPreset === "original" ? null : f.qualityPreset,
            resolution_cap: f.resolutionCap === "original" ? null : f.resolutionCap,
            gif_options: f.gifOptions,
          });
        }
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
        onClick={() => void handleConvert()}
        className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out
          enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Enqueuing..." : `Convert ${count} file${count !== 1 ? "s" : ""}`}
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
