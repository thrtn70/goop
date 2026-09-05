import WorkspaceFrame from "@/components/workspace/WorkspaceFrame";
import {
  useExtractSession,
  nextExtractAttemptId,
} from "@/store/extractSession";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { UrlProbe } from "@/types";
import { useAppStore } from "@/store/appStore";
import ProbeCard from "./ProbeCard";
import { startBanner, type StartOptions } from "./startState";

function looksLikeCookieError(message: string | null): boolean {
  return message != null && message.toLowerCase().includes("cookie");
}

export default function UrlHero({ url }: { url?: string }) {
  const [probe, setProbe] = useState<UrlProbe | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUrl, setLastUrl] = useWorkspaceDraftState<string | null>(
    "UrlHero.lastUrl",
    null,
  );
  const cancelledRef = useRef(false);
  // Everything about starting a download, in one place. This was five
  // separate pieces — an epoch ref, two booleans and an error object — and
  // every defect here was two of them disagreeing.
  const start = useExtractSession((s) => s.start);
  const send = useExtractSession((s) => s.send);

  const outputDir = useAppStore(
    (s) =>
      s.settings?.output_dir_extract ?? s.settings?.output_dir ?? "~/Downloads",
  );
  const navigate = useNavigate();

  async function handleProbe(u: string) {
    cancelledRef.current = false;
    setLoading(true);
    setError(null);
    if (u !== lastUrl) send({ type: "retire" });
    setProbe(null);
    setLastUrl(u);
    try {
      const result = await api.extract.probe(u);
      if (!cancelledRef.current) {
        setProbe(result);
      }
    } catch (e) {
      if (!cancelledRef.current) {
        setError(formatError(e));
      }
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }

  function handleCancel() {
    cancelledRef.current = true;
    setLastUrl(null);
    setLoading(false);
    setProbe(null);
    setError(null);
    send({ type: "retire" });
  }

  /**
   * The one way an enqueue begins. Both the card's Start button and the
   * failure banner's retry come through here, so there is no second path
   * to keep in step with this one.
   *
   * Returns nothing, and `runStart` never rejects, so no caller has to
   * remember to await or to catch. Nothing throws across the boundary to
   * the card at all — which is the point, because an unhandled rejection
   * on this path is invisible to the suite.
   */
  function startAttempt(opts: StartOptions) {
    if (!probe) return;
    const id = nextExtractAttemptId();
    send({ type: "attempt", id, url: probe.url, opts });
    void runStart(id, probe, opts);
  }

  // Takes the probe it was started for, so the URL recorded in the state
  // and the URL sent in the request are provably the same one.
  async function runStart(id: number, started: UrlProbe, opts: StartOptions) {
    try {
      await api.extract.fromUrl({
        url: started.url,
        output_dir: outputDir,
        audio_only: opts.audioOnly,
        // The selector, not the bare id: a video-only format needs
        // `+bestaudio` appended or yt-dlp downloads that stream alone and
        // the file arrives silent. The backend composes it during the
        // probe; passing `format_id` here is what made 1080p+ picks mute.
        format: opts.format ? opts.format.selector : null,
        // Backend overrides these from current Settings, so the URL hero
        // doesn't need to surface the cookie picker or naming-scheme picker
        // alongside every extract.
        cookies_from_browser: null,
        output_template: null,
        // Set for plain-file links the extractors don't handle: skip the
        // doomed extractor spawns and stream the file directly.
        direct: started.direct != null,
        // Set for magnet/hoster links that route through TorBox. The
        // remaining fields are owned by the backend debrid resolver and
        // cleared at the IPC boundary regardless.
        debrid: started.debrid != null,
        // Which extractor actually answered the probe. The download would
        // otherwise re-guess from the URL's shape and spawn the wrong one
        // first on anything the classifier gets wrong.
        extractor_hint: started.extractor,
        debrid_item: null,
        resume_key: null,
        filename_hint: null,
      });
      send({ type: "succeeded", id });
      // Enqueue emits no queue event until the scheduler claims the job,
      // so refresh explicitly — otherwise a job queued behind a full
      // concurrency limit is invisible in the sidebar until something
      // else transitions. Best-effort: the next queue event self-heals.
      useAppStore
        .getState()
        .refreshJobs()
        .catch(() => {
          /* transient IPC failure — the next queue event refreshes */
        });
    } catch (e) {
      // Whether this reports at all is decided by the id, in one place.
      send({ type: "failed", id, message: formatError(e) });
    }
  }

  useEffect(() => {
    const requestedUrl = url ?? lastUrl;
    if (!requestedUrl) return;
    let cancelled = false;
    (async () => {
      cancelledRef.current = false;
      setLoading(true);
      setError(null);
      if (requestedUrl !== lastUrl) send({ type: "retire" });
      setProbe(null);
      setLastUrl(requestedUrl);
      try {
        const result = await api.extract.probe(requestedUrl);
        if (!cancelled && !cancelledRef.current) setProbe(result);
      } catch (e) {
        if (!cancelled && !cancelledRef.current) setError(formatError(e));
      } finally {
        if (!cancelled && !cancelledRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      cancelledRef.current = true;
    };
    // Re-entering the route re-probes saved input but never retires or repeats its enqueue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Either a failure to report, or the message a retry is carrying.
  const banner = startBanner(start);

  const failureBanner = banner && (
    <div role="alert" className="enter-up mt-3 rounded-lg bg-error-subtle p-4">
      <p className="text-sm font-medium text-error">
        Couldn't start that download
      </p>
      <p className="mt-1 text-xs text-error/80">{banner.message}</p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={banner.retrying}
          onClick={() => startAttempt(banner.opts)}
          className="btn-press rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
        >
          {banner.retrying ? "Trying…" : "Try again"}
        </button>
        <button
          type="button"
          onClick={() => send({ type: "dismiss" })}
          className="btn-press rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-secondary transition duration-fast ease-out hover:bg-surface-3"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
  if (probe)
    return (
      <ProbeCard
        workspace
        outputDir={outputDir}
        banner={failureBanner}
        probe={probe}
        start={start}
        onStart={startAttempt}
      />
    );

  return (
    <WorkspaceFrame title="Extract" description="Save a link to your computer.">
      {loading && (
        <div className="enter-up rounded-lg bg-surface-1 p-4">
          <div className="animate-pulse">
            <div className="h-5 w-56 rounded bg-surface-3" />
            <div className="mt-3 h-3 w-36 rounded bg-surface-2" />
          </div>
          <div className="mt-3 flex items-center justify-between">
            <p className="text-xs text-fg-muted">Looking up that link...</p>
            <button
              type="button"
              onClick={handleCancel}
              className="btn-press text-xs text-fg-muted transition duration-fast ease-out hover:text-fg"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {/* `alert`, not `status`, for the same reason the toasts split that
          way: an error pre-empts, everything else queues politely. It also
          keeps this banner and the start banner below reading alike, which
          is the whole point — a user who has heard one failure announced
          should not have to guess that the other one is silent. Nothing
          renders both at once (a probe retires the start state before it
          can fail, and nulls the card any start belonged to), so there is
          still exactly one alert in this subtree at any moment. */}
      {error && (
        <div role="alert" className="enter-up rounded-lg bg-error-subtle p-4">
          <p className="text-sm font-medium text-error">
            Couldn't load that link
          </p>
          <p className="mt-1 text-xs text-error/80">{error}</p>
          <div className="mt-3 flex gap-2">
            {lastUrl && (
              <button
                type="button"
                onClick={() => void handleProbe(lastUrl)}
                className="btn-press rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
              >
                Try again
              </button>
            )}
            {looksLikeCookieError(error) && (
              <button
                type="button"
                onClick={() => navigate("/settings#cookies-from-browser")}
                className="btn-press rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-secondary transition duration-fast ease-out hover:bg-surface-3"
              >
                Cookie settings
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setLastUrl(null);
              }}
              className="btn-press rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-secondary transition duration-fast ease-out hover:bg-surface-3"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {failureBanner}
      {!loading && !probe && !error && (
        <div className="enter-up flex h-full flex-col items-center justify-center text-center">
          <svg
            width="48"
            height="48"
            viewBox="0 0 48 48"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-fg-muted/30"
          >
            <path
              d="M24 8v32M16 32l8 8 8-8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <p className="mt-3 text-sm text-fg-secondary">
            Paste a URL above and press Enter.
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            YouTube, SoundCloud, TikTok, Instagram, Vimeo, or any direct file
            link.
          </p>
        </div>
      )}
    </WorkspaceFrame>
  );
}
