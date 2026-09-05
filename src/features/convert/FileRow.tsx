import { withWorkspaceDrafts } from "@/store/workspaceDrafts";
import type {
  GifOptions,
  MetadataPolicy,
  SubtitleOptions,
  TargetFormat,
  QualityPreset,
  ResolutionCap,
} from "@/types";
import TargetPicker from "./TargetPicker";
import GifOptionsPanel from "./GifOptionsPanel";
import SubtitleField, { subtitleSupport } from "./SubtitleField";

interface RowOptionsState {
  target: TargetFormat;
  gifOptions: GifOptions | null;
  metadataPolicy: MetadataPolicy;
  subtitle: SubtitleOptions | null;
  qualityPreset?: QualityPreset | null;
  resolutionCap?: ResolutionCap | null;
}

export interface FileRowOptions {
  target: TargetFormat;
  gifOptions: GifOptions | null;
  metadataPolicy: MetadataPolicy;
  subtitle: SubtitleOptions | null;
  qualityPreset?: QualityPreset | null;
  resolutionCap?: ResolutionCap | null;
}

/** Reconcile a picked subtitle with a target format.
 *
 * Returns null when the target can't carry subtitles at all, and switches
 * mode when only the other one is available (AVI has no subtitle track but
 * can still be burned into). Exported so the send path can apply the same
 * rule — a target set from outside this row, by a preset or "apply to all",
 * never passes through here. */
export function subtitleForTarget(
  subtitle: SubtitleOptions | null,
  target: TargetFormat,
): SubtitleOptions | null {
  if (!subtitle) return null;
  const support = subtitleSupport(target);
  if (!support.soft && !support.burn) return null;
  if (subtitle.mode === "soft" && !support.soft)
    return { ...subtitle, mode: "burn_in" };
  if (subtitle.mode === "burn_in" && !support.burn)
    return { ...subtitle, mode: "soft" };
  return subtitle;
}

export function defaultGifOptions(): GifOptions {
  return { size_preset: "medium", trim_start_ms: null, trim_end_ms: null };
}

export function ConvertSettingsPanel({
  path,
  options: opts,
  state,
  onOptionsChange,
  onDraftEdit,
}: {
  path: string;
  options: FileRowOptions;
  state: Extract<import("@/hooks/useProbe").ProbeState, { phase: "ready" }>;
  onOptionsChange: (path: string, opts: FileRowOptions) => void;
  onDraftEdit?: () => void;
}) {
  const p = state.probe;
  const { target, gifOptions, metadataPolicy, subtitle } = opts;

  const update = (partial: Partial<RowOptionsState>) => {
    const next: RowOptionsState = {
      target: partial.target ?? target,
      gifOptions:
        partial.gifOptions !== undefined ? partial.gifOptions : gifOptions,
      metadataPolicy: partial.metadataPolicy ?? metadataPolicy,
      subtitle: partial.subtitle !== undefined ? partial.subtitle : subtitle,
      qualityPreset:
        partial.qualityPreset !== undefined
          ? partial.qualityPreset
          : opts.qualityPreset,
      resolutionCap:
        partial.resolutionCap !== undefined
          ? partial.resolutionCap
          : opts.resolutionCap,
    };
    onOptionsChange(path, next);
  };

  const showGifOpts = target === "gif" && p.source_kind === "video";
  // These selectors configure video encoding. GIF has its own size control,
  // and AVI uses a fixed encoder quality rather than these preset levels.
  const showVideoQuality =
    p.source_kind === "video" && ["mp4", "mkv", "webm", "mov"].includes(target);
  const showVideoResolution =
    showVideoQuality || (p.source_kind === "video" && target === "avi");
  const ignoredQuality =
    !showVideoQuality &&
    opts.qualityPreset != null &&
    opts.qualityPreset !== "original";
  const ignoredResolution =
    !showVideoResolution &&
    opts.resolutionCap != null &&
    opts.resolutionCap !== "original";
  const showMetadataPolicy = p.source_kind === "image";
  const subSupport = subtitleSupport(target);
  const showSubtitle =
    p.source_kind === "video" && (subSupport.soft || subSupport.burn);

  return (
    <div className="space-y-4">
      <div className="mt-2">
        <TargetPicker
          probe={p}
          capabilities={state.capabilities}
          selected={target}
          onChange={(t) =>
            update({
              target: t,
              gifOptions:
                t === "gif" ? (gifOptions ?? defaultGifOptions()) : null,
              // Keep the picked file when the new target can't use it (the
              // control just hides) so flipping through formats doesn't
              // make the user re-pick it. The send path drops it.
              subtitle: subtitleForTarget(subtitle, t) ?? subtitle,
            })
          }
        />
      </div>
      {state.capabilities &&
        !state.capabilities.targets.some(
          (c) => c.target === target && c.available,
        ) && (
          <p className="mt-2 text-xs text-warning" role="alert">
            Selected output {target.toUpperCase()} is unavailable for this file.
            Choose an available format above.
          </p>
        )}
      {(ignoredQuality || ignoredResolution) && (
        <p className="mt-2 text-xs text-warning" role="alert">
          Selected video settings do not apply to this output.
          {showGifOpts &&
            " Use GIF size below to set the image dimensions."}{" "}
          <button
            type="button"
            className="underline"
            onClick={() =>
              update({
                qualityPreset: ignoredQuality ? null : opts.qualityPreset,
                resolutionCap: ignoredResolution ? null : opts.resolutionCap,
              })
            }
          >
            Clear video settings
          </button>
        </p>
      )}
      {(showVideoQuality || showVideoResolution) && (
        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          {showVideoQuality && (
            <label>
              Quality{" "}
              <select
                aria-label="Video quality"
                className="rounded bg-surface-2 p-1"
                value={opts.qualityPreset ?? ""}
                onChange={(e) =>
                  update({
                    qualityPreset: (e.target.value ||
                      null) as QualityPreset | null,
                  })
                }
              >
                <option value="">Default</option>
                <option value="original">Original</option>
                <option value="fast">Fast</option>
                <option value="balanced">Balanced</option>
                <option value="small">Small</option>
              </select>
            </label>
          )}
          {showVideoResolution && (
            <label>
              Resolution{" "}
              <select
                aria-label="Video resolution"
                className="rounded bg-surface-2 p-1"
                value={opts.resolutionCap ?? ""}
                onChange={(e) =>
                  update({
                    resolutionCap: (e.target.value ||
                      null) as ResolutionCap | null,
                  })
                }
              >
                <option value="">Default</option>
                <option value="original">Original</option>
                <option value="r1080p">1080p</option>
                <option value="r720p">720p</option>
                <option value="r480p">480p</option>
              </select>
            </label>
          )}
        </div>
      )}
      {showSubtitle && (
        <SubtitleField
          subtitle={subtitle}
          onChange={(s) => update({ subtitle: s })}
          support={subSupport}
        />
      )}
      {showGifOpts && gifOptions && (
        <GifOptionsPanel
          gifOptions={gifOptions}
          onDraftEdit={onDraftEdit}
          onChange={(o) => update({ gifOptions: o })}
          maxDurationMs={Number(p.duration_ms)}
        />
      )}
      {showMetadataPolicy &&
        state.capabilities?.targets.find((c) => c.target === target)
          ?.metadata_warning && (
          <p className="mt-2 text-xs text-warning" role="status">
            {
              state.capabilities.targets.find((c) => c.target === target)
                ?.metadata_warning
            }
          </p>
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

export default withWorkspaceDrafts(ConvertSettingsPanel, undefined, (props) => [
  "source",
  props.path,
]);
