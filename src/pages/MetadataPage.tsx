import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import DropZone from "@/features/convert/DropZone";
import MetadataEditorFlow from "@/features/metadata/MetadataEditorFlow";
import { basename } from "@/features/metadata/fields";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";

// Everything goop can read metadata for. Audio is editable; image/video/PDF
// are read-only in the universal viewer.
const SUPPORTED_EXTENSIONS = [
  // audio
  "mp3", "m4a", "m4b", "aac", "flac", "ogg", "oga", "opus", "wav", "aiff", "aif", "wv", "ape",
  // image
  "jpg", "jpeg", "tif", "tiff", "heic", "heif", "png", "webp", "dng", "cr2", "cr3", "nef", "arw",
  // video
  "mp4", "mov", "m4v", "mkv", "webm", "avi",
  // documents
  "pdf",
];

function isSupported(p: string): boolean {
  const dot = p.lastIndexOf(".");
  if (dot < 0) return false;
  return SUPPORTED_EXTENSIONS.includes(p.slice(dot + 1).toLowerCase());
}

/**
 * Metadata editor (pillar #1). Owns the file list; `MetadataEditorFlow` reads
 * each file and routes to the audio editor (single or batch) and/or the
 * read-only universal viewer.
 */
export default function MetadataPage() {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [files, setFiles] = useState<string[]>([]);

  const addPaths = useCallback((paths: string[]) => {
    const fresh = paths.filter(isSupported);
    if (fresh.length === 0) return;
    setFiles((prev) => {
      const existing = new Set(prev);
      return [...prev, ...fresh.filter((p) => !existing.has(p))];
    });
  }, []);

  const handleBrowse = useCallback(async () => {
    try {
      const picked = await open({
        multiple: true,
        title: "Pick files",
        filters: [{ name: "Audio / Image / Video / PDF", extensions: SUPPORTED_EXTENSIONS }],
      });
      if (!picked) return;
      addPaths(Array.isArray(picked) ? picked : [picked]);
    } catch (e) {
      enqueueToast({
        variant: "error",
        title: "Couldn't open file picker",
        detail: formatError(e),
      });
    }
  }, [addPaths, enqueueToast]);

  const handleRemove = useCallback((path: string) => {
    setFiles((prev) => prev.filter((f) => f !== path));
  }, []);

  const handleDone = useCallback(() => {
    setFiles([]);
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <div>
        <h2 className="font-display text-2xl font-semibold text-fg">Metadata</h2>
        <p className="text-sm text-fg-muted">
          Edit audio tags &amp; cover art (single or whole albums at once), and
          view metadata for images, video, and PDFs. Audio writes happen in place.
        </p>
      </div>

      <DropZone onFiles={addPaths}>
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <p className="text-sm text-fg-secondary">Drop files here, or</p>
          <button
            type="button"
            onClick={() => void handleBrowse()}
            className="btn-press rounded-md border border-subtle bg-surface-2 px-4 py-2 text-sm font-medium text-fg hover:border-accent/60"
          >
            Pick files…
          </button>
          <p className="text-xs text-fg-muted">
            MP3, FLAC, M4A, OGG, Opus, WAV · JPEG, HEIC, PNG · MP4, MOV · PDF
          </p>
        </div>
      </DropZone>

      {files.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-fg-muted">
              {files.length} file{files.length !== 1 ? "s" : ""}
            </span>
            <button
              type="button"
              onClick={handleDone}
              className="btn-press rounded px-2 py-1 text-xs text-fg-muted hover:text-fg"
            >
              Clear
            </button>
          </div>
          <ul className="flex flex-col gap-1 text-sm text-fg-secondary">
            {files.map((p) => (
              <li
                key={p}
                className="flex items-center gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-2"
              >
                <span className="flex-1 truncate text-fg" title={p}>
                  {basename(p)}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemove(p)}
                  aria-label={`Remove ${basename(p)}`}
                  className="btn-press rounded p-1 text-xs text-fg-muted hover:bg-surface-3 hover:text-error"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <MetadataEditorFlow files={files} onDone={handleDone} />
        </>
      )}
    </div>
  );
}
