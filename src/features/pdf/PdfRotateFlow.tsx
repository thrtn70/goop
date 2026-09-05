import { useWorkspaceOperation } from "@/store/workspaceOperations";
import { usePdfPageDrafts } from "./usePdfPageDrafts";
import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, pdfRotate } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import PdfPageGrid from "./PdfPageGrid";
import type { PageState } from "./PdfPageCard";
import type { PageRotation, RotationDegrees } from "@/types";

interface PdfRotateFlowProps {
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

export default function PdfRotateFlow({ file, onDone }: PdfRotateFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const { pages, setPages, loadPages } = usePdfPageDrafts("PdfRotateFlow.pages");
  const [loading, setLoading] = useState(true);
  const { busy, begin } = useWorkspaceOperation();
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

  function rotateAll(deg: RotationDegrees) {
    setPages((prev) =>
      prev.map((p) => ({ ...p, rotation: composeAll(p.rotation, deg) })),
    );
  }

  const rotations: PageRotation[] = pages
    .filter((p): p is PageState & { rotation: RotationDegrees } => p.rotation !== null)
    .map((p) => ({ page: p.originalPage, rotation: p.rotation }));
  const canApply = rotations.length > 0 && !busy;

  async function handleApply() {
    if (!canApply) return;
    const finish = begin();
    if (!finish) return;
    setError(null);
    try {
      const dest = await save({
        defaultPath: `${stemOf(file)}-rotated.pdf`,
        title: "Save rotated PDF",
      });
      if (!dest) {
        return;
      }
      await api.pdf.run(pdfRotate(file, rotations, dest));
      enqueueToast({ variant: "success", title: "PDF rotate queued" });
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
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-fg-muted">Rotate all:</span>
            <button
              type="button"
              onClick={() => rotateAll("cw90")}
              className="btn-press rounded-md bg-surface-2 px-3 py-1.5 text-fg-secondary transition duration-fast ease-out hover:bg-surface-3 hover:text-fg"
            >
              90° CW
            </button>
            <button
              type="button"
              onClick={() => rotateAll("cw180")}
              className="btn-press rounded-md bg-surface-2 px-3 py-1.5 text-fg-secondary transition duration-fast ease-out hover:bg-surface-3 hover:text-fg"
            >
              180°
            </button>
            <button
              type="button"
              onClick={() => rotateAll("cw270")}
              className="btn-press rounded-md bg-surface-2 px-3 py-1.5 text-fg-secondary transition duration-fast ease-out hover:bg-surface-3 hover:text-fg"
            >
              90° CCW
            </button>
          </div>
          <PdfPageGrid pages={pages} onChange={setPages} mode="rotate" />
          <div className="flex items-center gap-3 border-t border-subtle pt-3">
            <button
              type="button"
              disabled={!canApply}
              onClick={() => void handleApply()}
              className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy
                ? "Saving…"
                : rotations.length === 0
                  ? "Click rotate on a page"
                  : `Apply ${rotations.length} rotation${rotations.length === 1 ? "" : "s"}`}
            </button>
            {error && <span className="text-xs text-error">{error}</span>}
          </div>
        </>
      )}
    </div>
  );
}

function composeAll(
  current: RotationDegrees | null,
  add: RotationDegrees,
): RotationDegrees | null {
  const startDeg = current === null ? 0 : degForRotation(current);
  const addDeg = degForRotation(add);
  const total = (startDeg + addDeg) % 360;
  if (total === 0) return null;
  if (total === 90) return "cw90";
  if (total === 180) return "cw180";
  return "cw270";
}

function degForRotation(r: RotationDegrees): number {
  switch (r) {
    case "cw90":
      return 90;
    case "cw180":
      return 180;
    case "cw270":
      return 270;
  }
}
