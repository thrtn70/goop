import { useState } from "react";
import type { DebridProbeInfo, DirectFileInfo, FormatOption, UrlProbe } from "@/types";
import type { StartOptions } from "./startState";

/** `StartButton` awaits what this returns to know when the enqueue
 *  settled, so a call site has to forward its promise rather than drop
 *  it. TypeScript will not enforce that — under return-type bivariance a
 *  promise-returning function is assignable to a `void` slot and back —
 *  so the union states the requirement and the three call sites below
 *  honour it by returning `onStart(...)` directly. */
type StartHandler = (opts: StartOptions) => void | Promise<void>;

type Props = { probe: UrlProbe; onStart: StartHandler; busy?: boolean };

/**
 * The one control that enqueues, shared by all three card variants.
 *
 * Nothing in the queue dedupes an enqueue, and two jobs for the same URL
 * run the same output template with `--continue` against the same `.part`.
 * The button therefore owns the guard: disabled while the IPC call is in
 * flight, and disabled afterwards while it reports what happened, since
 * the absence of feedback is what prompted the second click.
 *
 * `resetKey` returns it to idle when what would be downloaded changes,
 * so picking a different format can still be started. It carries the
 * probe's URL as well as the selection: every freshly probed video opens
 * on the same default selection, so a selection-only key collides across
 * videos and hands the next one a button already reporting this one's
 * enqueue.
 */
