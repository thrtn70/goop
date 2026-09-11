import { cloneVideoOptions } from "./videoOptions";
import {
  audioAvailability,
  audioOptionsForTarget,
  audioSourceFacts,
  cloneAudioOptions,
  isAudioTarget,
  type AudioAvailability,
  type AudioConvertOptions,
} from "./audioOptions";
import { WorkspaceDraftProvider, withWorkspaceDrafts } from "@/store/workspaceDrafts";
import type {
  GifOptions,
  ImageConvertOptions,
  VideoConvertOptions,
  MetadataPolicy,
  SubtitleOptions,
  TargetFormat,
  QualityPreset,
  ResolutionCap,
  ProbeResult,
  TrackConvertOptions,
  TrackSettingsCapabilities,
  VideoTrackSettingsCapabilities,
  TrackPresetPolicy,
} from "@/types";
import VideoOptionsPanel from "./VideoOptionsPanel";
import AudioOptionsPanel from "./AudioOptionsPanel";
import TargetPicker from "./TargetPicker";
import ImageOptionsPanel from "./ImageOptionsPanel";
import { cloneImageOptions, imageOptionsProblem } from "./imageOptions";
import GifOptionsPanel from "./GifOptionsPanel";
import SubtitleField, { subtitleSupport } from "./SubtitleField";
import AudioTrackPanel from "./AudioTrackPanel";
import VideoTrackPanel from "./VideoTrackPanel";
import { cloneVideoTrackPolicyDraft, completeVideoTrackOptions, defaultVideoTrackOptions, shouldOfferVideoTrackOptions, videoTrackPolicyForPreset, type VideoTrackPolicyDraft } from "./videoTrackOptions";
import MetadataPolicyControl from "@/features/metadata/MetadataPolicyControl";

interface RowOptionsState {
  target: TargetFormat;
  gifOptions: GifOptions | null;
  imageOptions?: ImageConvertOptions | null;
  videoOptions?: VideoConvertOptions | null;
  audioOptions?: AudioConvertOptions | null;
  audioAvailability?: AudioAvailability | null;
  trackOptions?: TrackConvertOptions | null;
  trackSettings?: TrackSettingsCapabilities | null;
  videoTrackSettings?: VideoTrackSettingsCapabilities | null;
  pendingTrackPolicy?: TrackPresetPolicy | null;
  videoTrackOptionsEnabled?: boolean;
  videoTrackPolicyDraft?: VideoTrackPolicyDraft | null;
  trackSourceUnavailableReason?: string | null;
  audioPlanError?: string | null;
  metadataPolicy: MetadataPolicy;
  subtitle: SubtitleOptions | null;
  qualityPreset?: QualityPreset | null;
  resolutionCap?: ResolutionCap | null;
}

export interface FileRowOptions {
  target: TargetFormat;
  gifOptions: GifOptions | null;
  imageOptions?: ImageConvertOptions | null;
  videoOptions?: VideoConvertOptions | null;
  audioOptions?: AudioConvertOptions | null;
  audioAvailability?: AudioAvailability | null;
  trackOptions?: TrackConvertOptions | null;
  trackSettings?: TrackSettingsCapabilities | null;
  videoTrackSettings?: VideoTrackSettingsCapabilities | null;
  pendingTrackPolicy?: TrackPresetPolicy | null;
  videoTrackOptionsEnabled?: boolean;
  videoTrackPolicyDraft?: VideoTrackPolicyDraft | null;
  trackSourceUnavailableReason?: string | null;
  audioPlanError?: string | null;
  metadataPolicy: MetadataPolicy;
  subtitle: SubtitleOptions | null;
  qualityPreset?: QualityPreset | null;
  resolutionCap?: ResolutionCap | null;
}

/** Return supported subtitle intent unchanged; unsupported modes need correction. */
export function subtitleForTarget(
  subtitle: SubtitleOptions | null,
  target: TargetFormat,
): SubtitleOptions | null {
  if (!subtitle) return null;
  const support = subtitleSupport(target);
  if (!support.soft && !support.burn) return null;
  if (subtitle.mode === "soft" && !support.soft)
    return null;
  if (subtitle.mode === "burn_in" && !support.burn)
    return null;
  return subtitle;
}

export function defaultGifOptions(): GifOptions {
  return { size_preset: "medium", trim_start_ms: null, trim_end_ms: null };
}

export function uprightVideoSize(
  probe: Pick<ProbeResult, "width" | "height" | "video_details">,
): { width: number; height: number } {
  let width = probe.width ?? 1920;
  let height = probe.height ?? 1080;
  const stream = probe.video_details?.streams.find(
    (candidate) => candidate.codec_type === "video" && !candidate.attached_pic,
  );
  const rotation = stream?.rotation_degrees ?? 0;
  if (((rotation % 180) + 180) % 180 === 90) {
    [width, height] = [height, width];
  }
  return { width, height };
}

