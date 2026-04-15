import { useState } from "react";
import { api } from "@/ipc/commands";
import type { UrlProbe, FormatOption } from "@/types";
import { useAppStore } from "@/store/appStore";
import ProbeCard from "./ProbeCard";

export default function UrlHero({ url }: { url?: string }) {
  const [probe, setProbe] = useState<UrlProbe | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outputDir = useAppStore((s) => s.settings?.output_dir ?? "~/Downloads");

  async function handleProbe(u: string) {
    setLoading(true);
    setError(null);
    setProbe(null);
    try {
      setProbe(await api.extract.probe(u));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
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
      setError(String(e));
    }
  }

  // Auto-probe when a URL arrives via querystring
  if (url && !probe && !loading && !error) {
    void handleProbe(url);
  }

  return (
    <div className="p-6">
      {loading && <div className="text-neutral-400">Probing…</div>}
      {error && <div className="rounded border border-red-700 bg-red-950 p-3 text-sm text-red-300">{error}</div>}
      {probe && <ProbeCard probe={probe} onStart={handleStart} />}
      {!loading && !probe && !error && (
        <div className="flex h-full flex-col items-center justify-center text-center text-neutral-500">
          <div className="text-4xl">⬇</div>
          <p className="mt-2">Paste a URL or drop a file above.</p>
        </div>
      )}
    </div>
  );
}
