import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import PresetSaveDialog from "@/features/presets/PresetSaveDialog";
import { subtitleForTarget } from "./FileRow";
import { useAppStore } from "@/store/appStore";
import type {
  GifOptions,
  MetadataPolicy,
  QualityPreset,
  ResolutionCap,
  SubtitleOptions,
  TargetFormat,
} from "@/types";

export interface FileEntry {
  optionsReady?: boolean;
  path: string;
  target: TargetFormat;
  sourceDir: string;
  gifOptions: GifOptions | null;
  metadataPolicy: MetadataPolicy;
  subtitle: SubtitleOptions | null;
  /** Set by an applied preset. `null` leaves the backend's own default in
   *  place — these are only ever populated from a preset the user picked. */
  qualityPreset: QualityPreset | null;
  resolutionCap: ResolutionCap | null;
}

interface ConvertActionBarProps {
  files: FileEntry[];
  disabled: boolean;
  onEnqueued: () => void;
  /** Optional: copies the first file's per-row settings to every other staged file. */
  onApplyToAll?: () => void;
}

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const last = normalized.lastIndexOf("/");
  return last > 0 ? normalized.slice(0, last) : ".";
}

function newBatchId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export default function ConvertActionBar({
  files,
  disabled,
  onEnqueued,
  onApplyToAll,
}: ConvertActionBarProps) {
  const [overrideDir, setOverrideDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const count = files.length;

  /** Warn about subtitles the chosen output format can't carry.
   *
   * A row clears its own subtitle when you change its format, but a preset
   * or "apply to all" sets `target` from outside the row, so the mismatch
   * can survive until submit. Reconciling silently would drop the file
   * with nothing on screen ever having said so. */
  function warnAboutDroppedSubtitles(entries: FileEntry[]) {
    const dropped = entries.filter((f) => f.subtitle && !subtitleForTarget(f.subtitle, f.target));
    if (dropped.length === 0) return;
    const formats = [...new Set(dropped.map((f) => f.target.toUpperCase()))].join(", ");
    enqueueToast({
      variant: "info",
      title:
        dropped.length === 1
          ? "Subtitle left out of the conversion"
          : `${dropped.length} subtitles left out of the conversion`,
      detail: `${formats} can't carry subtitles. Everything else was converted as set.`,
    });
  }

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
    warnAboutDroppedSubtitles(files);
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
          quality_preset: f.qualityPreset,
          resolution_cap: f.resolutionCap,
          gif_options: f.gifOptions,
          compress_mode: null,
          batch_id: null,
          metadata_policy: f.metadataPolicy,
          // Reconcile here, not just in the row: a preset or "apply to all"
          // can change `target` without the row's coercion ever running,
          // which would otherwise send a pairing the backend rejects.
          subtitle: subtitleForTarget(f.subtitle, f.target),
        });
      } else {
        // Tag every enqueue in this batch with a shared id so toast
        // grouping can collapse them into a single summary notification.
        const batchId = newBatchId();
        await Promise.all(
          files.map((f) =>
            api.convert.fromFile({
              input_path: f.path,
              output_path: overrideDir ?? dirname(f.path),
              target: f.target,
              quality_preset: f.qualityPreset,
              resolution_cap: f.resolutionCap,
              gif_options: f.gifOptions,
              compress_mode: null,
              batch_id: batchId,
              metadata_policy: f.metadataPolicy,
              subtitle: subtitleForTarget(f.subtitle, f.target),
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
      {count > 1 && onApplyToAll && (
        <button
          type="button"
          onClick={onApplyToAll}
          title="Copy the first file's settings to every other file"
          className="text-xs text-fg-secondary transition duration-fast ease-out hover:text-accent"
        >
          Apply to all
        </button>
      )}
      {count > 0 && (
        <button
          type="button"
          onClick={() => setSaveOpen(true)}
          className="text-xs text-fg-secondary transition duration-fast ease-out hover:text-accent"
        >
          Save as preset
        </button>
      )}
      {error && <span className="text-xs text-error">{error}</span>}
      <PresetSaveDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        snapshot={{
          target: files[0]?.target ?? "mp4",
          // The dialog documents these as the Convert-register fields to
          // pass, and now that a preset actually applies them, omitting
          // them here would save the fork with both cleared.
          quality_preset: files[0]?.qualityPreset ?? null,
          resolution_cap: files[0]?.resolutionCap ?? null,
        }}
      />
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
    srt: "srt",
    vtt: "vtt",
    png: "png",
    jpeg: "jpg",
    webp: "webp",
    bmp: "bmp",
    tiff: "tiff",
    avif: "avif",
    jpeg_xl: "jxl",
  };
  return map[target];
}

function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 2 ? `\u2026/${parts.slice(-2).join("/")}` : p;
}
