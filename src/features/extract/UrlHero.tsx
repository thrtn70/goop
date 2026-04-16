import { useEffect, useRef, useState } from "react";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { UrlProbe, FormatOption } from "@/types";
import { useAppStore } from "@/store/appStore";
import ProbeCard from "./ProbeCard";

export default function UrlHero({ url }: { url?: string }) {
  const [probe, setProbe] = useState<UrlProbe | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const outputDir = useAppStore((s) => s.settings?.output_dir ?? "~/Downloads");

  async function handleProbe(u: string) {
    cancelledRef.current = false;
    setLoading(true);
    setError(null);
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
  }

  async function handleStart(format: FormatOption | null, audioOnly: boolean) {
    if (!probe) return;
    try {
      await api.extract.fromUrl({
        url: probe.url,
        output_dir: outputDir,
        audio_only: audioOnly,
        format: format ? format.format_id : null,
      });
    } catch (e) {
      setError(formatError(e));
    }
  }

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    (async () => {
      cancelledRef.current = false;
      setLoading(true);
      setError(null);
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
      {!loading && !probe && !error && (
        <div className="enter-up flex h-full flex-col items-center justify-center text-center">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-fg-muted/30">
            <path d="M24 8v32M16 32l8 8 8-8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="mt-3 text-sm text-fg-secondary">Paste a URL above and press Enter.</p>
          <p className="mt-1 text-xs text-fg-muted">YouTube, SoundCloud, TikTok, Instagram, Vimeo, and more.</p>
        </div>
      )}
    </div>
  );
}
