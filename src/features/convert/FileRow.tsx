import { useEffect } from "react";
import type { GifOptions, MetadataPolicy, SubtitleOptions, TargetFormat, QualityPreset, ResolutionCap } from "@/types";
import { useProbe } from "@/hooks/useProbe";
import { useAppStore } from "@/store/appStore";
import TargetPicker, { smartDefault } from "./TargetPicker";
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
  if (subtitle.mode === "soft" && !support.soft) return { ...subtitle, mode: "burn_in" };
  if (subtitle.mode === "burn_in" && !support.burn) return { ...subtitle, mode: "soft" };
  return subtitle;
}

interface FileRowProps {
  path: string;
  index?: number;
  options: FileRowOptions | null;
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

export function defaultGifOptions(): GifOptions {
  return { size_preset: "medium", trim_start_ms: null, trim_end_ms: null };
}

export default function FileRow({ path, index = 0, onOptionsChange, onRemove, options }: FileRowProps) {
  const { state, retry } = useProbe(path);
  const opts = options;
  // Read the global default once at seed time so a later Settings
  // change doesn't unexpectedly mutate an active row's choice.
  const defaultPolicy: MetadataPolicy =
    useAppStore((s) => s.settings?.default_metadata_policy) ?? "preserve";

  // Seed options once the probe lands; derive smart defaults from the probe.
  useEffect(() => {
    if (state.phase === "ready" && opts === null) {
      const target = smartDefault(state.probe);
      const seeded: RowOptionsState = {
        target,
        gifOptions: target === "gif" ? defaultGifOptions() : null,
        metadataPolicy: defaultPolicy,
        subtitle: null,
      };
      onOptionsChange(path, seeded);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onOptionsChange is stable via parent useCallback; depending on it would re-seed on every parent render
  }, [state, path]);

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
          onClick={() => retry()}
          className="btn-press mt-2 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
        >
          Try again
        </button>
      </div>
    );
  }

  if (opts === null) {
    // Probe finished but effect hasn't seeded opts yet — render a skeleton for this frame.
    return (
      <div className="enter-stagger animate-pulse rounded-lg bg-surface-1 p-3" style={{ "--i": index } as React.CSSProperties}>
        <div className="h-4 w-48 rounded bg-surface-3" />
      </div>
    );
  }

  const p = state.probe;
  const { target, gifOptions, metadataPolicy, subtitle } = opts;

  const update = (partial: Partial<RowOptionsState>) => {
    const next: RowOptionsState = {
      target: partial.target ?? target,
      gifOptions: partial.gifOptions !== undefined ? partial.gifOptions : gifOptions,
      metadataPolicy: partial.metadataPolicy ?? metadataPolicy,
      subtitle: partial.subtitle !== undefined ? partial.subtitle : subtitle,
      qualityPreset: partial.qualityPreset !== undefined ? partial.qualityPreset : opts.qualityPreset,
      resolutionCap: partial.resolutionCap !== undefined ? partial.resolutionCap : opts.resolutionCap,
    };
    onOptionsChange(path, next);
  };

  const showGifOpts = target === "gif" && p.source_kind === "video";
  // These selectors configure video encoding. GIF has its own size control,
  // and AVI uses a fixed encoder quality rather than these preset levels.
  const showVideoQuality = p.source_kind === "video" && ["mp4", "mkv", "webm", "mov"].includes(target);
  const showVideoResolution = showVideoQuality || (p.source_kind === "video" && target === "avi");
  const ignoredQuality = !showVideoQuality && opts.qualityPreset != null && opts.qualityPreset !== "original";
  const ignoredResolution = !showVideoResolution && opts.resolutionCap != null && opts.resolutionCap !== "original";
  const showMetadataPolicy = p.source_kind === "image";
  const subSupport = subtitleSupport(target);
  const showSubtitle = p.source_kind === "video" && (subSupport.soft || subSupport.burn);

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
          capabilities={state.capabilities}
          selected={target}
          onChange={(t) =>
            update({
              target: t,
              gifOptions: t === "gif" ? (gifOptions ?? defaultGifOptions()) : null,
              // Keep the picked file when the new target can't use it (the
              // control just hides) so flipping through formats doesn't
              // make the user re-pick it. The send path drops it.
              subtitle: subtitleForTarget(subtitle, t) ?? subtitle,
            })
          }
        />
      </div>
      {state.capabilities && !state.capabilities.targets.some(c => c.target === target && c.available) && (
        <p className="mt-2 text-xs text-warning" role="alert">Selected output {target.toUpperCase()} is unavailable for this file. Choose an available format above.</p>
      )}
      {(ignoredQuality || ignoredResolution) && (
        <p className="mt-2 text-xs text-warning" role="alert">
          Selected video settings do not apply to this output.
          {showGifOpts && " Use GIF size below to set the image dimensions."}{" "}
          <button type="button" className="underline" onClick={() => update({
            qualityPreset: ignoredQuality ? null : opts.qualityPreset,
            resolutionCap: ignoredResolution ? null : opts.resolutionCap,
          })}>Clear video settings</button>
        </p>
      )}
      {(showVideoQuality || showVideoResolution) && (
        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          {showVideoQuality && <label>Quality <select aria-label="Video quality" className="rounded bg-surface-2 p-1" value={opts.qualityPreset ?? ""} onChange={e => update({ qualityPreset: (e.target.value || null) as QualityPreset | null })}>
            <option value="">Default</option><option value="original">Original</option><option value="fast">Fast</option><option value="balanced">Balanced</option><option value="small">Small</option>
          </select></label>}
          {showVideoResolution && <label>Resolution <select aria-label="Video resolution" className="rounded bg-surface-2 p-1" value={opts.resolutionCap ?? ""} onChange={e => update({ resolutionCap: (e.target.value || null) as ResolutionCap | null })}>
            <option value="">Default</option><option value="original">Original</option><option value="r1080p">1080p</option><option value="r720p">720p</option><option value="r480p">480p</option>
          </select></label>}
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
          onChange={(o) => update({ gifOptions: o })}
          maxDurationMs={Number(p.duration_ms)}
        />
      )}
      {showMetadataPolicy && state.capabilities?.targets.find(c => c.target === target)?.metadata_warning && (
        <p className="mt-2 text-xs text-warning" role="status">{state.capabilities.targets.find(c => c.target === target)?.metadata_warning}</p>
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
