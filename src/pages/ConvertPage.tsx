import { cloneVideoOptions, videoOptionsError, videoRequestOptions, videoDraftSlots, type VideoDraftText } from "@/features/convert/videoOptions";
import { useVideoPlans } from "@/features/convert/useVideoPlan";
import { videoExecutionText } from "@/features/preview/outputSummary";
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
import { useCallback, useEffect, useState } from "react";
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
import { cloneImageOptions, imageDraftProblem, imageDraftSlots, type ImageDraftText } from "@/features/convert/imageOptions";
import { useWorkspaceDraftEntries, clearWorkspaceDraftSlots } from "@/store/workspaceDrafts";
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
  const draftEntries = useWorkspaceDraftEntries();
  const [applicationError, setApplicationError] = useState<string | null>(null);
  const imageProblems = files.map(file => {
    const state = byId[file.id ?? ""];
    if (state?.phase !== "ready") return null;
    const raw: ImageDraftText = {};
    for (const slot of imageDraftSlots) {
      const value = draftEntries[JSON.stringify(["convert", "source", file.path, file.id, slot])]?.value;
      if (typeof value === "string") raw[slot.slice("ImageOptionsPanel.".length) as keyof ImageDraftText] = value;
    }
    return imageDraftProblem(file.imageOptions, state.capabilities.targets.find(c => c.target === file.target)?.image_settings, raw);
  });
  const videoFiles = files.map(file => {
    const state = byId[file.id ?? ""];
    const raw: VideoDraftText = {};
    for (const slot of videoDraftSlots) {
      const value = draftEntries[JSON.stringify(["convert", "source", file.path, file.id, slot])]?.value;
      if (typeof value === "string") raw[slot.slice("VideoOptionsPanel.".length) as keyof VideoDraftText] = value;
    }
    return { ...file, videoDraft: raw, videoCapability: state?.phase === "ready" ? state.capabilities.targets.find(c => c.target === file.target)?.video_settings : null };
  });
  const videoProblems = videoFiles.map(videoOptionsError);
  useEffect(() => {
    if (files.some((f) => !f.id))
      setFiles((previous) =>
        previous.map((f) => (f.id ? f : { ...f, ...newIdentity() })),
      );
  }, [files, setFiles]);
  const selected = files.find((f) => f.id === selectedId) ?? files[0];
  const selectedState = byId[selected?.id ?? ""] ?? PROBING;
  const selectedVideo = videoFiles.find(file => file.id === selected?.id);
  const planEntries = videoFiles.flatMap(file => {
    if (!file.id || !file.videoOptions || !file.optionsReady || videoOptionsError(file)) return [];
    return [{
      id: file.id, sourceIdentity: JSON.stringify([file.id, file.revision]),
      request: {
        input_path: file.path, output_path: "", target: file.target,
        video_options: videoRequestOptions(file), quality_preset: null, resolution_cap: file.resolutionCap,
        compress_mode: null, batch_id: null, metadata_policy: file.metadataPolicy,
        subtitle: file.subtitle, gif_options: file.gifOptions, image_options: cloneImageOptions(file.imageOptions),
      },
    }];
  });
  const videoPlans = useVideoPlans(planEntries);
  const videoPlan = videoPlans[selected?.id ?? ""];
  const planProblem = (file: FileEntry) => {
    if (!file.videoOptions) return null;
    const plan = videoPlans[file.id ?? ""];
    return plan?.summary ? null : plan?.error ?? "Checking video processing…";
  };

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
        const imageCapability = state.capabilities.targets.find(c => c.target === target)?.image_settings;
        return {
          ...f,
          revision: (f.revision ?? 0) + 1,
          optionsReady: true,
          target,
          imageOptions: imageCapability?.available ? { jpeg_quality: imageCapability.default_quality, resize: { kind: "original" as const } } : null,
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
      const current = files.find(file => file.id === id);
      if (current?.imageOptions && opts.imageOptions == null) clearWorkspaceDraftSlots("convert", ["source", current.path, id], imageDraftSlots);
      setFiles((prev) =>
        prev.map((f) =>
          f.id === id
            ? {
                ...f,
                revision: (f.revision ?? 0) + 1,
                optionsReady: true,
                target: opts.target,
                gifOptions: opts.gifOptions ? { ...opts.gifOptions } : null,
                imageOptions: cloneImageOptions(opts.imageOptions),
                videoOptions: cloneVideoOptions(opts.videoOptions),
                metadataPolicy: opts.metadataPolicy,
                subtitle: opts.subtitle ? { ...opts.subtitle } : null,
                qualityPreset: opts.qualityPreset ?? null,
                resolutionCap: opts.resolutionCap ?? null,
              }
            : f,
        ),
      );
    },
    [files, setFiles],
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

  // Validate the whole proposed batch before changing any entry or raw editor.
  const applySettings = (settings: FileRowOptions) => {
    const next = files.map(file => ({
      ...file,
      target: settings.target, metadataPolicy: settings.metadataPolicy,
      qualityPreset: settings.qualityPreset ?? null,
      resolutionCap: settings.resolutionCap ?? null,
      optionsReady: true,
      revision: (file.revision ?? 0) + 1,
      imageOptions: cloneImageOptions(settings.imageOptions),
      videoOptions: cloneVideoOptions(settings.videoOptions),
      gifOptions: settings.gifOptions ? { ...settings.gifOptions } : null,
      subtitle: settings.subtitle ? { ...settings.subtitle } : null,
    }));
    const incompatible = next.flatMap(file => {
      const state = byId[file.id ?? ""] ?? PROBING;
      const capability = state.phase === "ready" ? state.capabilities.targets.find(c => c.target === file.target)?.video_settings : null;
      const problem = videoOptionsError({...file, videoCapability:capability}) ?? conversionProblem({...file,qualityPreset:file.videoOptions ? null : file.qualityPreset}, state);
      return problem ? [`${sourceName(file.path)}: ${problem}`] : [];
    });
    if (incompatible.length) {
      setApplicationError(`Settings were not applied. ${incompatible.join(" ")}`);
      return;
    }
    setApplicationError(null);
    files.forEach(file => clearWorkspaceDraftSlots("convert", ["source", file.path, file.id ?? ""], [...imageDraftSlots, ...videoDraftSlots]));
    setFiles(next);
  };

  const applyPreset = (preset: Preset) => {
    if (preset.compress_mode) { setApplicationError("Compression settings cannot be applied in Convert."); return; }
    applySettings({
      target: preset.target,
      imageOptions: cloneImageOptions(preset.image_options),
      videoOptions: cloneVideoOptions(preset.video_options),
      gifOptions: preset.gif_options ?? (preset.target === "gif" ? defaultGifOptions() : null),
      metadataPolicy: preset.metadata_policy ?? "preserve",
      subtitle: preset.subtitle ?? null,
      qualityPreset: preset.quality_preset,
      resolutionCap: preset.resolution_cap,
    });
  };

  const applyFirstToAll = () => {
    if (files.length < 2 || imageProblems.some(Boolean) || videoProblems.some(Boolean)) return;
    applySettings({...files[0],videoOptions:videoRequestOptions(videoFiles[0])});
  };

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

  const problems = files.map((f, i) =>
    videoProblems[i] ?? conversionProblem({...f,qualityPreset:f.videoOptions ? null : f.qualityPreset}, byId[f.id ?? ""] ?? PROBING) ?? imageProblems[i],
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
              files={videoFiles}
              disabled={blocked}
              planningBlocked={files.some(file => !!planProblem(file))}
              onEnqueued={() => {}}
              onSettled={onSettled}
              onApplyToAll={applyFirstToAll}
            />
          }
        >
          {selected &&
          selectedState.phase === "ready" &&
          selected.optionsReady ? (
            <WorkspaceDraftProvider key={selected.id} scope={["source", selected.path]} sourcePaths={[selected.path]}>
              <ConvertSettingsPanel
                onDraftEdit={() => selected.id && handleDraftEdit(selected.id)}
                path={selected.path}
                draftIdentity={selected.id}
                options={selected}
                state={selectedState}
                onOptionsChange={(_, opts) =>
                  selected.id && handleOptionsChange(selected.id, opts)
                }
              />
              {selected.videoOptions && <section aria-label="Video processing summary" className="mt-4 text-xs text-fg-secondary">
                {videoPlan?.busy && <p>Checking video processing…</p>}
                {videoPlan?.error && <p role="alert" className="text-warning">{videoPlan?.error}</p>}
                {videoPlan?.summary && <p>{selected.target.toUpperCase()} · {videoExecutionText(videoPlan?.summary)}</p>}
              </section>}
              {(!problems[files.indexOf(selected)] || selected.videoOptions) && <SettingsPreview videoSettings={selectedVideo?.videoCapability} imageSettings={selectedState.capabilities.targets.find(capability => capability.target === selected.target)?.image_settings} request={{input_path:selected.path,target:selected.target,
                quality_preset:selected.videoOptions ? null : selected.qualityPreset,video_options:cloneVideoOptions(selected.videoOptions),resolution_cap:selected.resolutionCap,
                compress_mode:null,metadata_policy:selected.metadataPolicy,
                subtitle:selected.subtitle,gif_options:selected.gifOptions,image_options:cloneImageOptions(selected.imageOptions)}}/>}
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
          {applicationError && <p role="alert" className="mt-4 text-xs text-warning">{applicationError}</p>}
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
              problem={problems[i] ?? planProblem(f)}
              edited={f.submittedEdit}
              onSelect={() => setSelectedId(f.id ?? null)}
              onRemove={() => handleRemove(f.path)}
              onRetry={() => f.id && retry(f.id)}
            />
          ))}
        </ul>
      </WorkspaceList>
      {files.some(file => file.videoOptions) && (
        <section aria-label="Video processing plans" className="mt-4 rounded-lg border border-subtle bg-surface-0 p-3 text-xs">
          <h3 className="font-medium text-fg">Video processing</h3>
          <ul className="mt-2 space-y-3" aria-live="polite">
            {files.map((file, i) => {
              if (!file.videoOptions) return null;
              const plan = videoPlans[file.id ?? ""];
              const problem = problems[i] ?? planProblem(file);
              return <li key={file.id ?? file.path}>
                <p className="font-medium text-fg" title={file.path}>{sourceName(file.path)}</p>
                <p className={problems[i] || plan?.error ? "text-warning" : "text-fg-secondary"}>
                  {problem ?? (plan?.summary && file.target.toUpperCase() + " · " + videoExecutionText(plan.summary))}
                </p>
              </li>;
            })}
          </ul>
        </section>
      )}
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
