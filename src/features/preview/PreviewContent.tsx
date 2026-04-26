import { X } from "lucide-react";
import type { Job, SourceKind } from "@/types";
import { useThumbnail } from "@/hooks/useThumbnail";
import { jobIdKey } from "@/store/appStore";
import DeleteMenu from "./DeleteMenu";

interface PreviewContentProps {
  job: Job;
  /** "panel" keeps the preview compact for the slide-out; "modal" stretches for Quick View. */
  variant: "panel" | "modal";
  onConvertAgain: (job: Job) => void;
  onReveal: (path: string) => void;
  onClose?: () => void;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
}

function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "-";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function sourceKindFromPath(path: string): SourceKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "bmp", "gif"].includes(ext)) return "image";
  if (["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"].includes(ext)) return "audio";
  return "video";
}

export default function PreviewContent({
  job,
  variant,
  onConvertAgain,
  onReveal,
  onClose,
}: PreviewContentProps) {
  const outputPath = job.result?.output_path ?? null;
  const kind = outputPath ? sourceKindFromPath(outputPath) : "video";
  // Audio rows render a waveform PNG (Phase J); falls back to a badge
  // below when the waveform isn't ready or generation failed.
  const thumbState = useThumbnail(job.id, false);

  const bytes = job.result?.bytes != null ? Number(job.result.bytes) : 0;
  // Both variants currently want the same aspect; the variant prop is
  // still meaningful elsewhere (e.g. controlling which surfaces claim
  // the view-transition-name).
  const thumbSize = "aspect-video";

  return (
    <div className={variant === "modal" ? "flex flex-col" : "flex flex-col gap-3"}>
      {variant === "modal" && (
        <div className="flex items-center gap-3 border-b border-subtle px-4 py-3">
          <span className="text-sm font-medium text-fg">
            {outputPath ? basename(outputPath) : "Untitled"}
          </span>
          <span className="ml-auto text-xs text-fg-muted">
            ← → to navigate · Space to close
          </span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex items-center justify-center text-fg-muted transition duration-fast ease-out hover:text-fg"
            >
              <X size={14} strokeWidth={2.5} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {thumbState.status === "ready" ? (
        <img
          src={thumbState.src}
          alt={kind === "audio" ? "audio waveform" : ""}
          className={`${thumbSize} w-full rounded-md bg-surface-2 object-contain`}
          // View Transitions: only the side panel claims the shared
          // `vt-thumb-{id}` name. Quick View (variant === "modal") would
          // double-claim it on top of the panel and suppress the morph.
          // The modal gets its own enter animation via `enter-up`.
          style={
            variant === "panel"
              ? { viewTransitionName: `vt-thumb-${jobIdKey(job.id)}` }
              : undefined
          }
        />
      ) : (
        <div
          className={`${thumbSize} flex items-center justify-center rounded-md bg-surface-2 text-xs text-fg-muted`}
        >
          {thumbState.status === "unavailable"
            ? kind === "audio"
              ? "♫ audio"
              : "preview unavailable"
            : "loading..."}
        </div>
      )}

      {variant === "panel" && (
        <div>
          <div className="text-sm font-medium text-fg" title={outputPath ?? undefined}>
            {outputPath ? basename(outputPath) : "Untitled"}
          </div>
          <div className="mt-1 text-xs text-fg-muted">
            {formatBytes(bytes)} · {String(job.kind)}
          </div>
        </div>
      )}

      <div
        className={
          variant === "modal"
            ? "flex items-center gap-3 px-4 py-3"
            : "flex flex-col gap-2"
        }
      >
        {variant === "modal" && (
          <span className="text-xs text-fg-muted">
            {formatBytes(bytes)} · {String(job.kind)}
          </span>
        )}
        <div
          className={
            variant === "modal"
              ? "ml-auto flex items-center gap-2"
              : "flex flex-col gap-2"
          }
        >
          {outputPath && (
            <button
              type="button"
              onClick={() => onReveal(outputPath)}
              className={`btn-press rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-secondary transition duration-fast ease-out hover:text-fg ${variant === "panel" ? "w-full" : ""}`}
            >
              Reveal in Finder
            </button>
          )}
          {job.kind === "convert" && (
            <button
              type="button"
              onClick={() => onConvertAgain(job)}
              className={`btn-press rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-secondary transition duration-fast ease-out hover:text-fg ${variant === "panel" ? "w-full" : ""}`}
            >
              Convert again
            </button>
          )}
          <DeleteMenu job={job} fullWidth={variant === "panel"} />
        </div>
      </div>
    </div>
  );
}
