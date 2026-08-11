import { open } from "@tauri-apps/plugin-dialog";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { CoverArt, CoverArtOp } from "@/types";
import { basename } from "./fields";

interface CoverArtFieldProps {
  /** The currently-embedded cover art, if any. */
  current: CoverArt | null;
  /** The pending operation. */
  op: CoverArtOp;
  onChange: (op: CoverArtOp) => void;
  /** When editing multiple files at once, the controls apply to all. */
  batch?: boolean;
}

/** Cover-art preview + Replace / Remove / Keep controls, shared by the
 * single and batch audio editors. */
export default function CoverArtField({ current, op, onChange, batch }: CoverArtFieldProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);

  async function pickReplacement() {
    try {
      const picked = await open({
        multiple: false,
        title: "Pick cover image",
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }],
      });
      if (typeof picked === "string") {
        onChange({ kind: "replace", source_path: picked });
      }
    } catch (e) {
      enqueueToast({
        variant: "error",
        title: "Couldn't open image picker",
        detail: formatError(e),
      });
    }
  }

  return (
    <div className="flex items-center gap-4 rounded-md border border-subtle bg-surface-1 p-3">
      <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-2 text-center text-xs text-fg-muted">
        {op.kind === "remove" ? (
          <span>removed</span>
        ) : op.kind === "replace" ? (
          <span className="px-1">new cover</span>
        ) : current ? (
          <img
            src={`data:${current.mime_type};base64,${current.base64}`}
            alt="cover art"
            className="h-full w-full object-cover"
          />
        ) : (
          <span>no art</span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2">
        <p className="text-xs text-fg-muted">
          Cover art{batch ? " (applies to all selected)" : ""}
          {op.kind === "replace" && (
            <span className="ml-1 text-fg-secondary">→ {basename(op.source_path)}</span>
          )}
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            onClick={() => void pickReplacement()}
            className="btn-press rounded-md border border-subtle bg-surface-2 px-3 py-1.5 font-medium text-fg hover:border-accent/60"
          >
            Replace…
          </button>
          {(current || op.kind === "replace") && (
            <button
              type="button"
              onClick={() => onChange({ kind: "remove" })}
              className="btn-press rounded-md border border-subtle bg-surface-2 px-3 py-1.5 font-medium text-fg-muted hover:border-error/60 hover:text-error"
            >
              Remove
            </button>
          )}
          {op.kind !== "keep" && (
            <button
              type="button"
              onClick={() => onChange({ kind: "keep" })}
              className="btn-press rounded-md px-3 py-1.5 font-medium text-fg-muted hover:text-fg"
            >
              Keep current
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
