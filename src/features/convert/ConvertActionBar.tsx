import { cloneVideoOptions, videoOptionsError, videoRequestOptions, type VideoDraftFile } from "./videoOptions";
import {
  audioOptionsProblem,
  audioRequestOptions,
  cloneAudioOptions,
  type AudioConvertOptions,
  type AudioDraftFile,
} from "./audioOptions";
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
import { cloneImageOptions } from "./imageOptions";
import { subtitleForTarget } from "./FileRow";
import {
  cloneTrackOptions,
  activeTrackRequestOptions,
  trackSelectionProblem,
  type TrackDraftFile,
} from "./trackOptions";
import { videoTrackOptionsProblem, videoTrackPolicyForPreset } from "./videoTrackOptions";
import type {
  GifOptions,
  ImageConvertOptions,
  ImageColorPolicy,
  MetadataPolicy,
  QualityPreset,
  ResolutionCap,
  SubtitleOptions,
  TargetFormat,
  TrackPresetPolicy,
} from "@/types";

export interface FileEntry extends EntryIdentity, VideoDraftFile, AudioDraftFile, TrackDraftFile {
  optionsReady?: boolean;
  path: string;
  target: TargetFormat;
  sourceDir: string;
  gifOptions: GifOptions | null;
  imageOptions?: ImageConvertOptions | null;
  audioOptions?: AudioConvertOptions | null;
  metadataPolicy: MetadataPolicy;
  imageColorPolicy?: ImageColorPolicy;
  subtitle: SubtitleOptions | null;
  /** Set by an applied preset. `null` leaves the backend's own default in
   *  place — these are only ever populated from a preset the user picked. */
  qualityPreset: QualityPreset | null;
  resolutionCap: ResolutionCap | null;
  audioPlanReady?: boolean;
}

interface ConvertActionBarProps {
  files: FileEntry[];
  /** Source currently shown in the inspector. Preset save snapshots this row. */
  presetSource?: FileEntry | null;
  /** Complete validation result for the selected row, including image drafts. */
  presetValidationError?: string | null;
  disabled: boolean;
  planningBlocked?: boolean;
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
  presetSource,
  presetValidationError,
  disabled,
  planningBlocked = false,
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
  const presetFile = presetSource ?? files[0];
  const videoError = files.map(videoOptionsError).find(Boolean);
  const audioError = files.map(audioOptionsProblem).find(Boolean);
  const trackError = files.map(trackSelectionProblem).find(Boolean);
  const videoTrackError = files.map(file => file.videoOptions && (file.videoTrackOptionsEnabled || file.trackOptions?.kind === "video" || file.pendingTrackPolicy?.kind === "video") ? videoTrackOptionsProblem({
    options: file.trackOptions,
    settings: file.videoTrackSettings,
    mode: file.videoOptions.kind === "copy" ? "copy" : "custom",
    unavailableReason: file.trackSourceUnavailableReason,
    pendingPolicy: file.pendingTrackPolicy,
  }) : null).find(Boolean);
  const missingAudioPlan = files.some((file) =>
    Boolean(file.audioOptions && (file.trackSettings || file.trackOptions !== undefined) && !file.audioPlanReady),
  );
  const blocked = disabled || Boolean(videoError) || Boolean(audioError) || Boolean(trackError) || Boolean(videoTrackError) || missingAudioPlan;
  const presetVideoError = presetFile ? videoOptionsError(presetFile) : null;
  const presetAudioError = presetFile ? audioOptionsProblem(presetFile) : null;
  const hasSelectedPresetContext = presetSource !== undefined;
  const presetError = hasSelectedPresetContext
    ? presetValidationError ?? presetAudioError ?? presetVideoError
    : audioError ?? videoError;
  const presetBlocked = hasSelectedPresetContext
    ? !presetFile || presetFile.optionsReady === false || Boolean(presetError)
    : blocked;

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
    if (blocked || planningBlocked || count === 0) return;
    const token = tryBegin("convert");
    if (token === null) return;
    let failure: string | null = null;
    try {
      const snapshot = files.map((file) => ({
        ...file,
        audioOptions: audioRequestOptions(file),
        trackOptions: activeTrackRequestOptions(file),
        videoOptions: videoRequestOptions(file),
        imageOptions: cloneImageOptions(file.imageOptions),
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
          const request = {
            input_path: f.path,
            output_path: output,
            target: f.target,
            quality_preset: f.videoOptions || f.audioOptions ? null : f.qualityPreset,
            audio_options: cloneAudioOptions(f.audioOptions),
            ...(f.trackOptions === null ? {} : { track_options: cloneTrackOptions(f.trackOptions) }),
            video_options: cloneVideoOptions(f.videoOptions),
            resolution_cap: f.resolutionCap,
            gif_options: f.gifOptions,
            image_options: cloneImageOptions(f.imageOptions),
            compress_mode: null,
            batch_id: batchId,
            metadata_policy: f.metadataPolicy,
            image_color_policy: f.imageColorPolicy ?? "preserve",
            subtitle: f.subtitle,
          };
          return api.convert.fromFile(request);
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
        disabled={blocked || planningBlocked || busy || count === 0}
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
          disabled={blocked}
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
          disabled={presetBlocked}
          onClick={() => setSaveOpen(true)}
          className="text-xs text-fg-secondary transition duration-fast ease-out hover:text-accent"
        >
          Save as preset
        </button>
      )}
      {(error || pickerError || audioError || videoError || trackError || videoTrackError) && (
        <span role="alert" className="text-xs text-error">
          {error || pickerError || audioError || videoError || trackError || videoTrackError}
        </span>
      )}
      <PresetSaveDialog
        validationError={presetError}
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        snapshot={{
          target: presetFile?.target ?? "mp4",
          // The dialog documents these as the Convert-register fields to
          // pass, and now that a preset actually applies them, omitting
          // them here would save the fork with both cleared.
          metadata_policy: presetFile?.metadataPolicy ?? null,
          image_color_policy: presetFile?.imageColorPolicy ?? "preserve",
          gif_options: presetFile?.gifOptions ? { ...presetFile.gifOptions } : null,
          image_options: cloneImageOptions(presetFile?.imageOptions),
          audio_options: cloneAudioOptions(presetFile?.audioOptions),
          track_policy: presetFile?.videoOptions
            ? (presetFile.pendingTrackPolicy?.kind === "video"
              ? structuredClone(presetFile.pendingTrackPolicy)
              : videoTrackPolicyForPreset(presetFile.trackOptions))
            : presetFile?.audioOptions && presetFile.trackSettings
              ? ({ kind: "audio", selection: { kind: "choose_per_file" } } satisfies TrackPresetPolicy)
              : null,
          subtitle: presetFile?.subtitle ? { ...presetFile.subtitle } : null,
          video_options: presetFile && !presetVideoError ? videoRequestOptions(presetFile) : null,
          quality_preset: presetFile?.videoOptions || presetFile?.audioOptions ? null : presetFile?.qualityPreset ?? null,
          resolution_cap: presetFile?.resolutionCap ?? null,
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
