import type { Dispatch, SetStateAction } from "react";
import { useWorkspaceOutcomeState } from "@/store/workspaceOutcomes";
import { useWorkspaceOperation } from "@/store/workspaceOperations";
import { WorkspaceDraftProvider, forgetWorkspaceSource, useWorkspaceTool, useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open, save } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import { api, pdfImageOcr } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { IpcLanguagePack } from "@/ipc/commands";
import type { ImageOcrOutput } from "@/types";

interface ImageOcrFlowProps {
  onDone: () => void;
}

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

/**
 * OCR one or more images into either plain text (.txt) or a multi-page
 * searchable PDF. Adapted from ImagesToPdfFlow's multi-file picker
 * pattern + PdfOcrFlow's language picker.
 */
export default function ImageOcrFlow({ onDone }: ImageOcrFlowProps) {
  const [images, setImages] = useWorkspaceDraftState<string[]>("ImageOcrFlow.images", []);
  const [outputKind, setOutputKind] = useWorkspaceDraftState<ImageOcrOutput>("ImageOcrFlow.outputKind", "text");
  const [lang, setLang] = useWorkspaceDraftState<string>("ImageOcrFlow.lang", "eng");
  return <WorkspaceDraftProvider scope={["ImageOcrFlow", ...images.slice().sort()]} sourcePaths={images}><ImageOcrFlowOperation {...{onDone, images, setImages, outputKind, setOutputKind, lang, setLang}} /></WorkspaceDraftProvider>;
}

function ImageOcrFlowOperation({onDone, images, setImages, outputKind, setOutputKind, lang, setLang}: ImageOcrFlowProps & {images: string[]; setImages: Dispatch<SetStateAction<string[]>>; outputKind: ImageOcrOutput; setOutputKind: Dispatch<SetStateAction<ImageOcrOutput>>; lang: string; setLang: Dispatch<SetStateAction<string>>;}) {
  const tool = useWorkspaceTool();
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const navigate = useNavigate();
  const [installed, setInstalled] = useState<IpcLanguagePack[]>([]);
  const [loadingLangs, setLoadingLangs] = useState<boolean>(true);
  const { busy, begin } = useWorkspaceOperation();
  const [error, setError] = useWorkspaceOutcomeState<string | null>("ImageOcrFlow.error", null);

  useEffect(() => {
    let cancelled = false;
    void api.sidecar
      .tessdataInstalled()
      .then((langs) => {
        if (cancelled) return;
        setInstalled(langs);
        if (langs.length > 0 && !langs.some((l) => l.code === lang)) {
          setLang(langs[0].code);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(formatError(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingLangs(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handlePick() {
    setError(null);
    try {
      const picked = await open({
        multiple: true,
        title: "Pick images to OCR",
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
      });
      if (!picked) return;
      const next = Array.isArray(picked) ? picked : [picked];
      setImages((prev) => [...prev, ...next.filter((p) => !prev.includes(p))]);
    } catch (e) {
      setError(formatError(e));
    }
  }

  function remove(idx: number) {
    forgetWorkspaceSource(tool, images[idx]);
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleApply() {
    if (busy || images.length === 0) return;
    const finish = begin();
    if (!finish) return;
    setError(null);
    try {
      const isText = outputKind === "text";
      const dest = await save({
        defaultPath: isText ? "ocr.txt" : "ocr.pdf",
        title: isText ? "Save OCR text" : "Save searchable PDF",
        filters: [
          isText
            ? { name: "Text", extensions: ["txt"] }
            : { name: "PDF", extensions: ["pdf"] },
        ],
      });
      if (!dest) {
        return;
      }
      await api.pdf.run(pdfImageOcr(images, dest, outputKind, lang));
      enqueueToast({ variant: "success", title: "Image OCR queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      finish();
    }
  }

  const canApply = !busy && images.length > 0 && installed.length > 0 && !!lang;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted">
        Reads text out of one or more images. PNG and JPEG.
      </p>

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-fg-secondary">
          {images.length === 0
            ? "No images selected yet"
            : `${images.length} image${images.length === 1 ? "" : "s"}`}
        </span>
        <button
          type="button"
          onClick={() => void handlePick()}
          className="btn-press rounded-md border border-subtle bg-surface-2 px-3 py-1.5 text-sm text-fg hover:border-accent/60"
        >
          {images.length > 0 ? "Add more…" : "Pick images…"}
        </button>
      </div>

      {images.length > 0 && (
        <ol className="flex flex-col gap-1 rounded-md border border-subtle bg-surface-1 p-2">
          {images.map((p, idx) => (
            <li
              key={p}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2"
            >
              <span className="w-6 shrink-0 text-right text-xs tabular-nums text-fg-muted">
                {idx + 1}
              </span>
              <span className="flex-1 truncate text-sm text-fg" title={p}>
                {basename(p)}
              </span>
              <button
                type="button"
                onClick={() => remove(idx)}
                aria-label={`Remove ${basename(p)}`}
                className="btn-press rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-error"
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ol>
      )}

      <fieldset className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 p-3">
        <legend className="px-1 text-xs font-medium text-fg-secondary">Output</legend>
        <div className="flex gap-2">
          {([
            ["text", "Text (.txt)"],
            ["searchable_pdf", "Searchable PDF"],
          ] as const).map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              aria-pressed={outputKind === kind}
              onClick={() => setOutputKind(kind)}
              className={`btn-press flex-1 rounded-md border px-3 py-1.5 text-sm transition duration-fast ease-out ${
                outputKind === kind
                  ? "border-accent bg-accent-subtle text-fg"
                  : "border-subtle bg-surface-2 text-fg-secondary hover:border-accent/60"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 p-3">
        <legend className="px-1 text-xs font-medium text-fg-secondary">Language</legend>
        {loadingLangs ? (
          <p className="text-sm text-fg-muted">Loading installed packs…</p>
        ) : installed.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No language packs installed. Visit{" "}
            <button
              type="button"
              onClick={() => navigate("/settings#ocr-languages")}
              className="text-accent underline hover:no-underline"
            >
              Settings → OCR Languages
            </button>{" "}
            to add one.
          </p>
        ) : (
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="rounded-md border border-subtle bg-surface-2 px-3 py-1.5 text-sm text-fg"
          >
            {installed
              .slice()
              .sort((a, b) => a.display_name.localeCompare(b.display_name))
              .map((l) => (
                <option key={l.code} value={l.code}>
                  {l.display_name}
                  {l.bundled ? " (bundled)" : ""}
                </option>
              ))}
          </select>
        )}
      </fieldset>

      <div className="flex items-center gap-3 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={!canApply}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy
            ? "Queuing…"
            : images.length === 0
              ? "Pick images first"
              : "Run OCR"}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}