export function ConvertSettingsPanel({
  path,
  options: opts,
  state,
  onOptionsChange,
  onDraftEdit,
  onReinspect,
  draftIdentity,
}: {
  path: string;
  options: FileRowOptions;
  state: Extract<import("@/hooks/useProbe").ProbeState, { phase: "ready" }>;
  onOptionsChange: (path: string, opts: FileRowOptions) => void;
  onDraftEdit?: () => void;
  onReinspect?: () => void;
  draftIdentity?: string;
}) {
  const p = state.probe;
  const { target, gifOptions, metadataPolicy, subtitle } = opts;

  const update = (partial: Partial<RowOptionsState>) => {
    const next: RowOptionsState = {
      target: partial.target ?? target,
      videoOptions: cloneVideoOptions(partial.videoOptions !== undefined ? partial.videoOptions : opts.videoOptions),
      audioOptions: cloneAudioOptions(partial.audioOptions !== undefined ? partial.audioOptions : opts.audioOptions),
      audioAvailability: opts.audioAvailability,
      trackOptions: partial.trackOptions !== undefined ? partial.trackOptions : opts.trackOptions,
      trackSettings: opts.trackSettings,
      videoTrackSettings: opts.videoTrackSettings,
      pendingTrackPolicy: partial.pendingTrackPolicy !== undefined ? partial.pendingTrackPolicy : opts.pendingTrackPolicy,
      videoTrackOptionsEnabled: partial.videoTrackOptionsEnabled ?? opts.videoTrackOptionsEnabled,
      videoTrackPolicyDraft: partial.videoTrackPolicyDraft !== undefined ? cloneVideoTrackPolicyDraft(partial.videoTrackPolicyDraft) : cloneVideoTrackPolicyDraft(opts.videoTrackPolicyDraft),
      trackSourceUnavailableReason: opts.trackSourceUnavailableReason,
      audioPlanError: opts.audioPlanError,
      imageOptions: cloneImageOptions(partial.imageOptions !== undefined ? partial.imageOptions : opts.imageOptions),
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

  const targetCapability = state.capabilities.targets.find(c => c.target === target);
  const videoCapability = targetCapability?.video_settings;
  const explicit = !!opts.videoOptions;
  const audioSettings = targetCapability?.audio_settings;
  const trackSettings = targetCapability?.track_settings;
  const audioCapability = opts.audioAvailability ?? audioAvailability(
    audioSettings,
    targetCapability?.available ?? false,
    targetCapability?.reason,
  );
  const audioSource = audioSourceFacts(
    p.audio_details,
    p.audio_codecs?.length ?? (p.has_audio ? 1 : 0),
    p.has_video || p.has_subtitles,
    opts.trackOptions?.kind === "audio" ? opts.trackOptions.stream_index : undefined,
  );
  const imageCapability = state.capabilities.targets.find(c => c.target === target)?.image_settings;
  const imageProblem = imageOptionsProblem(opts.imageOptions, imageCapability);
  const showGifOpts = target === "gif" && p.source_kind === "video";
  // These selectors configure video encoding. GIF has its own size control,
  // and AVI uses a fixed encoder quality rather than these preset levels.
  const showVideoQuality =
    !explicit && p.source_kind === "video" && ["mp4", "mkv", "webm", "mov"].includes(target);
  const showVideoResolution =
    !explicit && (showVideoQuality || (p.source_kind === "video" && ["mp4","mkv","mov","avi"].includes(target)));
  const ignoredQuality =
    !explicit && !showVideoQuality &&
    opts.qualityPreset != null &&
    opts.qualityPreset !== "original";
  const ignoredResolution =
    !explicit && !showVideoResolution &&
    opts.resolutionCap != null &&
    opts.resolutionCap !== "original";
  const metadataCapabilities = targetCapability?.image_metadata;
  const showMetadataPolicy = p.source_kind === "image";
  const subSupport = subtitleSupport(target);
  const showSubtitle =
    subtitle != null || (p.source_kind === "video" && (subSupport.soft || subSupport.burn));
  const sourceSize = uprightVideoSize(p);
  const showTrackSettings = isAudioTarget(target) && Boolean(
    opts.audioOptions
      || opts.trackOptions !== undefined
      || opts.trackSourceUnavailableReason
      || (trackSettings?.audio_choices.length ?? 0) > 1,
  );
  const videoTrackSettings = targetCapability?.video_track_settings ?? opts.videoTrackSettings;
  const videoTrackEnabled = opts.videoTrackOptionsEnabled === true || opts.trackOptions?.kind === "video" || opts.pendingTrackPolicy?.kind === "video" || Boolean(opts.videoTrackPolicyDraft);
  const videoTrackOptions = opts.trackOptions?.kind === "video"
    ? opts.trackOptions
    : opts.videoTrackPolicyDraft
      ? { kind: "video" as const, ...cloneVideoTrackPolicyDraft(opts.videoTrackPolicyDraft)! }
    : videoTrackSettings ? {
        ...defaultVideoTrackOptions(videoTrackSettings),
        ...(opts.pendingTrackPolicy?.kind === "video" ? {
          audio: opts.pendingTrackPolicy.audio.kind === "choose_per_file" ? { kind: "choose" as const, stream_indices: [] } : { kind: opts.pendingTrackPolicy.audio.kind },
          subtitles: opts.pendingTrackPolicy.subtitles.kind === "choose_per_file" ? { kind: "choose" as const, stream_indices: [] } : { kind: opts.pendingTrackPolicy.subtitles.kind },
        } : {}),
      } : null;
  const showVideoTrackSettings = shouldOfferVideoTrackOptions({ target, explicit, enabled: videoTrackEnabled,
    settings: videoTrackSettings, options: opts.trackOptions, pendingPolicy: opts.pendingTrackPolicy });

  return (
    <div className="space-y-4">
      <div className="mt-2">
        <TargetPicker
          probe={p}
          capabilities={state.capabilities}
          selected={target}
          onChange={(t) => {
            const nextImageCapability = state.capabilities.targets.find(c => c.target === t)?.image_settings;
            update({
              target: t,
              audioOptions: audioOptionsForTarget(opts.audioOptions, t),
              imageOptions: opts.imageOptions ?? (t !== target && nextImageCapability?.available
                ? { jpeg_quality: nextImageCapability.default_quality, resize: { kind: "original" } }
                : null),
              gifOptions:
                t === "gif" ? (gifOptions ?? defaultGifOptions()) : null,
              // Keep the picked file when the new target can't use it (the
              // control just hides) so flipping through formats doesn't
              // make the user re-pick it. The send path drops it.
              subtitle: subtitleForTarget(subtitle, t) ?? subtitle,
            });
          }}
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
      {(videoCapability || explicit) && <WorkspaceDraftProvider scope={draftIdentity ? [draftIdentity] : []}>
        <VideoOptionsPanel file={opts} capability={videoCapability} sourceSize={sourceSize} onChange={videoOptions => update({videoOptions})} onOriginalResolution={() => update({resolutionCap:"original"})} onReplaceLegacyResolution={videoOptions => update({resolutionCap:"original",videoOptions})} onDraftEdit={onDraftEdit}/>
      </WorkspaceDraftProvider>}
      {showVideoTrackSettings && videoTrackSettings && videoTrackOptions && (
        <VideoTrackPanel
          settings={videoTrackSettings}
          mode={opts.videoOptions?.kind === "copy" ? "copy" : "custom"}
          value={videoTrackOptions}
          onChange={(trackOptions) => {
            const draft = { source: trackOptions.source, audio: trackOptions.audio, subtitles: trackOptions.subtitles };
            const complete = completeVideoTrackOptions(draft);
            update(complete
              ? { trackOptions: complete, pendingTrackPolicy: null, videoTrackPolicyDraft: null }
              : { trackOptions: null, pendingTrackPolicy: videoTrackPolicyForPreset(trackOptions), videoTrackPolicyDraft: draft });
          }}
        />
      )}
      {showTrackSettings && (
        <AudioTrackPanel
          settings={trackSettings}
          audioDetails={p.audio_details}
          mode={opts.audioOptions?.kind ?? "automatic"}
          value={opts.trackOptions?.kind === "audio" ? opts.trackOptions : null}
          unavailableReason={opts.trackSourceUnavailableReason}
          planError={opts.audioPlanError}
          onChange={(trackOptions) => update({ trackOptions })}
          onReinspect={onReinspect}
        />
      )}
      {isAudioTarget(target) && (audioSettings || opts.audioOptions) && (
        <WorkspaceDraftProvider scope={draftIdentity ? [draftIdentity] : []}>
          <AudioOptionsPanel
            target={target}
            value={opts.audioOptions ?? null}
            availability={audioCapability}
            source={audioSource}
            onChange={(audioOptions) => update({ audioOptions })}
            onDraftEdit={onDraftEdit}
          />
        </WorkspaceDraftProvider>
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
      {imageCapability?.available && (
        <WorkspaceDraftProvider scope={draftIdentity ? [draftIdentity] : []}>
          <ImageOptionsPanel
            value={opts.imageOptions ?? null}
            capability={imageCapability}
            sourceSize={{ width: p.width ?? 0, height: p.height ?? 0 }}
            onDraftEdit={onDraftEdit}
            onChange={imageOptions => update({ imageOptions })}
          />
        </WorkspaceDraftProvider>
      )}
      {imageProblem && (
        <p role="alert" className="text-xs text-warning">
          {imageProblem}{" "}
          <button type="button" className="underline" onClick={() => update({ imageOptions: null })}>
            Clear image settings
          </button>
        </p>
      )}
      {opts.imageOptions && target === "jpeg" && metadataPolicy === "preserve" && p.image_format?.toLowerCase() === "jpeg" && (
        <p className="text-xs text-fg-muted">
          JPEG preservation removes the EXIF thumbnail reference; camera-specific embedded data is not rewritten.
        </p>
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
        <MetadataPolicyControl
          value={metadataPolicy}
          capabilities={metadataCapabilities}
          preserveMode={opts.imageOptions ? "channel_aware" : "rgb_reencode"}
          onChange={(next) => update({ metadataPolicy: next })}
          onDraftEdit={onDraftEdit}
        />
      )}
    </div>
  );
}

export default withWorkspaceDrafts(ConvertSettingsPanel, undefined, (props) => [
  "source",
  props.path,
]);
