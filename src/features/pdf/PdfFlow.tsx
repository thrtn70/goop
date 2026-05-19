import { useEffect, useState } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import PdfOperationPicker, { type PdfOperationKind } from "./PdfOperationPicker";
import PdfMergeList from "./PdfMergeList";
import PdfSplitEditor from "./PdfSplitEditor";
import PdfCompressPicker from "./PdfCompressPicker";
import PdfReorderFlow from "./PdfReorderFlow";
import PdfDeleteFlow from "./PdfDeleteFlow";
import PdfRotateFlow from "./PdfRotateFlow";
import PdfExtractFlow from "./PdfExtractFlow";
import PdfInsertBlankFlow from "./PdfInsertBlankFlow";
import PdfMetadataForm from "./PdfMetadataForm";
import PdfTextExtractFlow from "./PdfTextExtractFlow";
import PdfToImagesFlow from "./PdfToImagesFlow";
import ImagesToPdfFlow from "./ImagesToPdfFlow";
import PdfOcrFlow from "./PdfOcrFlow";
import { api, pdfCompress, pdfMerge, pdfSplit } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { PageRange, PdfQuality } from "@/types";

interface PdfFlowProps {
  files: string[];
  onFilesChanged: (files: string[]) => void;
  onDone: () => void;
  /** Initial operation. Useful when the host page implies the action
   *  (e.g. CompressPage routes PDFs in here with `compress` preselected). */
  defaultOp?: PdfOperationKind;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
}

function stemOf(p: string): string {
  const name = basename(p);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const last = normalized.lastIndexOf("/");
  return last > 0 ? normalized.slice(0, last) : ".";
}

/**
 * Wraps the three PDF operations into one flow. Detects whether the user
 * has a single file (Split/Compress available) or multiple (Merge only),
 * probes the single file to learn its page count, then hands the user a
 * picker + operation-specific sub-form + a primary action button.
 */
