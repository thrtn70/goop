import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { useId, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, pdfSetMetadata } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { PdfMetadata } from "@/types";

interface PdfMetadataFormProps {
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

export default function PdfMetadataForm({ file, onDone }: PdfMetadataFormProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [title, setTitle] = useWorkspaceDraftState<string>("PdfMetadataForm.title", "");
  const [author, setAuthor] = useWorkspaceDraftState<string>("PdfMetadataForm.author", "");
  const [subject, setSubject] = useWorkspaceDraftState<string>("PdfMetadataForm.subject", "");
  const [keywords, setKeywords] = useWorkspaceDraftState<string>("PdfMetadataForm.keywords", "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleId = useId();
  const authorId = useId();
  const subjectId = useId();
  const keywordsId = useId();

  const someTouched =
    title.trim() !== "" || author.trim() !== "" || subject.trim() !== "" || keywords.trim() !== "";
  const canApply = someTouched && !busy;

  async function handleApply() {
    if (!canApply) return;
    setBusy(true);
    setError(null);
    try {
      const dest = await save({
        defaultPath: `${stemOf(file)}-metadata.pdf`,
        title: "Save PDF with updated metadata",
      });
      if (!dest) {
        setBusy(false);
        return;
      }
      // Only send fields the user actually edited (non-empty). Leaving a
      // field empty in the form means "leave existing alone" — explicit
      // "clear" UX would need a separate affordance and isn't in scope
      // for v0.2.3.
      const metadata: PdfMetadata = {
        title: title.trim() ? title : null,
        author: author.trim() ? author : null,
        subject: subject.trim() ? subject : null,
        keywords: keywords.trim() ? keywords : null,
      };
      await api.pdf.run(pdfSetMetadata(file, metadata, dest));
      enqueueToast({ variant: "success", title: "PDF metadata queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted">
        Fill in any fields to update. Empty fields are left untouched on the
        output PDF.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FieldGroup id={titleId} label="Title">
          <input
            id={titleId}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="rounded-md bg-surface-2 px-3 py-2 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </FieldGroup>
        <FieldGroup id={authorId} label="Author">
          <input
            id={authorId}
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            className="rounded-md bg-surface-2 px-3 py-2 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </FieldGroup>
        <FieldGroup id={subjectId} label="Subject">
          <input
            id={subjectId}
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="rounded-md bg-surface-2 px-3 py-2 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </FieldGroup>
        <FieldGroup id={keywordsId} label="Keywords">
          <input
            id={keywordsId}
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="comma, separated, terms"
            className="rounded-md bg-surface-2 px-3 py-2 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </FieldGroup>
      </div>
      <div className="flex items-center gap-3 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={!canApply}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save metadata"}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}

function FieldGroup({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs uppercase tracking-wide text-fg-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
