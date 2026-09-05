import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { save } from "@tauri-apps/plugin-dialog";
import { api, pdfOcr } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { IpcLanguagePack } from "@/ipc/commands";

interface PdfOcrFlowProps {
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

/**
 * OCR a scanned PDF into a searchable one. The pipeline (mutool draw →
 * tesseract per page → lopdf merge) runs in the queue worker; this UI
 * just collects the language + output path.
 *
 * The language picker lists currently installed packs. If the user
 * wants a language we don't have installed, they go to Settings → OCR
 * Languages to download it.
 */
export default function PdfOcrFlow({ file, onDone }: PdfOcrFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const navigate = useNavigate();
  const [installed, setInstalled] = useState<IpcLanguagePack[]>([]);
  const [lang, setLang] = useWorkspaceDraftState<string>("PdfOcrFlow.lang", "eng");
  const [loadingLangs, setLoadingLangs] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

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
    // We only want this on mount; `lang` defaulting is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleApply() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const dest = await save({
        defaultPath: `${stemOf(file)}-searchable.pdf`,
        title: "Save searchable PDF",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!dest) {
        return;
      }
      await api.pdf.run(pdfOcr(file, dest, lang));
      enqueueToast({ variant: "success", title: "PDF OCR queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  const canApply = !busy && installed.length > 0 && !!lang;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted">
        Adds a searchable text layer to a scanned PDF. The output is a new PDF
        you can copy / search / select text from. OCR takes a minute or two per
        ten pages.
      </p>

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
          disabled={!canApply}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Queuing…" : "Run OCR"}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}
