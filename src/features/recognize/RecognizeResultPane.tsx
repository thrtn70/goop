import { useState } from "react";
import { Check, Copy, FolderOpen } from "lucide-react";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";

interface RecognizeResultPaneProps {
  /** Recognized text to preview. May be truncated server-side. */
  text: string;
  /** Absolute path of the saved output file (.txt or searchable PDF). */
  outputPath: string;
  /** Whether the preview was capped — shows a "preview truncated" note. */
  truncated: boolean;
}

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

/**
 * Result surface for the Recognize page: a scrollable text preview with
 * copy-to-clipboard, plus a reveal-in-folder action for the saved file.
 * The text is whatever `recognize_peek_text` returned — for a searchable
 * PDF output that's the extracted text layer, for a `.txt` output it's
 * the file body.
 */
export default function RecognizeResultPane({
  text,
  outputPath,
  truncated,
}: RecognizeResultPaneProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      // Webview clipboard write — secure context + user gesture, so no
      // extra Tauri plugin/capability is needed for text.
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      enqueueToast({
        variant: "error",
        title: "Couldn't copy to clipboard",
        detail: formatError(e),
      });
    }
  }

  const isEmpty = text.trim().length === 0;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-subtle bg-surface-1 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium text-fg">Recognized text</span>
          <span className="truncate text-xs text-fg-muted" title={outputPath}>
            Saved to {basename(outputPath)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void handleCopy()}
            disabled={isEmpty}
            className="btn-press inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-3 py-1.5 text-sm text-fg transition duration-fast ease-out hover:border-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={() => void api.queue.reveal(outputPath)}
            className="btn-press inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-3 py-1.5 text-sm text-fg transition duration-fast ease-out hover:border-accent/60"
          >
            <FolderOpen size={14} />
            Reveal
          </button>
        </div>
      </div>

      {isEmpty ? (
        <p className="rounded-md border border-dashed border-subtle px-3 py-6 text-center text-sm text-fg-muted">
          No text was found in this file.
        </p>
      ) : (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-subtle bg-surface-2 p-3 font-mono text-xs leading-relaxed text-fg-secondary">
          {text}
        </pre>
      )}

      {truncated && !isEmpty && (
        <p className="text-xs text-fg-muted">
          Preview truncated — open the saved file for the full text.
        </p>
      )}
    </div>
  );
}
