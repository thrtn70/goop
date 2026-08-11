import { useEffect, useRef, useState } from "react";
import { FolderOpen, RotateCw } from "lucide-react";
import type { Job, JobId, SourceKind } from "@/types";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { jobIdKey, useAppStore } from "@/store/appStore";
import { useRevealFile } from "@/hooks/useRevealFile";
import { useThumbnail } from "@/hooks/useThumbnail";
import { canRetryKind, failureView } from "@/lib/jobFailure";
import { rowLabel } from "@/lib/jobLabel";
import EmptyHistory from "@/features/history/EmptyHistory";

interface HistoryGridProps {
  onPreview: (job: Job) => void;
  onQuickView: (job: Job) => void;
}

function basename(p: string | null): string {
  if (!p) return "—";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
}

function formatBytes(b: bigint | null | undefined): string {
  const n = b != null ? Number(b) : 0;
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function kindOf(path: string | null): SourceKind {
  if (!path) return "video";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff", "tif", "avif", "jxl", "heic", "heif"].includes(ext)) return "image";
  if (["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"].includes(ext)) return "audio";
  return "video";
}

function KindIcon({ kind }: { kind: SourceKind }) {
  const glyph =
    kind === "pdf"
      ? "📄"
      : kind === "image"
        ? "🖼"
        : kind === "audio"
          ? "♫"
          : "▶";
  return (
    <div className="flex aspect-[16/10] w-full items-center justify-center rounded-md bg-surface-2 text-sm text-fg-muted">
      {glyph}
    </div>
  );
}

function Card({
  job,
  selected,
  previewing,
  onPreview,
  onQuickView,
}: {
  job: Job;
  selected: boolean;
  previewing: boolean;
  onPreview: (j: Job) => void;
  onQuickView: (j: Job) => void;
}) {
  const toggleSelection = useAppStore((s) => s.toggleHistorySelection);
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const revealFile = useRevealFile();
  const ref = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);
  const outputPath = job.result?.output_path ?? null;
  const kind = kindOf(outputPath);
  // Grid mode is persisted, so this is a view some users never leave. Without
  // it a failed card was indistinguishable from a successful one.
  //
  // Two independent questions, kept independent exactly as the History row
  // keeps them: `failed` is whether the state is terminal-error at all, and
  // decides the badge; `failure` is whether there is anything renderable to
  // say about it, and decides the message. `failureView` returns null for an
  // error with an empty message, and a card that showed nothing at all for
  // one would be the very bug this exists to close.
  const failed = typeof job.state !== "string" && "error" in job.state;
  const failure = failureView(job.state, canRetryKind(job.kind));
  // Same gate as the History row and the queue row, from the same helper:
  // download failures resume from the partials on disk, while a conversion
  // failure is deterministic. `queue_retry` is kind-generic; the restraint
  // is the UI's.
  const canRetry = failure !== null && canRetryKind(job.kind);
  // Lazy-load thumbnails via IntersectionObserver so a grid of 500 rows
  // doesn't queue 500 simultaneous ffmpeg/gs invocations at mount.
  // Audio rows get a waveform PNG (Phase J) — same lazy treatment.
  const thumbState = useThumbnail(job.id, !visible);

  useEffect(() => {
    if (!ref.current || visible) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setVisible(true);
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [visible]);

  /**
   * Re-queue a failed download. The card stays in History until the queue
   * writes its new terminal state, so there is nothing to update here — only
   * a failure to report, which would otherwise be a click that silently did
   * nothing.
   */
  async function retry(): Promise<void> {
    try {
      await api.queue.retry(job.id);
    } catch (err) {
      enqueueToast({
        variant: "error",
        title: "Couldn't retry",
        detail: formatError(err),
      });
    }
  }

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onPreview(job)}
      onKeyDown={(e) => {
        if (e.key === " " || e.code === "Space") {
          e.preventDefault();
          onQuickView(job);
        }
      }}
      className={`group relative flex flex-col overflow-hidden rounded-lg bg-surface-1 text-left transition duration-fast ease-out hover:ring-1 hover:ring-accent ${
        previewing ? "ring-2 ring-accent" : ""
      }`}
    >
      {thumbState.status === "ready" ? (
        <img
          src={thumbState.src}
          alt=""
          className="aspect-[16/10] w-full bg-surface-2 object-cover"
          // Phase: View Transitions. The card gives up its name when its
          // preview is open so the same name is unique across the page —
          // avoiding the duplicate-name conflict that would suppress the
          // morph. The previewing card stays mounted; only the preview
          // pane's <img> carries the name in the after-state.
          style={
            previewing
              ? undefined
              : { viewTransitionName: `vt-thumb-${jobIdKey(job.id)}` }
          }
        />
      ) : (
        <KindIcon kind={kind} />
      )}
      <div className="p-2.5">
        <div className="truncate text-xs text-fg" title={outputPath ?? undefined}>
          {basename(outputPath)}
        </div>
        <div className="mt-0.5 flex justify-between text-xs text-fg-muted">
          <span>{formatBytes(job.result?.bytes)}</span>
          <span>
            {job.result?.result_kind === "folder" && job.result.file_count > 1
              ? `${job.result.file_count} files`
              : String(job.kind)}
          </span>
        </div>
        {/* The card otherwise reads as a success with a missing thumbnail.
         *  The raw detail stays in the queue row — a card is smaller than a
         *  table row, and a traceback in one would crowd out the grid. */}
        {failed && (
          <div className="mt-1">
            <span className="text-xs uppercase text-error">error</span>
            {failure && (
              <div className="truncate text-xs text-error/80" title={failure.message}>
                {failure.message}
              </div>
            )}
          </div>
        )}
      </div>
      <span
        onClick={(e) => {
          e.stopPropagation();
          toggleSelection(job.id);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            toggleSelection(job.id);
          }
        }}
        className={`absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-sm border text-xs transition duration-fast ease-out focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
          selected
            ? "border-accent bg-accent text-accent-fg"
            : "border-subtle bg-surface-1/70 text-fg-muted opacity-0 group-hover:opacity-100"
        }`}
        aria-label={`Select ${basename(outputPath)}`}
        role="checkbox"
        aria-checked={selected}
        tabIndex={0}
      >
        {selected ? "✓" : ""}
      </span>
      {/* One row for the corner affordances. A failed job has no output path
       *  today, so in practice only one of these renders — but sharing a flex
       *  container means they sit side by side rather than on top of each
       *  other if that ever stops being true. */}
      <span className="absolute right-2 top-2 flex items-center gap-1">
        {canRetry && (
          <span
            onClick={(e) => {
              // The card itself opens a preview. Without this the retry also
              // previews a job that produced no file.
              e.stopPropagation();
              void retry();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                void retry();
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={`Retry ${rowLabel(job)}`}
            title="Retry"
            // Unlike the reveal affordance this stays visible: a failed card
            // has no thumbnail to keep clear, and re-running is the only
            // thing left to do with it.
            className="flex h-5 w-5 items-center justify-center rounded-sm border border-subtle bg-surface-1/70 text-accent transition duration-fast ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent hover:text-accent-hover"
          >
            <RotateCw size={12} strokeWidth={2.5} aria-hidden="true" />
          </span>
        )}
        {outputPath && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              void revealFile(outputPath);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                void revealFile(outputPath);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={`Show ${basename(outputPath)} in folder`}
            title="Show in folder"
            className="flex h-5 w-5 items-center justify-center rounded-sm border border-subtle bg-surface-1/70 text-fg-muted opacity-0 transition duration-fast ease-out focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent group-hover:opacity-100 hover:text-fg"
          >
            <FolderOpen size={12} strokeWidth={2.5} aria-hidden="true" />
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Thumbnail card grid. Cards lazy-load their thumbnails when scrolled
 * into view. Grid is 4 cols at ≥1024px, 3 at ≥768px, 2 otherwise.
 */
export default function HistoryGrid({ onPreview, onQuickView }: HistoryGridProps) {
  const jobs = useAppStore((s) => s.history.jobs);
  const selectedIds = useAppStore((s) => s.history.selectedIds);
  const previewSelectedId = useAppStore((s) => s.history.previewSelectedId);
  const search = useAppStore((s) => s.history.search);
  const kind = useAppStore((s) => s.history.kind);

  if (jobs.length === 0) {
    const filtersActive = search.trim() !== "" || kind !== null;
    return <EmptyHistory filtersActive={filtersActive} />;
  }

  return (
    <div className="grid flex-1 gap-3 overflow-auto px-6 py-4 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
      {jobs.map((j) => {
        const key = jobIdKey(j.id);
        return (
          <Card
            key={key}
            job={j}
            selected={selectedIds.has(key)}
            previewing={previewSelectedId === key}
            onPreview={onPreview}
            onQuickView={onQuickView}
          />
        );
      })}
    </div>
  );
}

// Exported only so tests can reference JobId types without manually
// re-importing from goop-core.
export type { JobId };
