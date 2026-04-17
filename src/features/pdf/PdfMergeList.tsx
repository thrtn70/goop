import { useState } from "react";

interface PdfMergeListProps {
  files: string[];
  onReorder: (files: string[]) => void;
  onRemove: (path: string) => void;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
}

/**
 * Drag-to-reorder list of dropped PDFs. HTML5 DnD only — no new library.
 * Order here is the merge order that the backend processes.
 */
export default function PdfMergeList({
  files,
  onReorder,
  onRemove,
}: PdfMergeListProps) {
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);

  function handleDrop(dropIdx: number) {
    if (draggingIdx === null || draggingIdx === dropIdx) {
      setDraggingIdx(null);
      return;
    }
    const next = [...files];
    const [moved] = next.splice(draggingIdx, 1);
    next.splice(dropIdx, 0, moved);
    onReorder(next);
    setDraggingIdx(null);
  }

  return (
    <ol className="flex flex-col gap-1">
      {files.map((path, i) => (
        <li
          key={path}
          draggable
          onDragStart={() => setDraggingIdx(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => handleDrop(i)}
          onDragEnd={() => setDraggingIdx(null)}
          aria-label={`PDF ${i + 1}: ${basename(path)}`}
          className={`flex cursor-grab items-center gap-3 rounded-md border border-subtle bg-surface-1 px-3 py-2 text-sm transition duration-fast ease-out ${
            draggingIdx === i ? "opacity-50" : ""
          }`}
        >
          <span className="text-fg-muted" aria-hidden>
            ⋮⋮
          </span>
          <span className="w-5 text-xs tabular-nums text-fg-muted">{i + 1}.</span>
          <span className="flex-1 truncate text-fg" title={path}>
            {basename(path)}
          </span>
          <button
            type="button"
            onClick={() => onRemove(path)}
            aria-label={`Remove ${basename(path)}`}
            className="text-xs text-fg-muted transition duration-fast ease-out hover:text-error"
          >
            ✕
          </button>
        </li>
      ))}
    </ol>
  );
}
