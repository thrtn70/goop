import { claimWorkspaceFilePicker } from "@/store/workspaceDrafts";
import { forgetWorkspaceSource } from "@/store/workspaceDrafts";
import { withWorkspaceDrafts } from "@/store/workspaceDrafts";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { useCallback, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import DropZone from "@/features/convert/DropZone";
import FileRow, { defaultGifOptions } from "@/features/convert/FileRow";
import type { FileRowOptions } from "@/features/convert/FileRow";
import ConvertActionBar from "@/features/convert/ConvertActionBar";
import type { FileEntry } from "@/features/convert/ConvertActionBar";
import MediaBlob from "@/features/convert/MediaBlob";
import PresetChips from "@/features/presets/PresetChips";
import PdfFlow from "@/features/pdf/PdfFlow";
import RecognizeChip from "@/features/recognize/RecognizeChip";
import { useAppStore } from "@/store/appStore";
import type { MetadataPolicy, Preset, TargetFormat } from "@/types";

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const last = normalized.lastIndexOf("/");
  return last > 0 ? normalized.slice(0, last) : ".";
}

function isPdf(p: string): boolean {
  return p.toLowerCase().endsWith(".pdf");
}

function ConvertPage() {
  const location = useLocation();
  const nav = useNavigate();
  const [files, setFiles] = useWorkspaceDraftState<FileEntry[]>("ConvertPage.files", []);
  const [pdfs, setPdfs] = useWorkspaceDraftState<string[]>("ConvertPage.pdfs", []);

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
                metadataPolicy: "preserve",
                subtitle: null,
                qualityPreset: null,
                resolutionCap: null,
              },
            ],
      );
    }
    // Clear the navigation state so a back/forward doesn't re-seed.
    nav(location.pathname, { replace: true, state: null });
  }, [location, nav, setFiles, setPdfs]);

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
            metadataPolicy: "preserve" as MetadataPolicy,
            subtitle: null,
            qualityPreset: null,
            resolutionCap: null,
          }));
        return [...prev, ...fresh];
      });
    }
  }, [setFiles, setPdfs]);

  const handleOptionsChange = useCallback((path: string, opts: FileRowOptions) => {
    setFiles((prev) =>
      prev.map((f) =>
        f.path === path
          ? {
              ...f,
              optionsReady: true,
              target: opts.target,
              gifOptions: opts.gifOptions,
              metadataPolicy: opts.metadataPolicy,
              subtitle: opts.subtitle,
              qualityPreset: opts.qualityPreset ?? null,
              resolutionCap: opts.resolutionCap ?? null,
            }
          : f,
      ),
    );
  }, [setFiles]);

  const handleRemove = useCallback((path: string) => {
    forgetWorkspaceSource("convert", path);
    setFiles((prev) => prev.filter((f) => f.path !== path));
  }, [setFiles]);

  const applyPreset = useCallback((preset: Preset) => {
    setFiles((prev) =>
      prev.map((f) => ({
        ...f,
        optionsReady: true,
        target: preset.target,
        gifOptions: preset.target === "gif" ? (f.gifOptions ?? defaultGifOptions()) : null,
        // Both are Convert-register fields on the preset, and both used to
        // be dropped here — so a chip named "YouTube Upload" changed the
        // container and nothing else, leaving a 4K source 4K.
        qualityPreset: preset.quality_preset,
        resolutionCap: preset.resolution_cap,
      })),
    );
  }, [setFiles]);

  const applyFirstToAll = useCallback(() => {
    setFiles((prev) => {
      if (prev.length < 2) return prev;
      const head = prev[0];
      return prev.map((f, i) =>
        i === 0
          ? f
          : {
              // `subtitle` is deliberately not copied: it points at one
              // specific file's subtitle track, which is almost never the
              // right one for the rest of the batch.
              ...f,
              optionsReady: true,
              target: head.target,
              gifOptions: head.gifOptions,
              metadataPolicy: head.metadataPolicy,
              qualityPreset: head.qualityPreset,
              resolutionCap: head.resolutionCap,
            },
      );
    });
  }, [setFiles]);

  const handleBrowse = useCallback(async () => {
    const picked = await open({
      multiple: true,
      title: "Select files to convert",
    });
    if (picked) {
      const paths = Array.isArray(picked) ? picked : [picked];
      addPaths(paths.filter((p): p is string => typeof p === "string"));
    }
  }, [addPaths]);

  // Phase H: Cmd+O increments `pendingFilePicker`. Only fire when this
  // page is the active route — the location guard prevents both Convert
  // and Compress from triggering simultaneously if a future animated
  // route transition keeps both mounted briefly.
  const pickerToken = useAppStore((s) => s.pendingFilePicker);
  useEffect(() => {
    if (pickerToken > 0 && location.pathname.startsWith("/convert") && claimWorkspaceFilePicker(pickerToken)) {
      void handleBrowse();
    }
  }, [pickerToken, handleBrowse, location.pathname]);

  const hasMedia = files.length > 0;
  const hasPdfs = pdfs.length > 0;

  if (hasPdfs && !hasMedia) {
    return (
      <div className="flex h-full flex-col p-6">
        <DropZone onFiles={addPaths}>
          <div className="p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-xs text-fg-muted">
                PDF operations — {pdfs.length} file{pdfs.length !== 1 ? "s" : ""}
              </span>
              <div className="flex items-center gap-3">
                {pdfs.length === 1 && <RecognizeChip path={pdfs[0]} />}
                <button
                  type="button"
                  onClick={() => void handleBrowse()}
                  className="text-xs text-accent transition duration-fast ease-out hover:text-accent-hover"
                >
                  Add more...
                </button>
              </div>
            </div>
          </div>
        </DropZone>
        <div className="mt-2 flex-1 overflow-auto">
          <PdfFlow
            files={pdfs}
            onFilesChanged={next => { pdfs.filter(path => !next.includes(path)).forEach(path => forgetWorkspaceSource("convert", path)); setPdfs(next); }}
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
          <div className="enter-up flex flex-col items-center justify-center px-6 py-14 text-center">
            <MediaBlob size={108} />
            <p className="mt-5 font-display text-base font-semibold text-fg">
              Drop something here.
            </p>
            <p className="mt-1.5 text-sm text-fg-secondary">
              Video, audio, images, and PDFs — converted right on your machine.{" "}
              <button
                type="button"
                onClick={() => void handleBrowse()}
                className="text-accent underline-offset-2 transition duration-fast ease-out hover:text-accent-hover hover:underline"
              >
                Pick from your computer
              </button>
              .
            </p>
            {/* Educational chips — show what this page does at a glance.
             *  Not interactive; they read as labels, not buttons, by
             *  using <span> and reduced visual weight. The sr-only
             *  preamble anchors the chips for screen readers so they
             *  aren't read as orphaned tokens. */}
            <p className="sr-only">Examples of supported conversions:</p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-1.5">
              {["MOV → MP4", "MP4 → MP3", "PNG → JPG", "MP4 → GIF"].map((label) => (
                <span
                  key={label}
                  className="rounded-full border border-subtle bg-surface-1 px-2.5 py-1 font-mono text-xs tracking-tight text-fg-muted"
                >
                  {label}
                </span>
              ))}
            </div>
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
              options={f.optionsReady ? f : null}
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
            onEnqueued={() => { files.forEach(f => forgetWorkspaceSource("convert", f.path)); setFiles([]); }}
            onApplyToAll={applyFirstToAll}
          />
        </div>
      )}
    </div>
  );
}

export default withWorkspaceDrafts(ConvertPage, "convert");
