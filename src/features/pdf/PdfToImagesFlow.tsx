import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, pdfExtractImages } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { PdfImageFormat } from "@/types";

interface PdfToImagesFlowProps {
  file: string;
  onDone: () => void;
}

const DPI_MIN = 72;
const DPI_MAX = 600;
const DPI_DEFAULT = 150;

/**
 * Rasterize each page of a PDF to PNG or JPEG, written into a folder
 * the user picks. DPI defaults to 150 (good for archival + reasonable
 * file size); the slider clamps to a 72-600 range so we don't produce
 * 50 MB-per-page outputs on huge PDFs.
 */
export default function PdfToImagesFlow({ file, onDone }: PdfToImagesFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [format, setFormat] = useState<PdfImageFormat>("png");
  const [dpi, setDpi] = useState<number>(DPI_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApply() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const dir = await open({
        directory: true,
        title: "Choose output folder for images",
      });
      const outDir = typeof dir === "string" ? dir : null;
      if (!outDir) {
        setBusy(false);
        return;
      }
      await api.pdf.run(pdfExtractImages(file, outDir, format, dpi));
      enqueueToast({ variant: "success", title: "PDF image extract queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 p-3">
        <legend className="px-1 text-xs font-medium text-fg-secondary">Format</legend>
        <div className="flex gap-2">
          {(["png", "jpeg"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={format === f}
              onClick={() => setFormat(f)}
              className={`btn-press flex-1 rounded-md border px-3 py-1.5 text-sm transition duration-fast ease-out ${
                format === f
                  ? "border-accent bg-accent-subtle text-fg"
                  : "border-subtle bg-surface-2 text-fg-secondary hover:border-accent/60"
              }`}
            >
              {f === "png" ? "PNG" : "JPEG"}
            </button>
          ))}
        </div>
        <p className="text-xs text-fg-muted">
          PNG keeps every detail; JPEG is smaller for photo-heavy pages.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 p-3">
        <legend className="px-1 text-xs font-medium text-fg-secondary">Resolution</legend>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={DPI_MIN}
            max={DPI_MAX}
            step={2}
            value={dpi}
            onChange={(e) => setDpi(Number(e.target.value))}
            className="flex-1"
            aria-label="DPI"
          />
          <span className="w-20 text-right text-sm tabular-nums text-fg">{dpi} dpi</span>
        </div>
        <p className="text-xs text-fg-muted">
          72 = screen, 150 = good for print, 300+ = archival.
        </p>
      </fieldset>

      <div className="flex items-center gap-3 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Extract images"}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}
