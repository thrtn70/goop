import type { Dispatch, SetStateAction } from "react";
import { useWorkspaceOutcomeState } from "@/store/workspaceOutcomes";
import { useWorkspaceOperation } from "@/store/workspaceOperations";
import { WorkspaceDraftProvider, forgetWorkspaceSource, useWorkspaceTool, useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { api, pdfImagesToPdf } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";

interface ImagesToPdfFlowProps {
  onDone: () => void;
}

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

/**
 * Combine multiple images (PNG / JPEG) into a single PDF, one image
 * per page in the supplied order. The user picks images via the OS
 * file dialog, reorders them with up/down buttons, then chooses an
 * output PDF path.
 *
 * Adapted from the page-grid pattern used for PDF reorder, but
 * simplified to a vertical list with up/down + remove because there
 * is no per-image thumbnail (rendering thumbnails for arbitrary user
 * images is a v0.2.5 polish item alongside the broader Image
 * Workshop scope).
 */
export default function ImagesToPdfFlow({ onDone }: ImagesToPdfFlowProps) {
  const [images, setImages] = useWorkspaceDraftState<string[]>("ImagesToPdfFlow.images", []);
  return <WorkspaceDraftProvider scope={["ImagesToPdfFlow", ...images.slice().sort()]} sourcePaths={images}><ImagesToPdfFlowOperation {...{onDone, images, setImages}} /></WorkspaceDraftProvider>;
}

function ImagesToPdfFlowOperation({onDone, images, setImages}: ImagesToPdfFlowProps & {images: string[]; setImages: Dispatch<SetStateAction<string[]>>;}) {
  const tool = useWorkspaceTool();
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const { busy, begin } = useWorkspaceOperation();
  const [error, setError] = useWorkspaceOutcomeState<string | null>("ImagesToPdfFlow.error", null);

  async function handlePick() {
    setError(null);
    try {
      const picked = await open({
        multiple: true,
        title: "Pick images to combine",
        filters: [
          {
            name: "Images",
            // Expanded in v0.2.5 to match the image crate's
            // ImageReader::with_guessed_format() coverage. JPEGs go
            // through the DCTDecode passthrough so photo-heavy
            // outputs are ~10× smaller than the v0.2.4 raw-pixel
            // embed.
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "webp",
              "bmp",
              "gif",
              "tiff",
              "tif",
              "avif",
              "ico",
              "hdr",
              "jxl",
              "heic",
              "heif",
            ],
          },
        ],
      });
      if (!picked) return;
      const next = Array.isArray(picked) ? picked : [picked];
      // Append to existing selection so the user can pick from
      // multiple folders without losing what they've already chosen.
      setImages((prev) => [...prev, ...next.filter((p) => !prev.includes(p))]);
    } catch (e) {
      setError(formatError(e));
    }
  }

  function moveUp(idx: number) {
    if (idx === 0) return;
    setImages((prev) => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  }

  function moveDown(idx: number) {
    setImages((prev) => {
      if (idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
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
      const dest = await save({
        defaultPath: "combined.pdf",
        title: "Save combined PDF",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!dest) {
        return;
      }
      await api.pdf.run(pdfImagesToPdf(images, dest));
      enqueueToast({ variant: "success", title: "Images to PDF queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      finish();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-fg-muted">
          PNG, JPEG, WebP, BMP, GIF, TIFF, AVIF, ICO, and more. JPEGs are
          embedded directly for smaller output PDFs. Each image becomes one
          page in the order shown.
        </p>
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
                onClick={() => moveUp(idx)}
                disabled={idx === 0}
                aria-label={`Move ${basename(p)} up`}
                className="btn-press rounded p-1 text-fg-muted enabled:hover:bg-surface-3 enabled:hover:text-fg disabled:opacity-30"
              >
                <ChevronUp size={14} />
              </button>
              <button
                type="button"
                onClick={() => moveDown(idx)}
                disabled={idx === images.length - 1}
                aria-label={`Move ${basename(p)} down`}
                className="btn-press rounded p-1 text-fg-muted enabled:hover:bg-surface-3 enabled:hover:text-fg disabled:opacity-30"
              >
                <ChevronDown size={14} />
              </button>
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

      <div className="flex items-center gap-3 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={busy || images.length === 0}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy
            ? "Saving…"
            : images.length === 0
              ? "Pick images first"
              : `Combine ${images.length} image${images.length === 1 ? "" : "s"} into PDF`}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}
