import { useWorkspaceOperation } from "@/store/workspaceOperations";
import { withWorkspaceDrafts } from "@/store/workspaceDrafts";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import { open, save } from "@tauri-apps/plugin-dialog";
import DropZone from "@/features/convert/DropZone";
import RecognizeResultPane from "@/features/recognize/RecognizeResultPane";
import {
  isRecognizable,
  RECOGNIZE_EXTENSIONS,
} from "@/features/recognize/recognizable";
import { api, pdfRecognizeText } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { jobIdKey, useAppStore } from "@/store/appStore";
import type { IpcLanguagePack } from "@/ipc/commands";
import type { ImageOcrOutput, JobId } from "@/types";

// Keep in lockstep with RECOGNIZE_PREVIEW_CHAR_CAP in
// src-tauri/src/commands/pdf.rs. Used only to show a "preview truncated"
// hint; an off-by-a-little mismatch just hides the hint, never breaks.
const PREVIEW_CHAR_CAP = 100_000;

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

type Phase = "idle" | "running" | "done" | "error";

interface RecognizeResult {
  text: string;
  outputPath: string;
}

/**
 * Smart "Recognize text" page (v0.2.7). Drop a PDF or an image and goop
 * auto-detects whether to read an existing text layer (fast) or run OCR
 * (scanned docs / images), then shows the recognized text inline with
 * copy + reveal. The detection + routing lives in the backend
 * `recognize_text` orchestrator; this page owns input selection, the
 * output-format + language choices, and the result preview.
 *
 * Single-document by design: multi-image OCR stays in the PDF Studio
 * Image-OCR flow. The explicit Extract-text / OCR ops also remain there
 * for callers who want to force a specific path.
 */
