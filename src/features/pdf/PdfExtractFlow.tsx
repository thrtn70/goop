import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, pdfExtractPages } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import PdfSplitEditor from "./PdfSplitEditor";
import type { PageRange } from "@/types";

interface PdfExtractFlowProps {
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

export default function PdfExtractFlow({ file, onDone }: PdfExtractFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [ranges, setRanges] = useState<PageRange[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.pdf
      .probe(file)
      .then((r) => {
        if (!cancelled) setTotalPages(Number(r.pages));
      })
      .catch((e) => {
        if (!cancelled) setError(formatError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const canApply = ranges.length > 0 && !busy;

  async function handleApply() {
    if (!canApply) return;
    setBusy(true);
    setError(null);
    try {
      const dest = await save({
        defaultPath: `${stemOf(file)}-extracted.pdf`,
        title: "Save extracted PDF",
      });
      if (!dest) {
        setBusy(false);
        return;
      }
      await api.pdf.run(pdfExtractPages(file, ranges, dest));
      enqueueToast({ variant: "success", title: "PDF extract queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <PdfSplitEditor totalPages={totalPages} ranges={ranges} onChange={setRanges} />
      <div className="flex items-center gap-3 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={!canApply}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Extract to single PDF"}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}
