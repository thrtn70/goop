import type { ReactNode } from "react";
import WorkspaceFrame from "@/components/workspace/WorkspaceFrame";
import WorkspaceInspector from "@/components/workspace/WorkspaceInspector";
import { withWorkspaceDrafts } from "@/store/workspaceDrafts";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import type {
  DebridProbeInfo,
  DirectFileInfo,
  FormatOption,
  UrlProbe,
} from "@/types";
import {
  startPhaseFor,
  type StartOptions,
  type StartPhase,
  type StartState,
} from "./startState";

type Presentation = {
  workspace?: boolean;
  banner?: ReactNode;
  outputDir?: string;
};
type Props = Presentation & {
  probe: UrlProbe;
  start: StartState;
  onStart: (opts: StartOptions) => void;
};
function compose(
  presentation: Presentation,
  source: ReactNode,
  fields: ReactNode,
  actions: ReactNode,
) {
  if (!presentation.workspace)
    return (
      <div className="space-y-4">
        {source}
        {fields}
        {actions}
      </div>
    );
  return (
    <WorkspaceFrame
      title="Extract"
      description="Save a link to your computer."
      inspector={
        <WorkspaceInspector title="Download settings" actions={actions}>
          {fields ?? (
            <p className="text-sm text-fg-secondary">
              Ready to download this source.
            </p>
          )}
        </WorkspaceInspector>
      }
      outputSummary={
        <p className="break-all text-sm text-fg-secondary">
          Save to {presentation.outputDir}
        </p>
      }
    >
      <div className="space-y-4">
        {source}
        {presentation.banner}
      </div>
    </WorkspaceFrame>
  );
}

/**
 * The one control that enqueues, shared by all three card variants.
 *
 * It holds no state. An enqueue can be started from here or from the
 * hero's failure banner, and when the button owned a phase of its own it
 * could not see the other one — which is how the same URL twice ran the
 * same output template with `--continue` against the same `.part`. The
 * hero owns the fact; this renders it.
 */
/** Direct and debrid downloads take no options — the same value is used
 *  to look up the phase and to start, so the two cannot drift. */
const SINGLE_ACTION_OPTS: StartOptions = { format: null, audioOnly: false };

function StartButton({
  label,
  phase,
  unavailable = false,
  onStart,
}: {
  label: string;
  phase: StartPhase;
  unavailable?: boolean;
  onStart: () => void;
}) {
  return (
    <>
      <button
        type="button"
        // Not `phase === "starting"`: a settled button keeps reporting
        // what it did until the selection changes, and re-enabling it
        // there is the duplicate enqueue all over again. React declines to
        // deliver a click to a disabled button, so this is the guard, not
        // a hint about one.
        disabled={unavailable || phase !== "idle"}
        className="btn-press ml-auto rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out hover:bg-accent-hover disabled:cursor-default disabled:bg-surface-2 disabled:text-fg-secondary disabled:hover:bg-surface-2"
        onClick={onStart}
      >
        {phase === "idle" && label}
        {phase === "starting" && "Starting…"}
        {phase === "started" && "Added to queue"}
      </button>
      {/* JobStateAnnouncer deliberately skips a job's first-seen state, so
          without this the enqueue has no non-visual signal at all: a
          disabled control's label change is not reliably announced. It
          renders even when empty — a live region that is removed and
          re-added does not announce. A failed start is announced by the
          hero's alert banner instead, which also carries the retry. */}
      <span role="status" aria-live="polite" className="sr-only">
        {phase === "started" ? "Added to queue" : ""}
      </span>
    </>
  );
}

function ProbeCard({ probe, start, onStart, ...presentation }: Props) {
  if (probe.direct) {
    return (
      <DirectCard
        {...presentation}
        info={probe.direct}
        url={probe.url}
        start={start}
        onStart={onStart}
      />
    );
  }
  if (probe.debrid) {
    return (
      <DebridCard
        {...presentation}
        title={probe.title}
        info={probe.debrid}
        url={probe.url}
        start={start}
        onStart={onStart}
      />
    );
  }
  return (
    <MediaCard
      {...presentation}
      probe={probe}
      start={start}
      onStart={onStart}
    />
  );
}

