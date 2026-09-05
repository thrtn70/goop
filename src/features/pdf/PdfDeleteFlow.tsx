import { usePdfPageDrafts } from "./usePdfPageDrafts";
import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, pdfDeletePages } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import PdfPageGrid from "./PdfPageGrid";

interface PdfDeleteFlowProps {
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

export default function PdfDeleteFlow({ file, onDone }: PdfDeleteFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const { pages, setPages, loadPages } = usePdfPageDrafts("PdfDeleteFlow.pages");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([api.pdf.probe(file), api.pdf.pageThumbs(file).catch(() => [] as string[])])
      .then(([probe, thumbs]) => {
        if (cancelled) return;
        const total = Number(probe.pages);
        loadPages(
          Array.from({ length: total }, (_, i) => ({
            originalPage: i + 1,
            thumbPath: thumbs[i] ?? null,
            deleted: false,
            rotation: null,
          })),
        );
      })
      .catch((e) => {
        if (!cancelled) setError(formatError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file, loadPages]);

  const toDelete = pages.filter((p) => p.deleted).map((p) => p.originalPage);
  const wouldEmpty = toDelete.length > 0 && toDelete.length === pages.length;
  const canApply = toDelete.length > 0 && !wouldEmpty && !busy;

  async function handleApply() {
    if (!canApply) return;
    setBusy(true);
    setError(null);
    try {
      const dest = await save({
        defaultPath: `${stemOf(file)}-trimmed.pdf`,
        title: "Save trimmed PDF",
      });
      if (!dest) {
        setBusy(false);
        return;
      }
      await api.pdf.run(pdfDeletePages(file, toDelete, dest));
      enqueueToast({ variant: "success", title: "PDF delete queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {loading ? (
        <p className="text-xs text-fg-muted">Loading pages…</p>
      ) : (
        <>
          <PdfPageGrid pages={pages} onChange={setPages} mode="delete" />
          <div className="flex items-center gap-3 border-t border-subtle pt-3">
            <button
              type="button"
              disabled={!canApply}
              onClick={() => void handleApply()}
              className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy
                ? "Saving…"
                : toDelete.length === 0
                  ? "Mark pages to delete"
                  : `Delete ${toDelete.length} page${toDelete.length === 1 ? "" : "s"}`}
            </button>
            {wouldEmpty && (
              <span className="text-xs text-error">
                That would delete every page. Keep at least one.
              </span>
            )}
            {error && <span className="text-xs text-error">{error}</span>}
          </div>
        </>
      )}
    </div>
  );
}