function RecognizePage() {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const jobs = useAppStore((s) => s.jobs);
  const navigate = useNavigate();
  const location = useLocation();

  const [input, setInput] = useWorkspaceDraftState<string | null>("RecognizePage.input", null);
  const [outputKind, setOutputKind] = useWorkspaceDraftState<ImageOcrOutput>("RecognizePage.outputKind", "text");
  const [installed, setInstalled] = useState<IpcLanguagePack[]>([]);
  const [lang, setLang] = useWorkspaceDraftState<string>("RecognizePage.lang", "eng");
  const [loadingLangs, setLoadingLangs] = useState<boolean>(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const { busy: submitting, begin } = useWorkspaceOperation();
  const [jobId, setJobId] = useState<JobId | null>(null);
  const [result, setResult] = useState<RecognizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards the completion effect against firing the async peek twice if a
  // second `jobs` update lands before `setJobId(null)` flushes.
  const peekingRef = useRef(false);

  // Preload a file when navigated here from a "Recognize text?" chip on
  // another page (it passes the path via router state).
  useEffect(() => {
    const preloaded = (location.state as { recognizeInput?: string } | null)
      ?.recognizeInput;
    if (typeof preloaded === "string" && isRecognizable(preloaded)) {
      setInput(preloaded);
      // Clear the router state so a later back/forward doesn't re-load it.
      navigate(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load installed language packs (same pattern as ImageOcrFlow).
  useEffect(() => {
    let cancelled = false;
    void api.sidecar
      .tessdataInstalled()
      .then((langs) => {
        if (cancelled) return;
        setInstalled(langs);
        if (langs.length > 0 && !langs.some((l) => l.code === lang)) {
          setLang(langs[0].code);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(formatError(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingLangs(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch the queue for our recognize job; when it finishes, peek the
  // recognized text for the preview pane.
  useEffect(() => {
    if (!jobId || peekingRef.current) return;
    const job = jobs.find((j) => jobIdKey(j.id) === jobIdKey(jobId));
    if (!job) return;
    if (job.state === "done" && job.result?.output_path) {
      const out = job.result.output_path;
      peekingRef.current = true;
      setJobId(null);
      api.pdf
        .recognizePeekText(out)
        .then((text) => {
          setResult({ text, outputPath: out });
          setPhase("done");
        })
        .catch((e) => {
          setError(formatError(e));
          setPhase("error");
        })
        .finally(() => {
          peekingRef.current = false;
        });
    } else if (typeof job.state === "object" && "error" in job.state) {
      setError(job.state.error.message);
      setPhase("error");
      setJobId(null);
    }
  }, [jobs, jobId]);

  const addFromPaths = useCallback((paths: string[]) => {
    const first = paths.find(isRecognizable);
    if (!first) return;
    setInput(first);
    setResult(null);
    setError(null);
    setPhase("idle");
  }, [setInput]);

  const handleBrowse = useCallback(async () => {
    try {
      const picked = await open({
        multiple: false,
        title: "Pick a PDF or image to recognize",
        filters: [{ name: "Documents & images", extensions: RECOGNIZE_EXTENSIONS }],
      });
      if (!picked) return;
      addFromPaths([picked as string]);
    } catch (e) {
      enqueueToast({
        variant: "error",
        title: "Couldn't open the file picker",
        detail: formatError(e),
      });
    }
  }, [addFromPaths, enqueueToast]);

  async function handleRecognize() {
    if (!input || phase === "running") return;
    const finish = begin();
    if (!finish) return;
    setError(null);
    const isText = outputKind === "text";
    const stem = basename(input).replace(/\.[^.]+$/, "");
    try {
      const dest = await save({
        defaultPath: isText ? `${stem}.txt` : `${stem}-recognized.pdf`,
        title: isText ? "Save recognized text" : "Save searchable PDF",
        filters: [
          isText
            ? { name: "Text", extensions: ["txt"] }
            : { name: "PDF", extensions: ["pdf"] },
        ],
      });
      if (!dest) return;
      const id = await api.pdf.run(pdfRecognizeText(input, dest, outputKind, lang));
      peekingRef.current = false;
      setResult(null);
      setPhase("running");
      setJobId(id);
    } catch (e) {
      setError(formatError(e));
      setPhase("error");
    } finally {
      finish();
    }
  }

  const canRecognize =
    !!input && !submitting && phase !== "running" && installed.length > 0 && !!lang;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <div>
        <h2 className="font-display text-2xl font-semibold text-fg">
          Recognize text
        </h2>
        <p className="text-sm text-fg-muted">
          Drop a PDF or image. Goop reads its text — pulling an existing text
          layer when there is one, running OCR when there isn&apos;t — and shows
          the result here to copy or save.
        </p>
      </div>

      <DropZone onFiles={addFromPaths}>
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <p className="text-sm text-fg-secondary">
            {input ? "Drop another file to replace, or" : "Drop a PDF or image here, or"}
          </p>
          <button
            type="button"
            onClick={() => void handleBrowse()}
            className="btn-press rounded-md border border-subtle bg-surface-2 px-4 py-2 text-sm font-medium text-fg hover:border-accent/60"
          >
            Pick a file…
          </button>
          <p className="text-xs text-fg-muted">PDF, PNG, JPEG, WebP, BMP, TIFF</p>
        </div>
      </DropZone>

      {input && (
        <div className="flex items-center gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-2 text-sm">
          <span className="flex-1 truncate text-fg" title={input}>
            {basename(input)}
          </span>
          <button
            type="button"
            onClick={() => {
              setInput(null);
              setResult(null);
              setPhase("idle");
            }}
            className="btn-press rounded p-1 text-xs text-fg-muted hover:bg-surface-3 hover:text-error"
          >
            Remove
          </button>
        </div>
      )}

      {input && (
        <>
          <fieldset className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 p-3">
            <legend className="px-1 text-xs font-medium text-fg-secondary">Output</legend>
            <div className="flex gap-2">
              {([
                ["text", "Text (.txt)"],
                ["searchable_pdf", "Searchable PDF"],
              ] as const).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={outputKind === kind}
                  onClick={() => setOutputKind(kind)}
                  className={`btn-press flex-1 rounded-md border px-3 py-1.5 text-sm transition duration-fast ease-out ${
                    outputKind === kind
                      ? "border-accent bg-accent-subtle text-fg"
                      : "border-subtle bg-surface-2 text-fg-secondary hover:border-accent/60"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 p-3">
            <legend className="px-1 text-xs font-medium text-fg-secondary">Language</legend>
            {loadingLangs ? (
              <p className="text-sm text-fg-muted">Loading installed packs…</p>
            ) : installed.length === 0 ? (
              <p className="text-sm text-fg-muted">
                No language packs installed. Visit{" "}
                <button
                  type="button"
                  onClick={() => navigate("/settings#ocr-languages")}
                  className="text-accent underline hover:no-underline"
                >
                  Settings → OCR Languages
                </button>{" "}
                to add one.
              </p>
            ) : (
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                className="rounded-md border border-subtle bg-surface-2 px-3 py-1.5 text-sm text-fg"
              >
                {installed
                  .slice()
                  .sort((a, b) => a.display_name.localeCompare(b.display_name))
                  .map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.display_name}
                      {l.bundled ? " (bundled)" : ""}
                    </option>
                  ))}
              </select>
            )}
          </fieldset>

          <div className="flex items-center gap-3 border-t border-subtle pt-3">
            <button
              type="button"
              disabled={!canRecognize}
              onClick={() => void handleRecognize()}
              className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Starting…" : phase === "running" ? "Recognizing…" : "Recognize text"}
            </button>
            {error && <span className="text-xs text-error">{error}</span>}
          </div>
        </>
      )}

      {phase === "done" && result && (
        <RecognizeResultPane
          text={result.text}
          outputPath={result.outputPath}
          truncated={[...result.text].length >= PREVIEW_CHAR_CAP}
        />
      )}
    </div>
  );
}

export default withWorkspaceDrafts(RecognizePage, "recognize");
