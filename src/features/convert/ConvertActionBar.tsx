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
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import PresetSaveDialog from "@/features/presets/PresetSaveDialog";
import { subtitleForTarget } from "./FileRow";
import type {
  GifOptions,
  MetadataPolicy,
  QualityPreset,
  ResolutionCap,
  SubtitleOptions,
  TargetFormat,
} from "@/types";

export interface FileEntry extends EntryIdentity {
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
  onSettled?: (success: SubmissionReceipt[]) => void;
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
  onSettled,
  onApplyToAll,
}: ConvertActionBarProps) {
  const [overrideDir, setOverrideDir] = useWorkspaceDraftState<string | null>(
    "ConvertActionBar.overrideDir",
    null,
  );
  const runtime = useWorkspaceSubmissions((s) => s.convert);
  const error = runtime.error;
  const busy = runtime.active !== null;
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const count = files.length;

  async function pickOverrideDir() {
    const generation = beginDestinationChoice("convert");
    setPickerError(null);
    try {
      const picked = await open({
        directory: true,
        title: "Choose output folder",
      });
      if (
        typeof picked === "string" &&
        isCurrentDestinationChoice("convert", generation)
      )
        setOverrideDir(picked);
    } catch (e) {
      if (isCurrentDestinationChoice("convert", generation))
        setPickerError(formatError(e));
    }
  }

  async function handleConvert() {
    if (disabled || count === 0) return;
    const token = tryBegin("convert");
    if (token === null) return;
    let failure: string | null = null;
    try {
      const snapshot = files.map((file) => ({
        ...file,
        gifOptions: file.gifOptions ? { ...file.gifOptions } : null,
        subtitle: file.subtitle ? { ...file.subtitle } : null,
      }));
      const outputFolder = overrideDir;
      if (snapshot.some(f => f.subtitle && !subtitleForTarget(f.subtitle, f.target))) {
        throw new Error("The selected subtitle mode is unavailable for this output. Change the subtitle mode or remove the subtitle before starting.");
      }
      let destination: string | null = null;
      if (snapshot.length === 1) {
        const f = snapshot[0];
        destination = await save({
          defaultPath: `${stemOf(f.path)}.${extFor(f.target)}`,
          title: "Save converted file",
        });
        if (!destination) return;
      }
      setSubmissionPhase("convert", token, "enqueuing");
      const batchId = snapshot.length > 1 ? newBatchId() : null;
      const results = await Promise.allSettled(
        snapshot.map((f) => {
          const output = destination ?? outputFolder ?? dirname(f.path);
          return api.convert.fromFile({
            input_path: f.path,
            output_path: output,
            target: f.target,
            quality_preset: f.qualityPreset,
            resolution_cap: f.resolutionCap,
            gif_options: f.gifOptions,
            compress_mode: null,
            batch_id: batchId,
            metadata_policy: f.metadataPolicy,
            subtitle: f.subtitle,
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
      finishSubmission("convert", token, failure);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={disabled || busy || count === 0}
        onClick={() => void handleConvert()}
        className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out
          enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy
          ? "Enqueuing..."
          : `Convert ${count} file${count !== 1 ? "s" : ""}`}
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
          // The dialog documents these as the Convert-register fields to
          // pass, and now that a preset actually applies them, omitting
          // them here would save the fork with both cleared.
          metadata_policy: files[0]?.metadataPolicy ?? null,
          gif_options: files[0]?.gifOptions ?? null,
          subtitle: files[0]?.subtitle ?? null,
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