function StartButton({
  label,
  onStart,
  resetKey = "",
  busy = false,
}: {
  label: string;
  onStart: () => void | Promise<void>;
  resetKey?: string;
  busy?: boolean;
}) {
  const [phase, setPhase] = useState<"idle" | "starting" | "started">("idle");
  const [startedKey, setStartedKey] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  // Derived, not an effect keyed on `resetKey`. Neither the format select
  // nor the audio-only checkbox is disabled mid-flight, so an effect would
  // reset a *starting* button the moment the user nudged either one —
  // re-arming Start while the first enqueue was still in the air, which is
  // the same duplicate this guard exists to prevent. Comparing against the
  // key that was actually enqueued only ever re-arms a settled button.
  const rearmed = phase === "started" && startedKey !== resetKey;
  // `busy` is the card-wide signal: an enqueue can also be started from
  // the hero's failure banner, which never touches this button's own
  // phase. Folding it in here rather than only into `disabled` is what
  // makes the click guard below refuse it too.
  const effective = busy ? "starting" : rearmed ? "idle" : phase;

  async function handleClick() {
    if (effective !== "idle") return;
    const key = resetKey;
    setPhase("starting");
    setAnnouncement("");
    try {
      await onStart();
      setStartedKey(key);
      setPhase("started");
      setAnnouncement("Added to queue");
    } catch {
      // Return the button so it can be retried, and say nothing: the hero
      // renders a `role="alert"` banner for a failed start, which both
      // announces the failure and carries the retry. Repeating the words
      // here would announce them twice and put the same string on two
      // elements, which is how a `findByText` for it becomes ambiguous.
      setPhase("idle");
      setAnnouncement("");
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={effective !== "idle"}
        className="btn-press ml-auto rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out hover:bg-accent-hover disabled:cursor-default disabled:bg-surface-2 disabled:text-fg-secondary disabled:hover:bg-surface-2"
        onClick={() => void handleClick()}
      >
        {effective === "idle" && label}
        {effective === "starting" && "Starting…"}
        {effective === "started" && "Added to queue"}
      </button>
      {/* JobStateAnnouncer deliberately skips a job's first-seen state, so
          without this the enqueue has no non-visual signal at all: a
          disabled control's label change is not reliably announced. */}
      <span role="status" aria-live="polite" className="sr-only">
        {rearmed ? "" : announcement}
      </span>
    </>
  );
}

export default function ProbeCard({ probe, onStart, busy }: Props) {
  if (probe.direct) {
    return <DirectCard info={probe.direct} url={probe.url} onStart={onStart} busy={busy} />;
  }
  if (probe.debrid) {
    return (
      <DebridCard
        title={probe.title}
        info={probe.debrid}
        url={probe.url}
        onStart={onStart}
        busy={busy}
      />
    );
  }
  return <MediaCard probe={probe} onStart={onStart} busy={busy} />;
}

function MediaCard({ probe, onStart, busy }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [audioOnly, setAudioOnly] = useState(false);
  const fmt = probe.formats.find((f) => f.format_id === selected) ?? null;
  return (
    <div className="rounded-lg bg-surface-1 p-4">
      <div className="flex gap-4">
        {probe.thumbnail_url && (
          <img src={probe.thumbnail_url} alt={`Thumbnail for ${probe.title}`} className="h-24 w-40 rounded-md object-cover" />
        )}
        <div className="flex-1">
          <h3 className="font-display text-lg font-semibold text-fg">{probe.title}</h3>
          {probe.uploader && <p className="mt-1 text-sm text-fg-secondary">{probe.uploader}</p>}
          {probe.duration_secs != null && (
            <p className="mt-1 text-xs tabular-nums text-fg-muted">{formatSecs(Number(probe.duration_secs))}</p>
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-fg-secondary">Format:</label>
        <select
          className="rounded-md bg-surface-2 px-2 py-1 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value || null)}
        >
          <option value="">Best (auto)</option>
          {/* Rendered whole and in the order the backend gave them, which
              is best-first. This list used to be capped at 20 entries,
              which cut from the wrong end and put 1080p and above out of
              reach entirely. */}
          {probe.formats.map((f) => (
            <option key={f.format_id} value={f.format_id}>
              {formatLabel(f)}
            </option>
          ))}
        </select>
        <label className="ml-2 flex items-center gap-2 text-sm text-fg-secondary">
          <input
            type="checkbox"
            checked={audioOnly}
            onChange={(e) => setAudioOnly(e.target.checked)}
            className="rounded accent-accent"
          />
          audio only
        </label>
        <StartButton
          label="Start"
          resetKey={`${probe.url}|${selected ?? ""}|${audioOnly}`}
          busy={busy}
          onStart={() => onStart({ format: fmt, audioOnly })}
        />
      </div>
    </div>
  );
}

function DirectCard({
  info,
  url,
  onStart,
  busy,
}: {
  info: DirectFileInfo;
  url: string;
  onStart: StartHandler;
  busy?: boolean;
}) {
  const meta = [
    "Direct download",
    info.content_type,
    info.size_bytes != null ? humanSize(info.size_bytes) : null,
  ]
    .filter((s): s is string => s != null)
    .join(" · ");

  return (
    <div className="rounded-lg bg-surface-1 p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-secondary">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" focusable="false">
            <path d="M14 3v5h5M14 3l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-lg font-semibold text-fg">{info.filename}</h3>
          <p className="mt-1 text-sm text-fg-secondary">{meta}</p>
          {!info.resumable && (
            <p className="mt-1 text-xs text-fg-muted">This server may not support resuming.</p>
          )}
        </div>
      </div>

      <div className="mt-4 flex">
        <StartButton
          label="Download"
          resetKey={url}
          busy={busy}
          onStart={() => onStart({ format: null, audioOnly: false })}
        />
      </div>
    </div>
  );
}

function DebridCard({
  title,
  info,
  url,
  onStart,
  busy,
}: {
  title: string;
  info: DebridProbeInfo;
  url: string;
  onStart: StartHandler;
  busy?: boolean;
}) {
  const meta = [info.magnet ? "Magnet" : null, "via TorBox"]
    .filter((s): s is string => s != null)
    .join(" · ");

  return (
    <div className="rounded-lg bg-surface-1 p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-secondary">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" focusable="false">
            <path d="M13 3 4 14h6l-1 7 9-11h-6l1-7z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-lg font-semibold text-fg">{title}</h3>
          <p className="mt-1 text-sm text-fg-secondary">{meta}</p>
          {info.magnet && (
            <p className="mt-1 text-xs text-fg-muted">
              TorBox fetches the torrent, then Goop downloads it — uncached torrents can take a
              while to become ready.
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 flex">
        <StartButton
          label="Download"
          resetKey={url}
          busy={busy}
          onStart={() => onStart({ format: null, audioOnly: false })}
        />
      </div>
    </div>
  );
}

function formatSecs(s: number): string {
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

function humanMB(b: number): string {
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * One picker entry, e.g. `mp4 1920x1080 (52.3 MB)` or `m4a — audio only`.
 *
 * The audio-only marker comes from the backend's `is_audio_only` rather
 * than from yt-dlp's `resolution` string: without it a stream with no
 * video reads exactly like a video one, which is how the flag came to be
 * computed, shipped, and never used.
 */
function formatLabel(f: FormatOption): string {
  const quality = f.is_audio_only ? "— audio only" : (f.resolution ?? "");
  const size = f.filesize != null ? `(${humanMB(Number(f.filesize))})` : "";
  return [f.ext, quality, size].filter(Boolean).join(" ");
}

// `size_bytes` is `u64` in Rust → typed `bigint` by ts-rs, but Tauri serializes
// it as a plain JSON number on the wire (same as duration_secs/filesize, which
// the rest of this file already passes through `Number(...)`). Accept both and
// normalize, so bigint arithmetic never runs against a runtime number.
function humanSize(bytes: number | bigint): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
  let v = Number(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(v).toString() : v.toFixed(1)} ${units[i]}`;
}
