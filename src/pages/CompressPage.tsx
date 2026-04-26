import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import DropZone from "@/features/convert/DropZone";
import MediaBlob from "@/features/convert/MediaBlob";
import CompressFileRow from "@/features/compress/CompressFileRow";
import type { CompressRowOptions } from "@/features/compress/CompressFileRow";
import CompressActionBar from "@/features/compress/CompressActionBar";
import type { CompressFileEntry } from "@/features/compress/CompressActionBar";
import PresetChips from "@/features/presets/PresetChips";
import PdfFlow from "@/features/pdf/PdfFlow";
import { useAppStore } from "@/store/appStore";
import type { Preset, TargetFormat } from "@/types";

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const last = normalized.lastIndexOf("/");
  return last > 0 ? normalized.slice(0, last) : ".";
}

function isPdf(p: string): boolean {
  return p.toLowerCase().endsWith(".pdf");
}

/**
 * Guess the target format from a file extension. Compress keeps the source
 * format — this is just for the output filename. The backend verifies.
 */
function targetFromPath(path: string): TargetFormat {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, TargetFormat> = {
    mp4: "mp4",
    m4v: "mp4",
    mkv: "mkv",
    webm: "webm",
    avi: "avi",
    mov: "mov",
    mp3: "mp3",
    m4a: "m4a",
    opus: "opus",
    wav: "wav",
    flac: "flac",
    ogg: "ogg",
    aac: "aac",
    png: "png",
    jpg: "jpeg",
    jpeg: "jpeg",
    webp: "webp",
    bmp: "bmp",
  };
  return map[ext] ?? "mp4";
}

export default function CompressPage() {
  const location = useLocation();
  const [files, setFiles] = useState<CompressFileEntry[]>([]);
  const [pdfs, setPdfs] = useState<string[]>([]);

  const addPaths = useCallback((paths: string[]) => {
    const pdfPaths = paths.filter(isPdf);
    const mediaPaths = paths.filter((p) => !isPdf(p));
    if (pdfPaths.length > 0) {
      setPdfs((prev) => {
        const existing = new Set(prev);
        return [...prev, ...pdfPaths.filter((p) => !existing.has(p))];
      });
    }
    if (mediaPaths.length > 0) {
      setFiles((prev) => {
        const existing = new Set(prev.map((f) => f.path));
        const fresh: CompressFileEntry[] = mediaPaths
          .filter((p) => !existing.has(p))
          .map((p) => ({
            path: p,
            target: targetFromPath(p),
            sourceDir: dirname(p),
            mode: { kind: "quality", value: 75 },
          }));
        return [...prev, ...fresh];
      });
    }
  }, []);

  const handleOptionsChange = useCallback(
    (path: string, opts: CompressRowOptions) => {
      setFiles((prev) =>
        prev.map((f) => (f.path === path ? { ...f, mode: opts.mode } : f)),
      );
    },
    [],
  );

  const handleRemove = useCallback((path: string) => {
    setFiles((prev) => prev.filter((f) => f.path !== path));
  }, []);

  const applyPreset = useCallback((preset: Preset) => {
    if (!preset.compress_mode) return;
    const mode = preset.compress_mode;
    setFiles((prev) => prev.map((f) => ({ ...f, mode })));
  }, []);

  const applyFirstToAll = useCallback(() => {
    setFiles((prev) => {
      if (prev.length < 2) return prev;
      const headMode = prev[0].mode;
      return prev.map((f, i) => (i === 0 ? f : { ...f, mode: headMode }));
    });
  }, []);

  const handleBrowse = useCallback(async () => {
    const picked = await open({
      multiple: true,
      title: "Select files to compress",
    });
    if (picked) {
      const paths = Array.isArray(picked) ? picked : [picked];
      addPaths(paths.filter((p): p is string => typeof p === "string"));
    }
  }, [addPaths]);

  // Phase H: Cmd+O increments `pendingFilePicker`. Only fire when this
  // page is the active route — guards against double-fire if a future
  // animated route transition keeps both Convert and Compress mounted
  // briefly.
  const pickerToken = useAppStore((s) => s.pendingFilePicker);
  useEffect(() => {
    if (pickerToken > 0 && location.pathname.startsWith("/compress")) {
      void handleBrowse();
    }
  }, [pickerToken, handleBrowse, location.pathname]);

  const hasFiles = files.length > 0;
  const hasPdfs = pdfs.length > 0;

  return (
    <div className="flex h-full flex-col p-6">
      <DropZone onFiles={addPaths}>
        {!hasFiles && !hasPdfs && (
          <div className="enter-up flex flex-col items-center justify-center px-6 py-14 text-center">
            <MediaBlob size={108} />
            <p className="mt-5 font-display text-base font-semibold text-fg">
              Drop something here.
            </p>
            <p className="mt-1.5 text-sm text-fg-secondary">
              Smaller files, same format. Video, audio, images, and PDFs.{" "}
              <button
                type="button"
                onClick={() => void handleBrowse()}
                className="text-accent underline-offset-2 transition duration-fast ease-out hover:text-accent-hover hover:underline"
              >
                Pick from your computer
              </button>
              .
            </p>
            <p className="sr-only">Examples of supported compressions:</p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-1.5">
              {["1080p MP4 → 720p", "MP3 → smaller MP3", "PNG → web JPG", "PDF → smaller PDF"].map((label) => (
                <span
                  key={label}
                  className="rounded-full border border-subtle bg-surface-1 px-2.5 py-1 font-mono text-[10px] tracking-tight text-fg-muted"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        )}
        {hasFiles && (
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

      {hasPdfs && (
        <div className="mt-3">
          <PdfFlow
            files={pdfs}
            onFilesChanged={setPdfs}
            onDone={() => setPdfs([])}
            defaultOp="compress"
          />
        </div>
      )}

      {hasFiles && (
        <div className="mt-3">
          <PresetChips kind="compress" onApply={applyPreset} />
        </div>
      )}

      {hasFiles && (
        <div className="mt-2 flex flex-1 flex-col gap-2 overflow-auto">
          {files.map((f, i) => (
            <CompressFileRow
              key={f.path}
              path={f.path}
              index={i}
              onOptionsChange={handleOptionsChange}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}

      {hasFiles && (
        <div className="mt-4 border-t border-subtle pt-4">
          <CompressActionBar
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
