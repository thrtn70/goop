import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { UrlProbe } from "@/types";
import { useAppStore } from "@/store/appStore";
import ProbeCard, { type StartOptions } from "./ProbeCard";

function looksLikeCookieError(message: string | null): boolean {
  return message != null && message.toLowerCase().includes("cookie");
}

export default function UrlHero({ url }: { url?: string }) {
  const [probe, setProbe] = useState<UrlProbe | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  // A download that won't start is not a link that won't load: the card is
  // already built, so the only thing worth retrying is the enqueue itself.
  // The options ride along with the message so that retry can re-send the
  // same request. Re-probing instead would null the probe, unmount the
  // card, and throw away the format the user picked.
  const [startError, setStartError] = useState<{
    message: string;
    opts: StartOptions;
  } | null>(null);
  const cancelledRef = useRef(false);
  // Bumped whenever the card a start belongs to is replaced, and again on
  // every new start attempt. `handleStart` is the one async path here that
  // can outlive its own card — `UrlHero` is re-rendered with a new `url`
  // rather than remounted, and `cancelledRef` is no help because the next
  // probe resets it — so an enqueue that rejects after the epoch has moved
  // on is reporting on something the user already left behind.
  const startEpochRef = useRef(0);
  const outputDir = useAppStore(
    (s) => s.settings?.output_dir_extract ?? s.settings?.output_dir ?? "~/Downloads",
  );
  const navigate = useNavigate();

  async function handleProbe(u: string) {
    cancelledRef.current = false;
    setLoading(true);
    setError(null);
    setStartError(null);
    startEpochRef.current += 1;
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
    setLoading(false);
    setProbe(null);
    setError(null);
    setStartError(null);
    startEpochRef.current += 1;
  }

  async function handleStart(opts: StartOptions) {
    if (!probe) return;
    setStartError(null);
    const epoch = (startEpochRef.current += 1);
    try {
      await api.extract.fromUrl({
        url: probe.url,
        output_dir: outputDir,
        audio_only: opts.audioOnly,
        format: opts.format ? opts.format.format_id : null,
        // Backend overrides these from current Settings, so the URL hero
        // doesn't need to surface the cookie picker or naming-scheme picker
        // alongside every extract.
        cookies_from_browser: null,
        output_template: null,
        // Set for plain-file links the extractors don't handle: skip the
        // doomed extractor spawns and stream the file directly.
        direct: probe.direct != null,
        // Set for magnet/hoster links that route through TorBox. The
        // remaining fields are owned by the backend debrid resolver and
        // cleared at the IPC boundary regardless.
        debrid: probe.debrid != null,
        // Which extractor actually answered the probe. The download would
        // otherwise re-guess from the URL's shape and spawn the wrong one
        // first on anything the classifier gets wrong.
        extractor_hint: probe.extractor,
        debrid_item: null,
        resume_key: null,
        filename_hint: null,
      });
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
      // A later start, or a different link, has since taken over the view.
      if (startEpochRef.current !== epoch) return;
      setStartError({ message: formatError(e), opts });
    }
  }

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    (async () => {
      cancelledRef.current = false;
      setLoading(true);
      setError(null);
      setStartError(null);
      startEpochRef.current += 1;
      setProbe(null);
      setLastUrl(url);
      try {
        const result = await api.extract.probe(url);
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
  }, [url]);

  return (
    <div className="p-6">
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
      {error && (
        <div className="enter-up rounded-lg bg-error-subtle p-4">
          <p className="text-sm font-medium text-error">Couldn't load that link</p>
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
              onClick={() => { setError(null); setLastUrl(null); }}
              className="btn-press rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-secondary transition duration-fast ease-out hover:bg-surface-3"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {probe && <ProbeCard probe={probe} onStart={handleStart} />}
      {startError && (
        <div className="enter-up mt-3 rounded-lg bg-error-subtle p-4">
          <p className="text-sm font-medium text-error">Couldn't start that download</p>
          <p className="mt-1 text-xs text-error/80">{startError.message}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void handleStart(startError.opts)}
              className="btn-press rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => setStartError(null)}
              className="btn-press rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-secondary transition duration-fast ease-out hover:bg-surface-3"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {!loading && !probe && !error && (
        <div className="enter-up flex h-full flex-col items-center justify-center text-center">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-fg-muted/30">
            <path d="M24 8v32M16 32l8 8 8-8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="mt-3 text-sm text-fg-secondary">Paste a URL above and press Enter.</p>
          <p className="mt-1 text-xs text-fg-muted">YouTube, SoundCloud, TikTok, Instagram, Vimeo, or any direct file link.</p>
        </div>
      )}
    </div>
  );
}
