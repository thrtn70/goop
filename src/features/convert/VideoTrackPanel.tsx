import type { TrackConvertOptions, TrackIdentity, TrackStreamPolicy, VideoTrackSettingsCapabilities } from "@/types";
import { trackFactText } from "./trackOptions";
import { withVideoTrackPolicy, type VideoTrackFamily, type VideoTrackMode } from "./videoTrackOptions";
import { useId } from "react";

type VideoOptions = Extract<TrackConvertOptions, { kind: "video" }>;

function identityLabel(track: TrackIdentity): string {
  const facts = [
    `Stream ${track.index}`,
    trackFactText(track.language, "language"),
    trackFactText(track.title, "title"),
    trackFactText(track.codec_name, "codec"),
  ];
  if (track.disposition.default) facts.push("Default");
  if (track.disposition.forced) facts.push("Forced");
  return facts.join(" · ");
}

function Family({ family, label, mode, settings, value, groupName, onChange }: {
  family: VideoTrackFamily;
  label: string;
  mode: VideoTrackMode;
  settings: VideoTrackSettingsCapabilities;
  value: VideoOptions;
  groupName: string;
  onChange: (value: VideoOptions) => void;
}) {
  const choices = family === "audio" ? settings.audio_tracks : settings.subtitle_tracks;
  const availability = (family === "audio" ? settings.audio_policy : settings.subtitle_policy)[mode];
  const policy = value[family];
  const choose = (next: TrackStreamPolicy) => onChange(withVideoTrackPolicy(value, family, next));
  const selected = policy.kind === "choose" ? policy.stream_indices : [];
  return <fieldset className="rounded-lg border border-subtle bg-surface-1 p-3">
    <legend className="px-1 text-xs font-medium text-fg">{label}</legend>
    <div className="flex flex-wrap gap-3 text-xs text-fg-secondary">
      {(["keep_all", "choose", "none"] as const).map(kind => {
        const title = kind === "keep_all" ? "Keep all" : kind === "choose" ? "Choose" : "None";
        const state = availability[kind];
        return <label key={kind} title={state.reason ?? undefined} className={state.available ? "" : "opacity-50"}>
          <input type="radio" className="mr-1" name={`${groupName}-${family}`} aria-label={`${title} ${label.toLowerCase()}`}
            checked={policy.kind === kind} disabled={!state.available}
            onChange={() => choose(kind === "choose" ? { kind, stream_indices: choices.filter(choice => choice[mode].available).map(choice => choice.track.index) } : { kind })} />
          {title}
          {!state.available && state.reason && <span className="ml-1 text-warning">— {state.reason}</span>}
        </label>;
      })}
    </div>
    {policy.kind === "choose" && <div className="mt-2 space-y-1">
      {choices.map(choice => {
        const available = choice[mode];
        const checked = selected.includes(choice.track.index);
        return <label key={choice.track.index} title={available.reason ?? undefined} className={`block text-xs ${available.available ? "text-fg-secondary" : "text-warning"}`}>
          <input type="checkbox" className="mr-2" checked={checked} disabled={(!available.available && !checked) || (checked && selected.length === 1)}
            onChange={event => choose({ kind: "choose", stream_indices: choices.filter(candidate => candidate.track.index === choice.track.index ? event.target.checked : selected.includes(candidate.track.index)).map(candidate => candidate.track.index) })} />
          {identityLabel(choice.track)}
          {!available.available && available.reason && <span> — {available.reason}</span>}
        </label>;
      })}
    </div>}
  </fieldset>;
}

export default function VideoTrackPanel({ settings, mode, value, onChange }: {
  settings: VideoTrackSettingsCapabilities;
  mode: VideoTrackMode;
  value: VideoOptions;
  onChange: (value: VideoOptions) => void;
}) {
  const groupName = useId();
  return <section aria-label="Video track options" className="space-y-2">
    <div>
      <h3 className="text-sm font-medium text-fg">Audio and subtitles</h3>
      <p className="mt-1 text-xs text-fg-secondary">Keep every embedded stream, choose streams from this source, or omit that family.</p>
    </div>
    <Family family="audio" label="Audio streams" mode={mode} settings={settings} value={value} groupName={groupName} onChange={onChange} />
    <Family family="subtitles" label="Subtitle streams" mode={mode} settings={settings} value={value} groupName={groupName} onChange={onChange} />
  </section>;
}