function MediaCard({ probe, start, onStart, ...presentation }: Props) {
  const [selected, setSelected] = useWorkspaceDraftState<string | null>(
    "ProbeCard.selected",
    null,
  );
  const [audioOnly, setAudioOnly] = useWorkspaceDraftState(
    "ProbeCard.audioOnly",
    false,
  );
  const fmt = probe.formats.find((f) => f.format_id === selected) ?? null;
  // One object for both the phase and the call, so what the button reports
  // can never describe a different selection from the one it would send.
  const opts: StartOptions = { format: fmt, audioOnly };
  return compose(
    presentation,
    <div className="flex gap-4">
      {probe.thumbnail_url && (
        <img
          src={probe.thumbnail_url}
          alt={`Thumbnail for ${probe.title}`}
          className="h-24 w-40 rounded-md object-cover"
        />
      )}
      <div className="min-w-0 flex-1">
        <h3 className="break-words text-lg font-semibold text-fg">
          {probe.title}
        </h3>
        {probe.uploader && (
          <p className="mt-1 text-sm text-fg-secondary">{probe.uploader}</p>
        )}
        {probe.duration_secs != null && (
          <p className="mt-1 text-xs tabular-nums text-fg-muted">
            {formatSecs(Number(probe.duration_secs))}
          </p>
        )}
      </div>
    </div>,
    <div className="flex min-w-0 flex-col gap-4">
      {" "}
      <label className="text-sm text-fg-secondary">Format:</label>
      <select
        aria-label="Download format"
        className="w-full min-w-0 rounded-md bg-surface-2 px-2 py-1 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
        value={selected ?? ""}
        onChange={(e) => setSelected(e.target.value || null)}
      >
        <option value="">Best (auto)</option>
        {selected && !fmt && (
          <option value={selected}>
            Previous format unavailable — choose again
          </option>
        )}
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
    </div>,
    <StartButton
      label="Start"
      unavailable={selected !== null && fmt === null}
      phase={startPhaseFor(start, probe.url, opts)}
      onStart={() => onStart(opts)}
    />,
  );
}

function DirectCard({
  info,
  url,
  start,
  onStart,
  ...presentation
}: Presentation & {
  info: DirectFileInfo;
  url: string;
  start: StartState;
  onStart: (opts: StartOptions) => void;
}) {
  const meta = [
    "Direct download",
    info.content_type,
    info.size_bytes != null ? humanSize(info.size_bytes) : null,
  ]
    .filter((s): s is string => s != null)
    .join(" · ");

  return compose(
    presentation,
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-secondary">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M14 3v5h5M14 3l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-display text-lg font-semibold text-fg">
          {info.filename}
        </h3>
        <p className="mt-1 text-sm text-fg-secondary">{meta}</p>
        {!info.resumable && (
          <p className="mt-1 text-xs text-fg-muted">
            This server may not support resuming.
          </p>
        )}
      </div>
    </div>,
    null,
    <StartButton
      label="Download"
      phase={startPhaseFor(start, url, SINGLE_ACTION_OPTS)}
      onStart={() => onStart(SINGLE_ACTION_OPTS)}
    />,
  );
}

function DebridCard({
  title,
  info,
  url,
  start,
  onStart,
  ...presentation
}: Presentation & {
  title: string;
  info: DebridProbeInfo;
  url: string;
  start: StartState;
  onStart: (opts: StartOptions) => void;
}) {
  const meta = [info.magnet ? "Magnet" : null, "via TorBox"]
    .filter((s): s is string => s != null)
    .join(" · ");

  return compose(
    presentation,
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-secondary">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M13 3 4 14h6l-1 7 9-11h-6l1-7z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-display text-lg font-semibold text-fg">
          {title}
        </h3>
        <p className="mt-1 text-sm text-fg-secondary">{meta}</p>
        {info.magnet && (
          <p className="mt-1 text-xs text-fg-muted">
            TorBox fetches the torrent, then Goop downloads it — uncached
            torrents can take a while to become ready.
          </p>
        )}
      </div>
    </div>,
    null,
    <StartButton
      label="Download"
      phase={startPhaseFor(start, url, SINGLE_ACTION_OPTS)}
      onStart={() => onStart(SINGLE_ACTION_OPTS)}
    />,
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

export default withWorkspaceDrafts(ProbeCard, undefined, (props) => [
  "source",
  props.probe.url,
]);
