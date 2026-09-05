import { useWorkspaceOperation } from "@/store/workspaceOperations";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Plus, X } from "lucide-react";
import { api, pdfInsertBlank } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";

interface PdfInsertBlankFlowProps {
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

export default function PdfInsertBlankFlow({ file, onDone }: PdfInsertBlankFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [positions, setPositions] = useWorkspaceDraftState<number[]>("PdfInsertBlankFlow.positions", []);
  const [draft, setDraft] = useWorkspaceDraftState<string>("PdfInsertBlankFlow.draft", "");
  const { busy, begin } = useWorkspaceOperation();
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

  function addPosition() {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1 || n > totalPages + 1) {
      setError(`Position must be a whole number between 1 and ${totalPages + 1}.`);
      return;
    }
    setError(null);
    setPositions((prev) => [...prev, n]);
    setDraft("");
  }

  function removePosition(idx: number) {
    setPositions((prev) => prev.filter((_, i) => i !== idx));
  }

  const canApply = positions.length > 0 && !busy;

  async function handleApply() {
    if (!canApply) return;
    const finish = begin();
    if (!finish) return;
    setError(null);
    try {
      const dest = await save({
        defaultPath: `${stemOf(file)}-with-blanks.pdf`,
        title: "Save PDF with blank pages",
      });
      if (!dest) {
        return;
      }
      await api.pdf.run(pdfInsertBlank(file, positions, dest));
      enqueueToast({ variant: "success", title: "PDF insert-blank queued" });
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
        Insert a blank Letter-sized page before the given 1-indexed position.
        Position {totalPages + 1} appends after the last page. The PDF has{" "}
        {totalPages} page{totalPages === 1 ? "" : "s"} today.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={totalPages + 1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addPosition();
          }}
          aria-label={`Insert position, between 1 and ${totalPages + 1}`}
          placeholder={`1–${totalPages + 1}`}
          className="w-32 rounded-md bg-surface-2 px-3 py-2 text-sm tabular-nums text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <button
          type="button"
          onClick={addPosition}
          aria-label="Add insert position"
          className="btn-press inline-flex items-center gap-1 rounded-md bg-surface-2 px-3 py-2 text-sm text-fg-secondary transition duration-fast ease-out hover:bg-surface-3 hover:text-fg"
        >
          <Plus size={14} strokeWidth={2.5} aria-hidden="true" />
          Add position
        </button>
      </div>
      {positions.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {positions.map((p, idx) => (
            <li
              key={`${p}-${idx}`}
              className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-3 py-1 text-xs text-accent"
            >
              <span className="tabular-nums">Before page {p}</span>
              <button
                type="button"
                onClick={() => removePosition(idx)}
                aria-label={`Remove insert position before page ${p}`}
                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-accent hover:text-accent-hover"
              >
                <X size={12} strokeWidth={2.5} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={!canApply}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy
            ? "Saving…"
            : positions.length === 0
              ? "Add at least one position"
              : `Insert ${positions.length} blank page${positions.length === 1 ? "" : "s"}`}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}