export default function PdfFlow({
  files,
  onFilesChanged,
  onDone,
  defaultOp = "merge",
}: PdfFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  // Resolve the initial op against the multi-file constraint so a host page
  // that requests `compress` for two PDFs doesn't silently flip to `merge`
  // on the first render via the auto-switch effect below. images_to_pdf
  // also accepts multi-file (in fact it ignores the dropped PDFs entirely
  // and uses its own image picker), so it's treated alongside merge.
  const initialOp: PdfOperationKind =
    files.length > 1 && defaultOp !== "merge" && defaultOp !== "images_to_pdf"
      ? "merge"
      : defaultOp;
  const [op, setOp] = useState<PdfOperationKind>(initialOp);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [ranges, setRanges] = useState<PageRange[]>([]);
  const [quality, setQuality] = useState<PdfQuality>("ebook");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const multiFile = files.length > 1;

  // Auto-switch operation when the file count changes so we never land in
  // an illegal state. merge + images_to_pdf accept multi-file selections;
  // everything else needs a single PDF.
  useEffect(() => {
    if (multiFile && op !== "merge" && op !== "images_to_pdf") setOp("merge");
  }, [multiFile, op]);

  // Probe the single file to get the page count for the split editor.
  useEffect(() => {
    let cancelled = false;
    if (files.length !== 1) {
      setTotalPages(0);
      return;
    }
    void api.pdf
      .probe(files[0])
      .then((res) => {
        if (!cancelled) setTotalPages(Number(res.pages));
      })
      .catch((e) => {
        if (!cancelled) setError(formatError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [files]);

  async function handleRun() {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // handleRun is only invoked when op is merge/split/compress — the
      // new v0.2.3 ops own their own Apply buttons inside their flow
      // components. The explicit else-if + final no-op else keeps the
      // dispatch exhaustive against the union; if a future op is added
      // here without an arm, this returns rather than silently flowing
      // into compress.
      if (op === "merge") {
        const dest = await save({
          defaultPath: `${stemOf(files[0])}-merged.pdf`,
          title: "Save merged PDF",
        });
        if (!dest) {
          setBusy(false);
          return;
        }
        await api.pdf.run(pdfMerge(files, dest));
      } else if (op === "split") {
        if (ranges.length === 0) {
          setError("Enter at least one page range.");
          setBusy(false);
          return;
        }
        const dir = await open({ directory: true, title: "Choose output folder" });
        const outDir = typeof dir === "string" ? dir : dirname(files[0]);
        await api.pdf.run(pdfSplit(files[0], ranges, outDir));
      } else if (op === "compress") {
        const dest = await save({
          defaultPath: `${stemOf(files[0])}-compressed.pdf`,
          title: "Save compressed PDF",
        });
        if (!dest) {
          setBusy(false);
          return;
        }
        await api.pdf.run(pdfCompress(files[0], dest, quality));
      } else {
        setBusy(false);
        return;
      }
      enqueueToast({ variant: "success", title: `PDF ${op} queued` });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  const canRun =
    files.length > 0 &&
    !busy &&
    !(op === "split" && ranges.length === 0) &&
    (op !== "split" || totalPages > 0);

  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="text-xs text-fg-muted">
        {files.length} PDF{files.length !== 1 ? "s" : ""}
      </div>

      {op === "merge" ? (
        <PdfMergeList
          files={files}
          onReorder={onFilesChanged}
          onRemove={(p) => onFilesChanged(files.filter((f) => f !== p))}
        />
      ) : (
        <ul className="flex flex-col gap-1 text-sm text-fg-secondary">
          {files.map((p) => (
            <li
              key={p}
              className="flex items-center gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-2"
            >
              <span className="flex-1 truncate text-fg" title={p}>
                {basename(p)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2">
        <PdfOperationPicker selected={op} onSelect={setOp} multiFile={multiFile} />
      </div>

      {op === "split" && files.length === 1 && (
        <PdfSplitEditor totalPages={totalPages} ranges={ranges} onChange={setRanges} />
      )}
      {op === "compress" && files.length === 1 && (
        <PdfCompressPicker selected={quality} onSelect={setQuality} />
      )}

      {/* The new v0.2.3 ops each own their own internal save dialog +
          Apply button (state machines too distinct from merge/split/
          compress to share the bottom action row). They render
          inline below the picker and hide the merge/split/compress
          run button by virtue of being non-null. */}
      {files.length === 1 && op === "reorder" && (
        <PdfReorderFlow file={files[0]} onDone={onDone} />
      )}
      {files.length === 1 && op === "delete_pages" && (
        <PdfDeleteFlow file={files[0]} onDone={onDone} />
      )}
      {files.length === 1 && op === "rotate" && (
        <PdfRotateFlow file={files[0]} onDone={onDone} />
      )}
      {files.length === 1 && op === "extract_pages" && (
        <PdfExtractFlow file={files[0]} onDone={onDone} />
      )}
      {files.length === 1 && op === "insert_blank" && (
        <PdfInsertBlankFlow file={files[0]} onDone={onDone} />
      )}
      {files.length === 1 && op === "set_metadata" && (
        <PdfMetadataForm file={files[0]} onDone={onDone} />
      )}
      {files.length === 1 && op === "extract_text" && (
        <PdfTextExtractFlow file={files[0]} onDone={onDone} />
      )}
      {files.length === 1 && op === "extract_images" && (
        <PdfToImagesFlow file={files[0]} onDone={onDone} />
      )}
      {op === "images_to_pdf" && <ImagesToPdfFlow onDone={onDone} />}
      {files.length === 1 && op === "pdf_ocr" && (
        <PdfOcrFlow file={files[0]} onDone={onDone} />
      )}

      {(op === "merge" || op === "split" || op === "compress") && (
        <div className="mt-2 flex items-center gap-3 border-t border-subtle pt-4">
          <button
            type="button"
            disabled={!canRun}
            onClick={() => void handleRun()}
            className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy
              ? "Running..."
              : op === "merge"
                ? "Merge PDFs"
                : op === "split"
                  ? "Split PDF"
                  : "Compress PDF"}
          </button>
          {error && <span className="text-xs text-error">{error}</span>}
        </div>
      )}
    </div>
  );
}
