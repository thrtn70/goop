import WorkspaceFrame from "@/components/workspace/WorkspaceFrame";
import WorkspaceInspector from "@/components/workspace/WorkspaceInspector";
import WorkspaceList from "@/components/workspace/WorkspaceList";
import SourceRow, { sourceName } from "@/features/workspace/SourceRow";
import {
  newIdentity,
  reconcileSubmitted,
  type SubmissionReceipt,
} from "@/features/workspace/entries";
import { useSourceInspections, PROBING } from "@/hooks/useSourceInspections";
import { WorkspaceDraftProvider } from "@/store/workspaceDrafts";
import { claimWorkspaceFilePicker } from "@/store/workspaceDrafts";
import { forgetWorkspaceSource } from "@/store/workspaceDrafts";
import { withWorkspaceDrafts } from "@/store/workspaceDrafts";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { useCallback, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import DropZone from "@/features/convert/DropZone";
import { compressionProblem } from "@/features/workspace/readiness";
import {
  CompressSettingsPanel,
  defaultMode,
} from "@/features/compress/CompressFileRow";
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
    tiff: "tiff",
    tif: "tiff",
    avif: "avif",
    jxl: "jpeg_xl",
  };
  return map[ext] ?? "mp4";
}

function CompressPage() {
  const location = useLocation();
  const [files, setFiles] = useWorkspaceDraftState<CompressFileEntry[]>(
    "CompressPage.files",
    [],
  );
  const [pdfs, setPdfs] = useWorkspaceDraftState<string[]>(
    "CompressPage.pdfs",
    [],
  );
  const [selectedId, setSelectedId] = useWorkspaceDraftState<string | null>(
    "CompressPage.selectedId",
    null,
  );
  const { byId, retry } = useSourceInspections(files);
  useEffect(() => {
    if (files.some((f) => !f.id))
      setFiles((previous) =>
        previous.map((f) => (f.id ? f : { ...f, ...newIdentity() })),
      );
  }, [files, setFiles]);
  const selected = files.find((f) => f.id === selectedId) ?? files[0];
  const selectedState = byId[selected?.id ?? ""] ?? PROBING;
  useEffect(() => {
    if (selected?.id !== selectedId) setSelectedId(selected?.id ?? null);
  }, [selected?.id, selectedId, setSelectedId]);
  useEffect(() => {
    setFiles((previous) => {
      let changed = false;
      const next = previous.map((f) => {
        const state = byId[f.id ?? ""];
        if (f.optionsReady || state?.phase !== "ready") return f;
        changed = true;
        return {
          ...f,
          revision: (f.revision ?? 0) + 1,
          optionsReady: true,
          mode: defaultMode(state.capabilities.compression),
        };
      });
      return changed ? next : previous;
    });
  }, [byId, setFiles]);
  const onSettled = useCallback(
    (success: SubmissionReceipt[]) => {
      let removed: string[] = [];
      setFiles((previous) => {
        const next = reconcileSubmitted(previous, success);
        removed = previous
          .filter((f) => !next.some((n) => n.id === f.id))
          .map((f) => f.path);
        return next;
      });
      removed.forEach((path) => forgetWorkspaceSource("compress", path));
    },
    [setFiles],
  );

  const addPaths = useCallback(
    (paths: string[]) => {
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
              ...newIdentity(),
              path: p,
              target: targetFromPath(p),
              sourceDir: dirname(p),
              mode: { kind: "quality", value: 75 },
            }));
          return [...prev, ...fresh];
        });
      }
    },
    [setFiles, setPdfs],
  );

  const handleOptionsChange = useCallback(
    (id: string, opts: CompressRowOptions) => {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === id
            ? {
                ...f,
                revision: (f.revision ?? 0) + 1,
                mode: opts.mode,
                optionsReady: true,
              }
            : f,
        ),
      );
    },
    [setFiles],
  );

  const handleRemove = useCallback(
    (path: string) => {
      const index = files.findIndex((f) => f.path === path);
      if (files[index]?.id === selectedId)
        setSelectedId(files[index + 1]?.id ?? files[index - 1]?.id ?? null);
      forgetWorkspaceSource("compress", path);
      setFiles((prev) => prev.filter((f) => f.path !== path));
    },
    [files, selectedId, setSelectedId, setFiles],
  );

  const applyPreset = useCallback(
    (preset: Preset) => {
      if (!preset.compress_mode) return;
      const mode = preset.compress_mode;
      setFiles((prev) =>
        prev.map((f) => ({
          ...f,
          revision: (f.revision ?? 0) + 1,
          mode,
          optionsReady: true,
        })),
      );
    },
    [setFiles],
  );

  const applyFirstToAll = useCallback(() => {
    setFiles((prev) => {
      if (prev.length < 2) return prev;
      const headMode = prev[0].mode;
      return prev.map((f, i) =>
        i === 0
          ? f
          : {
              ...f,
              revision: (f.revision ?? 0) + 1,
              mode: headMode,
              optionsReady: true,
            },
      );
    });
  }, [setFiles]);

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
    if (
      pickerToken > 0 &&
      location.pathname.startsWith("/compress") &&
      claimWorkspaceFilePicker(pickerToken)
    ) {
      void handleBrowse();
    }
  }, [pickerToken, handleBrowse, location.pathname]);

  const problems = files.map((f) =>
    compressionProblem(f.mode, byId[f.id ?? ""] ?? PROBING),
  );
  const blocked = problems.some(Boolean) || files.some((f) => !f.optionsReady);
  return (
    <WorkspaceFrame
      title="Compress"
      description="Smaller files, with settings that fit the source."
      toolbar={
        <button
          type="button"
          onClick={() => void handleBrowse()}
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg"
        >
          Add files
        </button>
      }
      outputSummary={
        <p className="text-sm text-fg-secondary">
          {files.length} media file{files.length === 1 ? "" : "s"} ·{" "}
          {files.length === 1
            ? "Choose a destination when you start."
            : "Outputs go beside each source unless you choose a folder."}
        </p>
      }
      inspector={
        <WorkspaceInspector
          title="Compression"
          description={
            selected
              ? "Editing " + sourceName(selected.path)
              : "Select a source to get started."
          }
          actions={
            <CompressActionBar
              files={files}
              disabled={blocked}
              onEnqueued={() => {}}
              onSettled={onSettled}
              onApplyToAll={applyFirstToAll}
            />
          }
        >
          {selected &&
          selectedState.phase === "ready" &&
          selected.optionsReady ? (
            <WorkspaceDraftProvider scope={["source", selected.path]}>
              <CompressSettingsPanel
                state={selectedState}
                mode={selected.mode}
                onChange={(mode) =>
                  selected.id && handleOptionsChange(selected.id, { mode })
                }
              />
            </WorkspaceDraftProvider>
          ) : (
            <p className="text-sm text-fg-secondary">
              {selectedState.phase === "error"
                ? selectedState.message
                : selected
                  ? "Inspecting source…"
                  : "Add files or drop them into the source list."}
            </p>
          )}
          {blocked && files.length > 0 && (
            <p className="mt-4 text-xs text-warning">
              Review the source list before starting. Every file needs supported
              settings.
            </p>
          )}
        </WorkspaceInspector>
      }
    >
      <DropZone onFiles={addPaths}>
        <div className="px-4 py-5 text-sm text-fg-secondary">
          {files.length || pdfs.length
            ? "Drop more files here."
            : "Drop video, audio, images, or PDFs here."}{" "}
          <button
            type="button"
            onClick={() => void handleBrowse()}
            className="text-accent underline"
          >
            Pick from your computer
          </button>
        </div>
      </DropZone>
      {files.length > 0 && (
        <div className="py-4">
          <PresetChips kind="compress" onApply={applyPreset} />
        </div>
      )}
      <WorkspaceList label="Sources">
        <ul>
          {files.map((f, i) => (
            <SourceRow
              key={f.id ?? f.path}
              path={f.path}
              selected={f.id === selected?.id}
              state={byId[f.id ?? ""] ?? PROBING}
              problem={problems[i]}
              edited={f.submittedEdit}
              onSelect={() => setSelectedId(f.id ?? null)}
              onRemove={() => handleRemove(f.path)}
              onRetry={() => f.id && retry(f.id)}
            />
          ))}
        </ul>
      </WorkspaceList>
      {pdfs.length > 0 && (
        <section aria-label="PDF operations" className="mt-4">
          <PdfFlow
            files={pdfs}
            onFilesChanged={(next) => {
              pdfs
                .filter((path) => !next.includes(path))
                .forEach((path) => forgetWorkspaceSource("compress", path));
              setPdfs(next);
            }}
            onDone={() => setPdfs([])}
            defaultOp="compress"
          />
        </section>
      )}
    </WorkspaceFrame>
  );
}

export default withWorkspaceDrafts(CompressPage, "compress");
