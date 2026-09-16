import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { ImageSettingsCapabilities, PreviewRequest, PreviewResult, VideoSettingsCapabilities } from "@/types";

type Settings = Omit<PreviewRequest, "request_id" | "source_revision">;
type Comparison = "source" | "current" | "pinned";

// PreviewService owns one backend session for the whole app, so ownership
// transitions must also survive React subtree remounts when selection changes.
let previewOwnershipTail: Promise<void> = Promise.resolve();
let previewOwnershipPending = 0;

function enqueuePreviewOwnership<T>(operation: () => Promise<T>): Promise<T> {
  const waitsForPriorOwnership = previewOwnershipPending > 0;
  previewOwnershipPending += 1;
  const result = waitsForPriorOwnership ? previewOwnershipTail.then(operation, operation) : operation();
  previewOwnershipTail = result.then(
    () => { previewOwnershipPending -= 1; },
    () => { previewOwnershipPending -= 1; },
  );
  return result;
}

async function drainPreviewOwnership() {
  while (previewOwnershipPending > 0) {
    const pending = previewOwnershipTail;
    await pending;
    if (pending === previewOwnershipTail) return;
  }
}

/** Samples are ephemeral and never enter the queue or the persisted draft. */
export default function SettingsPreview({ request, imageSettings, videoSettings, blockedReason = null }: { request: Settings; imageSettings?: ImageSettingsCapabilities | null; videoSettings?: Pick<VideoSettingsCapabilities, "preview_unavailable_reason"> | null; blockedReason?: string | null }) {
  const engineSupported = !request.video_options && (!request.image_options || (imageSettings?.available && (
    request.image_options.resize.kind === "original" ? imageSettings.preview_original_available : imageSettings.preview_fit_within
  )));
  const supported = engineSupported && !blockedReason;
  const unavailableReason = blockedReason ?? (request.video_options ? videoSettings?.preview_unavailable_reason ?? "Explicit video settings previews are unavailable." : engineSupported ? null : imageSettings?.preview_unavailable_reason ?? "Image settings preview is unavailable.");
  const revision = JSON.stringify(request, (_key, value: unknown) => typeof value === "bigint" ? Number(value) : value);
  const isHeic = /\.(?:heic|heif)$/i.test(request.input_path);
  const heicSourceKey = isHeic && request.target === "jpeg" && request.image_options && engineSupported ? request.input_path : null;
  const active = useRef<string | null>(null);
  const displayed = useRef<string | null>(null);
  const session = useRef<{ source: string; id: string } | null>(null);
  const sessionOpening = useRef<{ source: string; lifecycle: number; promise: Promise<string> } | null>(null);
  const lifecycle = useRef(0);
  const currentHeicSource = useRef(heicSourceKey);
  const heldFrom = useRef<Comparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinnedQuality, setPinnedQuality] = useState<number | null>(null);
  const [comparison, setComparison] = useState<Comparison>("current");

  const cancelRequests = useCallback(() => {
    const ids = new Set([active.current, displayed.current]);
    active.current = null;
    displayed.current = null;
    for (const id of ids) if (id) void api.preview.cancel(id).catch(() => {});
  }, []);

  const releaseSession = useCallback(() => {
    lifecycle.current += 1;
    const current = session.current;
    session.current = null;
    if (current) void enqueuePreviewOwnership(() => api.preview.release(current.id)).catch(() => {});
  }, []);

  useEffect(() => {
    cancelRequests();
    setResult(null);
    setError(null);
    setBusy(false);
    setComparison("current");
  }, [cancelRequests, revision, unavailableReason]);

  useLayoutEffect(() => {
    currentHeicSource.current = heicSourceKey;
    releaseSession();
    setPinnedQuality(null);
    setComparison("current");
  }, [heicSourceKey, releaseSession]);

  useEffect(() => () => {
    cancelRequests();
    releaseSession();
  }, [cancelRequests, releaseSession]);

  async function ensureSession(): Promise<string | null> {
    if (!heicSourceKey) return null;
    if (session.current?.source === heicSourceKey) return session.current.id;
    const expectedSource = heicSourceKey;
    const expectedLifecycle = lifecycle.current;
    const opening = sessionOpening.current;
    if (opening?.source === expectedSource && opening.lifecycle === expectedLifecycle) return opening.promise;

    const begin = async () => {
      if (lifecycle.current !== expectedLifecycle || currentHeicSource.current !== expectedSource) {
        throw new Error("Preview session is no longer active.");
      }
      const id = await api.preview.begin();
      if (lifecycle.current !== expectedLifecycle || currentHeicSource.current !== expectedSource) {
        await api.preview.release(id).catch(() => {});
        throw new Error("Preview session is no longer active.");
      }
      session.current = { source: expectedSource, id };
      return id;
    };
    const promise = enqueuePreviewOwnership(begin);
    const next = { source: expectedSource, lifecycle: expectedLifecycle, promise };
    sessionOpening.current = next;
    void promise.then(
      () => { if (sessionOpening.current === next) sessionOpening.current = null; },
      () => { if (sessionOpening.current === next) sessionOpening.current = null; },
    );
    return promise;
  }

  function sessionlessBarrier(): Promise<void> | null {
    if (session.current || sessionOpening.current) releaseSession();
    return previewOwnershipPending > 0 ? drainPreviewOwnership() : null;
  }

  async function generate(pinnedOverride: number | null = pinnedQuality) {
    if (!supported) return;
    const pending = active.current;
    if (pending && pending !== displayed.current) void api.preview.cancel(pending).catch(() => {});
    const id = crypto.randomUUID();
    active.current = id;
    setBusy(true);
    setError(null);
    try {
      const barrier = heicSourceKey ? null : sessionlessBarrier();
      const previewSessionId = heicSourceKey ? await ensureSession() : null;
      if (barrier) await barrier;
      if (active.current !== id) return;
      const sample = await api.preview.generate({
        ...request,
        request_id: id,
        source_revision: revision,
        ...(previewSessionId ? {
          preview_session_id: previewSessionId,
          pinned_jpeg_quality: pinnedOverride,
        } : {}),
      });
      if (active.current === id && sample.request_id === id && sample.source_revision === revision) {
        displayed.current = id;
        setResult(sample);
        setComparison("current");
        if (sample.image_details?.pinned_jpeg_quality != null) setPinnedQuality(sample.image_details.pinned_jpeg_quality);
      }
    } catch (cause) {
      if (active.current === id) setError(formatError(cause));
    } finally {
      if (active.current === id) setBusy(false);
    }
  }

  function close() {
    cancelRequests();
    releaseSession();
    setPinnedQuality(null);
    setBusy(false);
    setResult(null);
    setError(null);
    setComparison("current");
  }

  function holdPinned() {
    if (!result?.image_details?.pinned_path) return;
    if (heldFrom.current === null) heldFrom.current = comparison;
    setComparison("pinned");
  }

  function releasePinned() {
    const previous = heldFrom.current;
    heldFrom.current = null;
    if (previous) setComparison(previous);
  }

  const details = result?.image_details?.sample_kind === "embedded_heic_thumbnail" ? result.image_details : null;
  const selectedPath = details ? comparison === "source" ? result?.before_path : comparison === "pinned" ? details.pinned_path : result?.after_path : null;
  const selectedAlt = details ? comparison === "source" ? "Source sample" : comparison === "pinned" ? `Pinned quality ${details.pinned_jpeg_quality} sample` : `Current quality ${details.current_jpeg_quality} sample` : "";
  const fitExceedsSample = details && request.image_options?.resize.kind === "fit_within" && (
    details.planned_output_width > details.comparison_frame_width || details.planned_output_height > details.comparison_frame_height
  );

  return <section className="mt-5 border-t border-subtle pt-4" aria-label="Settings preview">
    <div className="flex items-center gap-2">
      <button type="button" disabled={busy || !supported} onClick={() => void generate()} className="btn-press rounded-md bg-surface-2 px-3 py-2 text-xs text-fg-secondary disabled:opacity-50">{busy ? "Preparing sample…" : "Preview sample"}</button>
      {(busy || result || error) && <button type="button" onClick={close} className="rounded-md px-2 py-2 text-xs text-fg-secondary">{busy ? "Cancel preview" : "Close preview"}</button>}
    </div>
    <p className="mt-2 text-xs text-fg-muted">A bounded sample, not an output-size estimate. Originals stay unchanged.</p>
    {unavailableReason && <p className="mt-2 text-xs text-fg-muted">{unavailableReason}</p>}
    {error && <p role="alert" className="mt-2 text-xs text-warning">{error}</p>}
    {result && supported && result.source_revision === revision && details && <div className="mt-3 space-y-3">
      <div className="rounded-lg border border-subtle bg-surface-1 p-3">
        <p className="text-xs font-medium text-fg-secondary">Embedded camera preview · {details.admitted_sample_width} × {details.admitted_sample_height}</p>
        {(details.comparison_frame_width !== details.admitted_sample_width || details.comparison_frame_height !== details.admitted_sample_height) && <p className="mt-1 text-xs text-fg-muted">Comparison frame · {details.comparison_frame_width} × {details.comparison_frame_height}</p>}
        <p className="mt-1 text-xs text-fg-muted">Intended output · {details.planned_output_width} × {details.planned_output_height}</p>
      </div>
      {selectedPath && <figure className={comparison === "source" ? "transparency-checkerboard rounded-lg" : "rounded-lg bg-surface-1"}>
        <img src={convertFileSrc(selectedPath)} alt={selectedAlt} className="max-h-64 w-full rounded-lg object-contain"/>
        <figcaption className="mt-1 px-1 text-xs text-fg-muted">
          {comparison === "source" ? "Embedded source" : comparison === "pinned" ? `Pinned · quality ${details.pinned_jpeg_quality}` : `Current · quality ${details.current_jpeg_quality}`}
        </figcaption>
      </figure>}
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface-1 p-1" aria-label="JPEG preview comparison">
        <button type="button" aria-pressed={comparison === "source"} onClick={() => setComparison("source")} className="rounded-md px-2 py-1.5 text-xs text-fg-secondary aria-pressed:bg-surface-2">Source</button>
        <button type="button" aria-pressed={comparison === "current"} onClick={() => setComparison("current")} className="rounded-md px-2 py-1.5 text-xs text-fg-secondary aria-pressed:bg-surface-2" aria-label={`Current quality ${details.current_jpeg_quality}`}>Current</button>
        <button type="button" disabled={!details.pinned_path} aria-pressed={comparison === "pinned"} onClick={() => setComparison("pinned")} className="rounded-md px-2 py-1.5 text-xs text-fg-secondary aria-pressed:bg-surface-2 disabled:opacity-40" aria-label={details.pinned_jpeg_quality == null ? "No pinned quality" : `Pinned quality ${details.pinned_jpeg_quality}`}>Pinned</button>
      </div>
      {details.pinned_path && details.pinned_jpeg_quality != null ? <button
        type="button"
        aria-label={`Hold to show pinned quality ${details.pinned_jpeg_quality}`}
        onPointerDown={holdPinned}
        onPointerUp={releasePinned}
        onPointerCancel={releasePinned}
        onPointerLeave={releasePinned}
        onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") holdPinned(); }}
        onKeyUp={(event) => { if (event.key === " " || event.key === "Enter") releasePinned(); }}
        onBlur={releasePinned}
        className="btn-press w-full rounded-md border border-subtle px-3 py-2 text-xs text-fg-secondary"
      >Hold to show pinned quality</button> : <button
        type="button"
        disabled={busy}
        onClick={() => { void generate(details.current_jpeg_quality); }}
        className="btn-press w-full rounded-md border border-subtle px-3 py-2 text-xs text-fg-secondary disabled:opacity-50"
        aria-label={`Pin current quality ${details.current_jpeg_quality}`}
      >Pin current quality</button>}
      {fitExceedsSample && <p className="text-xs text-fg-muted">Fit settings exceed the embedded camera preview, so the sample may not visibly change. Intended output dimensions remain accurate.</p>}
      <p className="text-xs text-fg-muted">Quality sample only. It cannot predict full-resolution detail, exact color fidelity, or final file size.</p>
    </div>}
    {result && supported && result.source_revision === revision && !details && <div className="mt-3 space-y-3">
      <p className="text-xs text-fg-muted">{result.kind === "video" ? "Muted H.264 viewing sample. Stream-copy jobs are re-encoded for this preview." : "Sample images omit metadata."}</p>
      {result.before_path && <figure className="transparency-checkerboard rounded-md"><img src={convertFileSrc(result.before_path)} alt="Source sample" className="max-h-52 w-full rounded-md object-contain"/><figcaption className="mt-1 bg-surface-1 text-xs text-fg-muted">Source sample</figcaption></figure>}
      {result.kind === "image" ? <figure><img src={convertFileSrc(result.after_path)} alt="Output sample" className="max-h-52 w-full rounded-md object-contain"/><figcaption className="mt-1 text-xs text-fg-muted">Output sample</figcaption></figure> : <video src={convertFileSrc(result.after_path)} aria-label="Output video sample" controls muted preload="metadata" className="w-full rounded-md"/>}
      <p className="text-xs text-fg-muted">{result.width} × {result.height} · Sample only{result.duration_ms != null ? ` · ${(result.duration_ms / 1000).toFixed(1)} seconds` : ""}</p>
    </div>}
  </section>;
}
