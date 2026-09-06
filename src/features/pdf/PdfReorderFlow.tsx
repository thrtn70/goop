import { useWorkspaceOutcomeState } from "@/store/workspaceOutcomes";
import { useWorkspaceOperation } from "@/store/workspaceOperations";
import { usePdfPageDrafts } from "./usePdfPageDrafts";
import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, pdfReorder } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import PdfPageGrid from "./PdfPageGrid";
import type { PageState } from "./PdfPageCard";

interface PdfReorderFlowProps {
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

export default function PdfReorderFlow({ file, onDone }: PdfReorderFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const { pages, setPages, loadPages } = usePdfPageDrafts("PdfReorderFlow.pages");
  const [initial, setInitial] = useState<PageState[]>([]);
  const [loading, setLoading] = useState(true);
  const { busy, begin } = useWorkspaceOperation();
  const [error, setError] = useWorkspaceOutcomeState<string | null>("PdfReorderFlow.error", null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void Promise.all([api.pdf.probe(file), api.pdf.pageThumbs(file).catch(() => [] as string[])])
      .then(([probe, thumbs]) => {
        if (cancelled) return;
        const total = Number(probe.pages);
        const initialState: PageState[] = Array.from({ length: total }, (_, i) => ({
          originalPage: i + 1,
          thumbPath: thumbs[i] ?? null,
          deleted: false,
          rotation: null,
        }));
        loadPages(initialState);
        setInitial(initialState);
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
  }, [file, loadPages, setError]);

  const dirty = pages.some((p, idx) => p.originalPage !== initial[idx]?.originalPage);

  async function handleApply() {
    if (!dirty || pages.length === 0) return;
    const finish = begin();
    if (!finish) return;
    setError(null);
    try {
      const dest = await save({
        defaultPath: `${stemOf(file)}-reordered.pdf`,
        title: "Save reordered PDF",
      });
      if (!dest) {
        return;
      }
      const order = pages.map((p) => p.originalPage);
      await api.pdf.run(pdfReorder(file, order, dest));
      enqueueToast({ variant: "success", title: "PDF reorder queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      finish();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {loading ? (
        <p className="text-xs text-fg-muted">Loading pages…</p>
      ) : (
        <>
          <PdfPageGrid pages={pages} onChange={setPages} mode="reorder" />
          <div className="flex items-center gap-3 border-t border-subtle pt-3">
            <button
              type="button"
              disabled={!dirty || busy}
              onClick={() => void handleApply()}
              className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Saving…" : "Apply reorder"}
            </button>
            <button
              type="button"
              disabled={!dirty || busy}
              onClick={() => setPages(initial)}
              className="btn-press rounded-md px-3 py-2 text-sm text-fg-muted transition duration-fast ease-out enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reset
            </button>
            {error && <span className="text-xs text-error">{error}</span>}
          </div>
        </>
      )}
    </div>
  );
}
