import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ChevronDown, ChevronUp, Maximize2 } from "lucide-react";
import type { ProbeState } from "@/hooks/useProbe";
import {
  UNAVAILABLE_MESSAGES,
  planPreview,
  type PlayablePlan,
  type PreviewPlan,
  type PreviewUnavailableReason,
} from "@/features/player/previewPlan";
import { releaseMedia } from "@/features/player/releaseMedia";

export type SourcePlayerProps = {
  path: string;
  state: ProbeState;
  homeDir: string | null; // resolved home, or null when unknown
  homeReady: boolean; // false while the home lookup is pending
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onEnlarge: (handoff: { plan: PlayablePlan; src: string; startAt: number; playing: boolean }) => void;
  /** Bumped by the parent when the lightbox closes, to restore position. */
  resume?: { startAt: number; playing: boolean } | null;
};

const unavailable = (reason: PreviewUnavailableReason): PreviewPlan => ({ kind: "unavailable", reason });
const FORMAT_REFUSED = unavailable("format");
const PLAYBACK_FAILED = unavailable("playback");

const MEDIA_CLASS = "max-h-64 w-full rounded-md bg-surface-0";
const ICON_BUTTON_CLASS =
  "rounded p-1.5 text-fg-secondary hover:text-fg focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-fg-secondary";

const isPlayable = (plan: PreviewPlan): plan is PlayablePlan =>
  plan.kind === "image" || plan.kind === "video" || plan.kind === "audio";

const fileNameOf = (path: string): string => path.replace(/\\/g, "/").split("/").pop() || path;

export default function SourcePlayer({
  path,
  state,
  homeDir,
  homeReady,
  collapsed,
  onToggleCollapsed,
  onEnlarge,
  resume,
}: SourcePlayerProps) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  // One callback for both element kinds: a RefObject<HTMLMediaElement> is not assignable to a <video> ref.
  const setMedia = useCallback((element: HTMLMediaElement | null) => {
    const previous = mediaRef.current;
    if (previous !== null && previous !== element) releaseMedia(previous);
    mediaRef.current = element;
  }, []);

  const [failedPath, setFailedPath] = useState<string | null>(null);
  // A new source gets a fresh attempt: forget the previous file's error as soon as the path moves on.
  if (failedPath !== null && failedPath !== path) setFailedPath(null);
  const playbackFailed = failedPath === path;

  const plan = useMemo<PreviewPlan | null>(
    () => (homeReady && state.phase === "ready" ? planPreview(path, state.probe, homeDir) : null),
    [path, state, homeDir, homeReady],
  );

  // Asked once per plan: the webview, not the codec table, has the final say on what it can decode.
  const formatRefused = useMemo(
    () =>
      plan !== null &&
      (plan.kind === "video" || plan.kind === "audio") &&
      document.createElement(plan.kind).canPlayType(plan.mime) === "",
    [plan],
  );

  const src = useMemo(() => convertFileSrc(path), [path]);

  useEffect(() => {
    const media = mediaRef.current;
    if (resume == null || media === null) return;
    media.currentTime = resume.startAt;
    if (resume.playing) {
      // play() can reject (autoplay policy, element gone) and may return nothing in older webviews.
      void Promise.resolve(media.play()).catch(() => {});
    }
  }, [resume]);

  if (state.phase === "probing" || !homeReady) {
    return (
      <div aria-busy="true" className="text-xs text-fg-muted">
        Loading preview…
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <p role="status" className="text-xs text-fg-muted">
        {UNAVAILABLE_MESSAGES["probe-failed"]}
      </p>
    );
  }
  if (plan === null || plan.kind === "none") return null;

  const view: PreviewPlan = formatRefused ? FORMAT_REFUSED : playbackFailed && isPlayable(plan) ? PLAYBACK_FAILED : plan;
  const markFailed = () => setFailedPath(path);

  const enlarge = () => {
    if (!isPlayable(view)) return;
    const media = mediaRef.current;
    const startAt = media?.currentTime ?? 0;
    const playing = media !== null && !media.paused;
    media?.pause();
    onEnlarge({ plan: view, src, startAt, playing });
  };

  return (
    <div className="source-player">
      <div className="source-player-bar flex items-center justify-between">
        <span className="text-xs font-medium text-fg-muted">Preview</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Enlarge preview"
            disabled={collapsed || !isPlayable(view)}
            onClick={enlarge}
            className={ICON_BUTTON_CLASS}
          >
            <Maximize2 size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={collapsed ? "Show preview" : "Hide preview"}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
            className={ICON_BUTTON_CLASS}
          >
            {collapsed ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div key={path} className="source-player-body">
          {view.kind === "image" && (
            <img
              src={src}
              alt={"Preview of " + fileNameOf(path)}
              decoding="async"
              onError={markFailed}
              className={`${MEDIA_CLASS} object-contain`}
            />
          )}
          {view.kind === "video" && (
            <video
              ref={setMedia}
              src={src}
              controls
              preload="metadata"
              playsInline
              onError={markFailed}
              className={MEDIA_CLASS}
            />
          )}
          {view.kind === "audio" && (
            <audio ref={setMedia} src={src} controls preload="metadata" onError={markFailed} className="w-full" />
          )}
          {view.kind === "unavailable" && (
            <p role="status" className="rounded-md bg-surface-0 px-3 py-2 text-xs text-fg-muted">
              {UNAVAILABLE_MESSAGES[view.reason]}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
