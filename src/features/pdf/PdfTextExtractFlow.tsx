import { useWorkspaceOperation } from "@/store/workspaceOperations";
import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, pdfExtractText } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";

interface PdfTextExtractFlowProps {
  file: string;
  onDone: () => void;
}

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

function stemOf(p: string): string {
  const name = basename(p);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Extract the embedded text layer from a PDF as plain UTF-8 `.txt`.
 * No OCR — for scanned PDFs with no text layer, the output will be
 * empty. The OCR flow (`PdfOcrFlow`) handles those.
 */
export default function PdfTextExtractFlow({ file, onDone }: PdfTextExtractFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const { busy, begin } = useWorkspaceOperation();
  const [error, setError] = useState<string | null>(null);

  async function handleApply() {
    if (busy) return;
    const finish = begin();
    if (!finish) return;
    setError(null);
    try {
      const dest = await save({
        defaultPath: `${stemOf(file)}.txt`,
        title: "Save extracted text",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!dest) {
        return;
      }
      await api.pdf.run(pdfExtractText(file, dest));
      enqueueToast({ variant: "success", title: "PDF text extract queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      finish();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted">
        Saves the PDF&rsquo;s existing text layer to a <code>.txt</code> file. Scanned
        PDFs without a text layer come out empty &mdash; use OCR for those.
      </p>
      <div className="flex items-center gap-3 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Extract text"}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}
