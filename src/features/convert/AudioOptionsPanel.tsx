import { useEffect, useId } from "react";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import type { TargetFormat } from "@/types";
import {
  audioBitratesForTarget,
  audioOptionsForTarget,
  audioOptionsProblem,
  cloneAudioOptions,
  defaultAudioOptions,
  type AudioAvailability,
  type AudioConvertOptions,
  type AudioSourceFacts,
} from "./audioOptions";

type Encode = Extract<AudioConvertOptions, { kind: "encode" }>;

export default function AudioOptionsPanel({
  target,
  value,
  availability,
  source,
  onChange,
  onDraftEdit,
}: {
  target: Extract<TargetFormat, "mp3" | "m4a" | "aac" | "wav" | "flac">;
  value: AudioConvertOptions | null;
  availability: AudioAvailability;
  source: AudioSourceFacts;
  onChange: (value: AudioConvertOptions | null) => void;
  onDraftEdit?: () => void;
}) {
  const id = useId();
  const [saved, setSaved] = useWorkspaceDraftState<Encode | null>(
    "AudioOptionsPanel.savedCustom",
    null,
  );
  const encode = value?.kind === "encode" ? value : null;
  const [bitrateDraft, setBitrateDraft] = useWorkspaceDraftState(
    "AudioOptionsPanel.bitrateDraft",
    () => String(encode?.bitrate?.kbps ?? availability.defaultBitrateKbps ?? 192),
  );
  const [appliedBitrate, setAppliedBitrate] = useWorkspaceDraftState(
    "AudioOptionsPanel.appliedBitrate",
    () => String(encode?.bitrate?.kbps ?? availability.defaultBitrateKbps ?? 192),
  );
  useEffect(() => {
    const numeric = encode?.bitrate?.kbps;
    if (numeric !== undefined && appliedBitrate !== String(numeric)) {
      setBitrateDraft(String(numeric));
      setAppliedBitrate(String(numeric));
    }
  }, [encode?.bitrate?.kbps, appliedBitrate, setAppliedBitrate, setBitrateDraft]);
  const oneTrack = source.audioStreamCount === 1;
  const bitrateChoices = availability.bitrateChoicesKbps ?? audioBitratesForTarget(target);
  const bitrateInvalid = encode != null && bitrateChoices.length > 0
    && (!/^\d+$/.test(bitrateDraft) || !bitrateChoices.includes(Number(bitrateDraft)));
  const className =
    "rounded-md bg-surface-2 px-2 py-1 text-fg focus:outline-none focus:ring-2 focus:ring-accent";

  function change(next: AudioConvertOptions | null) {
    if (next?.kind === "encode") setSaved(cloneAudioOptions(next) as Encode);
    else if (encode) setSaved(cloneAudioOptions(encode) as Encode);
    onChange(cloneAudioOptions(next));
  }

  function custom() {
    const next = audioOptionsForTarget(saved, target) ?? defaultAudioOptions(target, availability);
    if (next) change(next);
  }

  const problem = audioOptionsProblem({
    target,
    audioOptions: value,
    audioAvailability: availability,
    audioSource: source,
    audioBitrateDraft: encode ? bitrateDraft : undefined,
  });
  const problemAlreadyExplained = [
    availability.reason,
    availability.copyReason,
    availability.encodeReason,
  ].includes(problem);
  const sourceSummary = [
    source.sampleRateHz == null
      ? "sample rate not reported"
      : `${Number((source.sampleRateHz / 1_000).toFixed(1))} kHz`,
    source.channelCount == null
      ? "channel count not reported"
      : `${source.channelCount} ${source.channelCount === 1 ? "channel" : "channels"}`,
  ].join(" · ");

  return (
    <section aria-label="Audio settings" className="space-y-3 rounded-md bg-surface-0 p-3 text-xs">
      <label className="flex items-center justify-between gap-2">
        Processing
        <select
          aria-label="Audio processing"
          className={className}
          value={value?.kind ?? "automatic"}
          onChange={(event) => {
            if (event.target.value === "encode") custom();
            else change(event.target.value === "copy" ? { kind: "copy" } : null);
          }}
        >
          <option value="automatic">Automatic</option>
          <option
            value="copy"
            disabled={value?.kind !== "copy" && (!oneTrack || !availability.available || !availability.copyAvailable)}
          >
            Copy audio
          </option>
          <option
            value="encode"
            disabled={value?.kind !== "encode" && (!oneTrack || !availability.available || !availability.encodeAvailable)}
          >
            Custom encode
          </option>
        </select>
      </label>

      {!availability.available && (
        <p className="text-warning">{availability.reason ?? "Audio settings are unavailable for this output."}</p>
      )}
      {!availability.copyAvailable && (
        <p className="text-fg-muted">Copy audio: {availability.copyReason ?? "Unavailable for this source."}</p>
      )}
      {!availability.encodeAvailable && (
        <p className="text-fg-muted">Custom encode: {availability.encodeReason ?? "Unavailable for this source."}</p>
      )}
      {!oneTrack && (
        <p className="text-warning">
          Explicit audio settings need exactly one audio track. Track selection is not available yet.
        </p>
      )}
      {source.sampleRateHz == null && (
        <p className="text-fg-muted">
          The source sample rate was not reported. Choose 44.1 or 48 kHz for Custom encode.
        </p>
      )}
      {!source.channelLayoutReported && (
        <p className="text-fg-muted">
          The source channel layout was not reported. Preserve keeps the reported channel count and order.
        </p>
      )}
      {source.hasNonAudioStreams && (
        <p className="text-fg-muted">
          This audio output contains one chosen audio track; video, subtitles, and artwork are not included.
        </p>
      )}
      <p className="text-fg-muted">Source: {sourceSummary}</p>

      {value == null && (
        <p className="text-fg-secondary">
          Automatic keeps Goop&apos;s existing format defaults. Source compatibility decides whether Goop copies or encodes the audio.
        </p>
      )}

      {value?.kind === "copy" && (
        <p className="text-fg-secondary">
          Copies the admitted audio packets without encoding. Bitrate, channels, and sample rate cannot be changed.
        </p>
      )}

      {encode && (
        <>
          <p className="text-fg-secondary">
            Codec: {availability.targetCodec?.toUpperCase() ?? (target === "mp3" ? "MP3" : target === "m4a" || target === "aac" ? "AAC" : target.toUpperCase())} (set by the output format)
          </p>
          {bitrateChoices.length > 0 && (
            <label className="flex items-center justify-between gap-2">
              Bitrate
              <span className="flex items-center gap-1">
              <input
                aria-label="Audio bitrate"
                aria-invalid={bitrateInvalid}
                aria-describedby={bitrateInvalid ? `${id}-error` : undefined}
                className={className}
                inputMode="numeric"
                list={`audio-bitrates-${target}`}
                value={bitrateDraft}
                onChange={(event) => {
                  const raw = event.target.value;
                  onDraftEdit?.();
                  setBitrateDraft(raw);
                  if (/^\d+$/.test(raw) && bitrateChoices.includes(Number(raw))) {
                    setAppliedBitrate(raw);
                    change({ ...encode, bitrate: { kind: "target", kbps: Number(raw) } });
                  }
                }}
              />
              <span>kbps</span>
              <datalist id={`audio-bitrates-${target}`}>
                {bitrateChoices.map((kbps) => <option key={kbps} value={kbps} />)}
              </datalist>
              </span>
            </label>
          )}
          {bitrateChoices.length === 0 && (
            <p className="text-fg-muted">
              {target === "flac"
                ? "FLAC is lossless and does not use a bitrate target."
                : "WAV uses uncompressed PCM s16le and does not use a bitrate target."}
            </p>
          )}
          {bitrateChoices.length > 0 && (
            <p className="text-fg-muted">Bitrate is an encoder target, not an exact output measurement.</p>
          )}
          <label className="flex items-center justify-between gap-2">
            Channels
            <select
              aria-label="Audio channels"
              className={className}
              value={encode.channels.kind}
              onChange={(event) =>
                change({ ...encode, channels: { kind: event.target.value as Encode["channels"]["kind"] } })
              }
            >
              <option value="preserve">Preserve</option>
              <option value="mono">Mono</option>
              <option value="stereo">Stereo</option>
            </select>
          </label>
          {encode.channels.kind === "mono" && source.channelCount === 2 && (
            <p className="text-fg-muted">Stereo is mixed equally into mono. Opposite-phase material can cancel.</p>
          )}
          {encode.channels.kind === "stereo" && source.channelCount === 1 && (
            <p className="text-fg-muted">The mono channel is duplicated into left and right.</p>
          )}
          <label className="flex items-center justify-between gap-2">
            Sample rate
            <select
              aria-label="Audio sample rate"
              className={className}
              value={encode.sample_rate.kind === "exact" ? String(encode.sample_rate.hz) : "preserve"}
              onChange={(event) =>
                change({
                  ...encode,
                  sample_rate: event.target.value === "preserve"
                    ? { kind: "preserve" }
                    : { kind: "exact", hz: Number(event.target.value) },
                })
              }
            >
              <option
                value="preserve"
                disabled={encode.sample_rate.kind !== "preserve" && source.sampleRateHz !== 44_100 && source.sampleRateHz !== 48_000}
              >
                Preserve
              </option>
              <option value="44100">44.1 kHz</option>
              <option value="48000">48 kHz</option>
            </select>
          </label>
        </>
      )}

      {problem && !problemAlreadyExplained && <p id={`${id}-error`} role="alert" className="text-warning">{problem}</p>}
    </section>
  );
}
