import {
  beginDestinationChoice,
  isCurrentDestinationChoice,
  tryBegin,
  setSubmissionPhase,
  finishSubmission,
  useWorkspaceSubmissions,
} from "@/store/workspaceSubmissions";
import type {
  EntryIdentity,
  SubmissionReceipt,
} from "@/features/workspace/entries";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, type IpcCompressMode } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import PresetSaveDialog from "@/features/presets/PresetSaveDialog";
import type { CompressMode, MetadataPolicy, TargetFormat } from "@/types";

export interface CompressFileEntry extends EntryIdentity {
  optionsReady?: boolean;
  path: string;
  /** Defaults to source format; an explicitly selected preset can choose another. */
  target: TargetFormat;
  sourceDir: string;
  mode: CompressMode;
  metadataPolicy?: MetadataPolicy;
}

interface CompressActionBarProps {
  files: CompressFileEntry[];
  disabled: boolean;
  onEnqueued: () => void;
  onSettled?: (success: SubmissionReceipt[]) => void;
  /** Optional: copies the first file's compression mode to every other staged file. */
  onApplyToAll?: () => void;
}

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const last = normalized.lastIndexOf("/");
  return last > 0 ? normalized.slice(0, last) : ".";
}

function normalizeCompressMode(
  mode: CompressMode | null,
): IpcCompressMode | null {
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

export default function CompressActionBar({
  files,
  disabled,
  onEnqueued,
  onSettled,
  onApplyToAll,
}: CompressActionBarProps) {
  const [overrideDir, setOverrideDir] = useWorkspaceDraftState<string | null>(
    "CompressActionBar.overrideDir",
    null,
  );
  const runtime = useWorkspaceSubmissions((s) => s.compress);
  const error = runtime.error;
  const busy = runtime.active !== null;
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const count = files.length;

  async function pickOverrideDir() {
    const generation = beginDestinationChoice("compress");
    setPickerError(null);
    try {
      const picked = await open({
        directory: true,
        title: "Choose output folder",
      });
      if (
        typeof picked === "string" &&
        isCurrentDestinationChoice("compress", generation)
      )
        setOverrideDir(picked);
    } catch (e) {
      if (isCurrentDestinationChoice("compress", generation))
        setPickerError(formatError(e));
    }
  }

  async function handleCompress() {
    if (disabled || count === 0) return;
    const token = tryBegin("compress");
    if (token === null) return;
    let failure: string | null = null;
    try {
      const snapshot = files.map((file) => ({
        ...file,
        mode: { ...file.mode },
      }));
      const outputFolder = overrideDir;
      let destination: string | null = null;
      if (snapshot.length === 1) {
        const f = snapshot[0];
        destination = await save({
          defaultPath: `${stemOf(f.path)}-compressed.${extFor(f.target)}`,
          title: "Save compressed file",
        });
        if (!destination) return;
      }
      setSubmissionPhase("compress", token, "enqueuing");
      const batchId = snapshot.length > 1 ? newBatchId() : null;
      const results = await Promise.allSettled(
        snapshot.map((f) => {
          const output = destination ?? outputFolder ?? dirname(f.path);
          return api.convert.fromFile({
            input_path: f.path,
            output_path: output,
            target: f.target,
            quality_preset: null,
            resolution_cap: null,
            gif_options: null,
            compress_mode: normalizeCompressMode(f.mode),
            batch_id: batchId,
            metadata_policy: f.metadataPolicy ?? "preserve",
            subtitle: null,
          });
        }),
      );
      const successful = snapshot.filter(
        (_, i) => results[i].status === "fulfilled",
      );
      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (successful.length > 0) {
        if (onSettled) onSettled(successful);
        else if (failures.length === 0) onEnqueued();
      }
      if (failures.length)
        failure = `${failures.length} file(s) could not be queued: ${formatError(failures[0].reason)}`;
    } catch (e) {
      failure = formatError(e);
    } finally {
      finishSubmission("compress", token, failure);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={disabled || busy || count === 0}
        onClick={() => void handleCompress()}
        className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out
          enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy
          ? "Enqueuing..."
          : `Compress ${count} file${count !== 1 ? "s" : ""}`}
      </button>
      {count > 1 && (
        <button
          type="button"
          onClick={() => void pickOverrideDir()}
          className="text-xs text-fg-secondary transition duration-fast ease-out hover:text-accent"
        >
          {overrideDir
            ? `\u2192 ${shortenPath(overrideDir)}`
            : "Change output folder..."}
        </button>
      )}
      {count > 1 && onApplyToAll && (
        <button
          type="button"
          onClick={onApplyToAll}
          title="Copy the first file's settings to every other file"
          className="text-xs text-fg-secondary transition duration-fast ease-out hover:text-accent"
        >
          Apply first to all
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
      {(error || pickerError) && (
        <span role="alert" className="text-xs text-error">
          {error || pickerError}
        </span>
      )}
      <PresetSaveDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        snapshot={{
          target: files[0]?.target ?? "mp4",
          compress_mode: files[0]?.mode ?? null,
          metadata_policy: files[0]?.metadataPolicy ?? null,
        }}
      />
    </div>
  );
}
