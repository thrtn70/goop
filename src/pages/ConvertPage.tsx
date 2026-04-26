import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import DropZone from "@/features/convert/DropZone";
import FileRow from "@/features/convert/FileRow";
import type { FileRowOptions } from "@/features/convert/FileRow";
import ConvertActionBar from "@/features/convert/ConvertActionBar";
import type { FileEntry } from "@/features/convert/ConvertActionBar";
import PresetChips from "@/features/presets/PresetChips";
import PdfFlow from "@/features/pdf/PdfFlow";
import type { Preset, TargetFormat } from "@/types";

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const last = normalized.lastIndexOf("/");
  return last > 0 ? normalized.slice(0, last) : ".";
}

function isPdf(p: string): boolean {
  return p.toLowerCase().endsWith(".pdf");
}

export default function ConvertPage() {
  const location = useLocation();
  const nav = useNavigate();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [pdfs, setPdfs] = useState<string[]>([]);

  // Convert-again from the History preview lands here with location.state.
  // Seed a FileRow from the pre-fill so the user arrives ready-to-edit.
  useEffect(() => {
    const state = location.state as { prefill?: { path: string } } | null;
    if (!state?.prefill?.path) return;
    const path = state.prefill.path;
    if (isPdf(path)) {
      setPdfs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    } else {
      setFiles((prev) =>
        prev.some((f) => f.path === path)
          ? prev
          : [
              ...prev,
              {
                path,
                target: "mp4" as TargetFormat,
                sourceDir: dirname(path),
                gifOptions: null,
              },
            ],
      );
    }
    // Clear the navigation state so a back/forward doesn't re-seed.
    nav(location.pathname, { replace: true, state: null });
  }, [location, nav]);

  const addPaths = useCallback((paths: string[]) => {
    const pdfPaths = paths.filter(isPdf);
    const nonPdfPaths = paths.filter((p) => !isPdf(p));
    if (pdfPaths.length > 0) {
      setPdfs((prev) => {
        const existing = new Set(prev);
        return [...prev, ...pdfPaths.filter((p) => !existing.has(p))];
      });
    }
    if (nonPdfPaths.length > 0) {
      setFiles((prev) => {
        const existing = new Set(prev.map((f) => f.path));
        const fresh: FileEntry[] = nonPdfPaths
          .filter((p) => !existing.has(p))
          .map((p) => ({
            path: p,
            target: "mp4" as TargetFormat,
            sourceDir: dirname(p),
            gifOptions: null,
          }));
        return [...prev, ...fresh];
      });
    }
  }, []);

  const handleOptionsChange = useCallback((path: string, opts: FileRowOptions) => {
    setFiles((prev) =>
      prev.map((f) =>
        f.path === path
          ? {
              ...f,
              target: opts.target,
              gifOptions: opts.gifOptions,
            }
          : f,
      ),
    );
  }, []);

  const handleRemove = useCallback((path: string) => {
    setFiles((prev) => prev.filter((f) => f.path !== path));
  }, []);

  const applyPreset = useCallback((preset: Preset) => {
    setFiles((prev) =>
      prev.map((f) => ({
        ...f,
        target: preset.target,
      })),
    );
  }, []);

  const applyFirstToAll = useCallback(() => {
    setFiles((prev) => {
      if (prev.length < 2) return prev;
      const head = prev[0];
      return prev.map((f, i) =>
        i === 0 ? f : { ...f, target: head.target, gifOptions: head.gifOptions },
      );
    });
  }, []);

  const handleBrowse = async () => {
    const picked = await open({
      multiple: true,
      title: "Select files to convert",
    });
    if (picked) {
      const paths = Array.isArray(picked) ? picked : [picked];
      addPaths(paths.filter((p): p is string => typeof p === "string"));
    }
  };

  const hasMedia = files.length > 0;
  const hasPdfs = pdfs.length > 0;

  if (hasPdfs && !hasMedia) {
    return (
      <div className="flex h-full flex-col p-6">
        <DropZone onFiles={addPaths}>
          <div className="p-3">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs text-fg-muted">
                PDF operations — {pdfs.length} file{pdfs.length !== 1 ? "s" : ""}
              </span>
              <button
                type="button"
                onClick={() => void handleBrowse()}
                className="text-xs text-accent transition duration-fast ease-out hover:text-accent-hover"
              >
                Add more...
              </button>
            </div>
          </div>
        </DropZone>
        <div className="mt-2 flex-1 overflow-auto">
          <PdfFlow
            files={pdfs}
            onFilesChanged={setPdfs}
            onDone={() => setPdfs([])}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-6">
      <DropZone onFiles={addPaths}>
        {!hasMedia && !hasPdfs && (
          <div className="enter-up flex flex-col items-center justify-center py-12 text-center">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-fg-muted/30">
              <path d="M20 28V12M14 18l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="4" y="4" width="32" height="32" rx="6" strokeDasharray="4 3" />
            </svg>
            <p className="mt-3 text-sm text-fg-secondary">
              Drop files here, or{" "}
              <button
                type="button"
                onClick={() => void handleBrowse()}
                className="text-accent transition duration-fast ease-out hover:text-accent-hover"
              >
                pick from your computer
              </button>
              .
            </p>
            <p className="mt-1 text-xs text-fg-muted">Video, audio, images, and PDFs.</p>
          </div>
        )}
        {hasMedia && (
          <div className="p-3">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs text-fg-muted">
                {files.length} file{files.length !== 1 ? "s" : ""}
              </span>
              <button
                type="button"
                onClick={() => void handleBrowse()}
                className="text-xs text-accent transition duration-fast ease-out hover:text-accent-hover"
              >
                Add more...
              </button>
            </div>
          </div>
        )}
      </DropZone>

      {hasMedia && (
        <div className="mt-3">
          <PresetChips kind="convert" onApply={applyPreset} />
        </div>
      )}

      {hasMedia && (
        <div className="mt-2 flex flex-1 flex-col gap-2 overflow-auto">
          {files.map((f, i) => (
            <FileRow
              key={f.path}
              path={f.path}
              index={i}
              onOptionsChange={handleOptionsChange}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}

      {hasMedia && (
        <div className="mt-4 border-t border-subtle pt-4">
          <ConvertActionBar
            files={files}
            disabled={false}
            onEnqueued={() => setFiles([])}
            onApplyToAll={applyFirstToAll}
          />
        </div>
      )}
    </div>
  );
}
