import type {
  AudioProbeDetails,
  TrackConvertOptions,
  TrackSettingsCapabilities,
} from "@/types";
import { useId } from "react";
import {
  cloneTrackSource,
  resolvedTrackOptions,
  selectedTrackChoice,
  trackFactText,
} from "./trackOptions";

type Mode = "automatic" | "copy" | "encode";
type AudioTrackOptions = Extract<TrackConvertOptions, { kind: "audio" }>;

export default function AudioTrackPanel({
  settings,
  audioDetails,
  mode,
  value,
  unavailableReason,
  planError,
  onChange,
  onReinspect,
}: {
  settings?: TrackSettingsCapabilities | null;
  audioDetails?: AudioProbeDetails | null;
  mode: Mode;
  value?: AudioTrackOptions | null;
  unavailableReason?: string | null;
  planError?: string | null;
  onChange: (value: AudioTrackOptions) => void;
  onReinspect?: () => void;
}) {
  const groupName = useId();
  const enabled = mode !== "automatic";
  const effective = resolvedTrackOptions(value, settings);
  const selectedChoice = selectedTrackChoice(settings, effective);
  const selected = enabled ? selectedChoice?.track.index : undefined;

  return (
    <section aria-label="Audio track" className="space-y-2 rounded-md bg-surface-0 p-3 text-xs">
      <div>
        <h3 className="font-medium text-fg">Audio track</h3>
        {!enabled && (
          <p className="mt-1 text-fg-muted">
            Choose Copy audio or Custom encode to select a track.
          </p>
        )}
        {unavailableReason && !settings && (
          <p role="alert" className="mt-1 text-warning">{unavailableReason}</p>
        )}
        {enabled && value && settings && !selectedChoice && (
          <p role="alert" className="mt-1 text-warning">
            The source changed after track selection. Choose an audio track again.
          </p>
        )}
        {planError && (
          <div className="mt-1 text-warning">
            <p role="alert">{planError}</p>
            {onReinspect && (
              <button type="button" className="mt-1 text-accent underline" onClick={onReinspect}>
                Reinspect source
              </button>
            )}
          </div>
        )}
      </div>
      {settings && (
        <fieldset className="space-y-2">
          <legend className="sr-only">Choose audio track</legend>
          {settings.audio_choices.map((choice) => {
            const track = choice.track;
            const availability = mode === "copy" ? choice.copy : choice.encode;
            const disabled = !enabled || !availability.available;
            const channels = audioDetails?.streams.find((stream) => stream.index === track.index)?.channels;
            const channelText = channels?.kind === "exact"
              ? `${channels.value} ${channels.value === 1 ? "channel" : "channels"}`
              : channels?.kind === "malformed"
                ? "Channels malformed"
                : "Channels not reported";
            const optionId = `${groupName}-${track.index}`;
            return (
              <div key={track.index} className={`rounded-md border p-2 ${selected === track.index ? "border-accent bg-surface-1" : "border-subtle"} ${disabled ? "opacity-70" : ""}`}>
                <span className="flex items-start gap-2">
                  <input
                    id={optionId}
                    type="radio"
                    name={groupName}
                    checked={selected === track.index}
                    disabled={disabled}
                    onChange={() => onChange({
                      kind: "audio",
                      source: cloneTrackSource(settings.source),
                      stream_index: track.index,
                    })}
                  />
                  <span className="min-w-0 flex-1">
                    <label htmlFor={optionId} className={disabled ? undefined : "cursor-pointer"}>
                      <span className="flex flex-wrap items-center gap-1 font-medium text-fg">
                        <span>{trackFactText(track.language, "language")}</span>
                        <span aria-hidden="true">·</span>
                        <span>{trackFactText(track.title, "title")}</span>
                        {track.disposition.default === true && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-fg-secondary">Default</span>}
                        {track.disposition.forced === true && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-fg-secondary">Forced</span>}
                      </span>
                      <span className="mt-0.5 flex flex-wrap gap-x-2 text-fg-muted">
                        <span>{trackFactText(track.codec_name, "codec")}</span>
                        <span>{channelText}</span>
                      </span>
                      {enabled && !availability.available && (
                        <span className="mt-1 block text-warning">
                          {availability.reason ?? `${mode === "copy" ? "Copy audio" : "Custom encode"} is unavailable for this track.`}
                        </span>
                      )}
                    </label>
                    <details className="mt-1 text-fg-muted">
                      <summary className="cursor-pointer">Technical details</summary>
                      <span className="mt-1 block">
                        Stream {track.index} · {trackFactText(track.container_stream_id, "id")}
                        {track.disposition.default === null ? " · Default status not reported" : ""}
                        {track.disposition.forced === null ? " · Forced status not reported" : ""}
                      </span>
                    </details>
                  </span>
                </span>
              </div>
            );
          })}
        </fieldset>
      )}
    </section>
  );
}
