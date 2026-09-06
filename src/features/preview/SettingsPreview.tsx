import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { PreviewRequest, PreviewResult } from "@/types";

type Settings = Omit<PreviewRequest, "request_id" | "source_revision">;

/** Samples are ephemeral and never enter the queue or the persisted draft. */
export default function SettingsPreview({ request }: { request: Settings }) {
  const revision = JSON.stringify(request, (_key, value: unknown) => typeof value === "bigint" ? Number(value) : value);
  const active = useRef<string | null>(null);
  const displayed = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function release() {
    const ids = new Set([active.current, displayed.current]);
    active.current = null;
    displayed.current = null;
    for (const id of ids) if (id) void api.preview.cancel(id).catch(() => {});
  }

  useEffect(() => {
    setResult(null);
    setError(null);
    setBusy(false);
    return release;
  }, [revision]);

  async function generate() {
    const pending = active.current;
    if (pending && pending !== displayed.current) void api.preview.cancel(pending).catch(() => {});
    const id = crypto.randomUUID();
    active.current = id;
    setBusy(true);
    setError(null);
    try {
      const sample = await api.preview.generate({ ...request, request_id: id, source_revision: revision });
      if (active.current === id && sample.request_id === id && sample.source_revision === revision) {
        displayed.current = id;
        setResult(sample);
      }
    } catch (cause) {
      if (active.current === id) setError(formatError(cause));
    } finally {
      if (active.current === id) setBusy(false);
    }
  }

  function close() {
    release();
    setBusy(false);
    setResult(null);
    setError(null);
  }

  return <section className="mt-5 border-t border-subtle pt-4" aria-label="Settings preview">
    <div className="flex items-center gap-2">
      <button type="button" disabled={busy} onClick={() => void generate()} className="btn-press rounded-md bg-surface-2 px-3 py-2 text-xs text-fg-secondary disabled:opacity-50">{busy ? "Preparing sample…" : "Preview sample"}</button>
      {(busy || result || error) && <button type="button" onClick={close} className="rounded-md px-2 py-2 text-xs text-fg-secondary">{busy ? "Cancel preview" : "Close preview"}</button>}
    </div>
    <p className="mt-2 text-xs text-fg-muted">A bounded sample, not an output-size estimate. Originals stay unchanged.</p>
    {error && <p role="alert" className="mt-2 text-xs text-warning">{error}</p>}
    {result && <div className="mt-3 space-y-3">
      <p className="text-xs text-fg-muted">{result.kind === "video" ? "Muted H.264 viewing sample. Stream-copy jobs are re-encoded for this preview." : "Sample images omit metadata."}</p>
      {result.before_path && <figure><img src={convertFileSrc(result.before_path)} alt="Source sample" className="max-h-52 w-full rounded-md object-contain"/><figcaption className="mt-1 text-xs text-fg-muted">Source sample</figcaption></figure>}
      {result.kind === "image" ? <figure><img src={convertFileSrc(result.after_path)} alt="Output sample" className="max-h-52 w-full rounded-md object-contain"/><figcaption className="mt-1 text-xs text-fg-muted">Output sample</figcaption></figure> : <video src={convertFileSrc(result.after_path)} aria-label="Output video sample" controls muted preload="metadata" className="w-full rounded-md"/>}
      <p className="text-xs text-fg-muted">{result.width} × {result.height} · Sample only{result.duration_ms != null ? ` · ${(result.duration_ms / 1000).toFixed(1)} seconds` : ""}</p>
    </div>}
  </section>;
}
