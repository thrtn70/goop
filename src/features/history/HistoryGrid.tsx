import { useEffect, useRef, useState } from "react";
import type { Job, JobId, SourceKind } from "@/types";
import { jobIdKey, useAppStore } from "@/store/appStore";
import { useThumbnail } from "@/hooks/useThumbnail";

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
  if (["png", "jpg", "jpeg", "webp", "bmp", "gif"].includes(ext)) return "image";
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
  const ref = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);
  const outputPath = job.result?.output_path ?? null;
  const kind = kindOf(outputPath);
  // Lazy-load thumbnails via IntersectionObserver so a grid of 500 rows
  // doesn't queue 500 simultaneous ffmpeg/gs invocations at mount.
  const thumbState = useThumbnail(job.id, !visible || kind === "audio");

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
        />
      ) : (
        <KindIcon kind={kind} />
      )}
      <div className="p-2.5">
        <div className="truncate text-xs text-fg" title={outputPath ?? undefined}>
          {basename(outputPath)}
        </div>
        <div className="mt-0.5 flex justify-between text-[10px] text-fg-muted">
          <span>{formatBytes(job.result?.bytes)}</span>
          <span>{String(job.kind)}</span>
        </div>
      </div>
      <span
        onClick={(e) => {
          e.stopPropagation();
          toggleSelection(job.id);
        }}
        className={`absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-sm border text-[10px] transition duration-fast ease-out ${
          selected
            ? "border-accent bg-accent text-accent-fg"
            : "border-subtle bg-surface-1/70 text-fg-muted opacity-0 group-hover:opacity-100"
        }`}
        aria-label="Select card"
        role="checkbox"
        aria-checked={selected}
      >
        {selected ? "✓" : ""}
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

  if (jobs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-sm text-fg-secondary">No finished jobs match those filters.</p>
      </div>
    );
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
