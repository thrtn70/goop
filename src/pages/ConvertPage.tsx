import SettingsPreview from "@/features/preview/SettingsPreview";
import RecognizeChip from "@/features/recognize/RecognizeChip";
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
import { readHandoff } from "@/features/workspace/handoff";
import { useLocation, useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import DropZone from "@/features/convert/DropZone";
import {
  ConvertSettingsPanel,
  defaultGifOptions,
} from "@/features/convert/FileRow";
import type { FileRowOptions } from "@/features/convert/FileRow";
import ConvertActionBar from "@/features/convert/ConvertActionBar";
import type { FileEntry } from "@/features/convert/ConvertActionBar";
import { smartDefault } from "@/features/convert/TargetPicker";
import { conversionProblem } from "@/features/workspace/readiness";
import PresetChips from "@/features/presets/PresetChips";
import PdfFlow from "@/features/pdf/PdfFlow";

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
  const [files, setFiles] = useWorkspaceDraftState<FileEntry[]>(
    "ConvertPage.files",
    [],
  );
  const [pdfs, setPdfs] = useWorkspaceDraftState<string[]>(
    "ConvertPage.pdfs",
    [],
  );
  const [selectedId, setSelectedId] = useWorkspaceDraftState<string | null>(
    "ConvertPage.selectedId",
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
  const policy =
    useAppStore((s) => s.settings?.default_metadata_policy) ?? "preserve";
  useEffect(() => {
    setFiles((previous) => {
      let changed = false;
      const next = previous.map((f) => {
        const state = byId[f.id ?? ""];
        if (f.optionsReady || state?.phase !== "ready") return f;
        changed = true;
        const target = smartDefault(state.probe);
        return {
          ...f,
          revision: (f.revision ?? 0) + 1,
          optionsReady: true,
          target,
          gifOptions: target === "gif" ? defaultGifOptions() : null,
          metadataPolicy: policy,
        };
      });
      return changed ? next : previous;
    });
  }, [byId, policy, setFiles]);
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
      removed.forEach((path) => forgetWorkspaceSource("convert", path));
    },
    [setFiles],
  );

  // Convert-again from the History preview lands here with location.state.
  // Seed a FileRow from the pre-fill so the user arrives ready-to-edit.
  useEffect(() => {
    const state = location.state as { prefill?: { path: string } } | null;
    const handoff = readHandoff(location.state, "convert");
    const path = handoff?.path ?? state?.prefill?.path;
    if (typeof path !== "string" || !path) return;
    if (isPdf(path)) {
      setPdfs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    } else {
      const identity = newIdentity();
      setSelectedId(files.find(f => f.path === path)?.id ?? identity.id);
      setFiles((prev) =>
        prev.some((f) => f.path === path)
          ? prev
          : [
              ...prev,
              {
                ...identity,
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
  }, [location, nav, setFiles, setPdfs, setSelectedId, files]);

  const addPaths = useCallback(
    (paths: string[]) => {
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
              ...newIdentity(),
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
    },
    [setFiles, setPdfs],
  );

  // Partial text is still a newer edit, even before blur commits request fields.
  const handleDraftEdit = useCallback(
    (id: string) => {
      setFiles((previous) =>
        previous.map((file) =>
          file.id === id
            ? { ...file, revision: (file.revision ?? 0) + 1 }
            : file,
        ),
      );
    },
    [setFiles],
  );

  const handleOptionsChange = useCallback(
    (id: string, opts: FileRowOptions) => {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === id
            ? {
                ...f,
                revision: (f.revision ?? 0) + 1,
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
    },
    [setFiles],
  );

  const handleRemove = useCallback(
    (path: string) => {
      const index = files.findIndex((f) => f.path === path);
      if (files[index]?.id === selectedId)
        setSelectedId(files[index + 1]?.id ?? files[index - 1]?.id ?? null);
      forgetWorkspaceSource("convert", path);
      setFiles((prev) => prev.filter((f) => f.path !== path));
    },
    [files, selectedId, setSelectedId, setFiles],
  );

  const applyPreset = useCallback(
    (preset: Preset) => {
      setFiles((prev) =>
        prev.map((f) => ({
          ...f,
          revision: (f.revision ?? 0) + 1,
          optionsReady: true,
          target: preset.target,
          gifOptions:
            preset.target === "gif"
              ? (preset.gif_options ?? defaultGifOptions())
              : null,
          // Both are Convert-register fields on the preset, and both used to
          // be dropped here — so a chip named "YouTube Upload" changed the
          // container and nothing else, leaving a 4K source 4K.
          metadataPolicy: preset.metadata_policy ?? "preserve",
          subtitle: preset.subtitle ?? null,
          qualityPreset: preset.quality_preset,
          resolutionCap: preset.resolution_cap,
        })),
      );
    },
    [setFiles],
  );

  const applyFirstToAll = useCallback(() => {
    setFiles((prev) => {
      if (prev.length < 2) return prev;
      const head = prev[0];
      return prev.map((f, i) =>
        i === 0
          ? f
          : {
              ...f,
              revision: (f.revision ?? 0) + 1,
              optionsReady: true,
              target: head.target,
              gifOptions: head.gifOptions,
              subtitle: head.subtitle,
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
    if (
      pickerToken > 0 &&
      location.pathname.startsWith("/convert") &&
      claimWorkspaceFilePicker(pickerToken)
    ) {
      void handleBrowse();
    }
  }, [pickerToken, handleBrowse, location.pathname]);

  const problems = files.map((f) =>
    conversionProblem(f, byId[f.id ?? ""] ?? PROBING),
  );
  const blocked = problems.some(Boolean) || files.some((f) => !f.optionsReady);
  return (
    <WorkspaceFrame
      title="Convert"
      description="Choose a format for each source."
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
          title="Output settings"
          description={
            selected
              ? "Editing " + sourceName(selected.path)
              : "Select a source to get started."
          }
          actions={
            <ConvertActionBar
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
              <ConvertSettingsPanel
                onDraftEdit={() => selected.id && handleDraftEdit(selected.id)}
                path={selected.path}
                options={selected}
                state={selectedState}
                onOptionsChange={(_, opts) =>
                  selected.id && handleOptionsChange(selected.id, opts)
                }
              />
              <SettingsPreview request={{input_path:selected.path,target:selected.target,
                quality_preset:selected.qualityPreset,resolution_cap:selected.resolutionCap,
                compress_mode:null,metadata_policy:selected.metadataPolicy,
                subtitle:selected.subtitle,gif_options:selected.gifOptions}}/>
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
      {files.length === 0 && pdfs.length === 0 && (
        <DropZone onFiles={addPaths}>
          <div className="px-4 py-5 text-sm text-fg-secondary">
            {files.length || pdfs.length
              ? "Drop more files here."
              : "Drop something here. Video, audio, images, and PDFs."}{" "}
            <button
              type="button"
              onClick={() => void handleBrowse()}
              className="text-accent underline"
            >
              Pick from your computer
            </button>
          </div>
        </DropZone>
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
          {pdfs.length === 1 && <RecognizeChip path={pdfs[0]} />}
          <PdfFlow
            files={pdfs}
            onFilesChanged={(next) => {
              pdfs
                .filter((path) => !next.includes(path))
                .forEach((path) => forgetWorkspaceSource("convert", path));
              setPdfs(next);
            }}
            onDone={() => setPdfs(current => current.filter(path => !pdfs.includes(path)))}
          />
        </section>
      )}
      {files.length > 0 && (
        <div className="py-4">
          <PresetChips kind="convert" onApply={applyPreset} />
        </div>
      )}
      {(files.length > 0 || pdfs.length > 0) && (
        <DropZone compact onFiles={addPaths}>
          <div className="px-3 py-2 text-sm text-fg-secondary">
            Drop more files here.{" "}
            <button
              type="button"
              onClick={() => void handleBrowse()}
              className="text-accent underline"
            >
              Pick from your computer
            </button>
          </div>
        </DropZone>
      )}
    </WorkspaceFrame>
  );
}

export default withWorkspaceDrafts(ConvertPage, "convert");
