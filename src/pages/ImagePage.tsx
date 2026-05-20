import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import DropZone from "@/features/convert/DropZone";
import ImageOperationPicker, {
  type ImageOperationKind,
} from "@/features/image/ImageOperationPicker";
import ImageRotateFlow from "@/features/image/ImageRotateFlow";
import ImageResizeFlow from "@/features/image/ImageResizeFlow";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";

const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "gif",
  "tiff",
  "tif",
  "avif",
  "jxl",
  "heic",
  "heif",
];

function isImage(p: string): boolean {
  const dot = p.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.includes(p.slice(dot + 1).toLowerCase());
}

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

/**
 * Image Workshop landing page. Owns the file list and the currently
 * selected operation; the per-op flow component (rotate, resize, etc.)
 * owns the operation-specific form + Apply button. Mirrors the same
 * "page owns inputs, flow owns submit" split that `PdfFlow` uses, so
 * the two routes stay structurally similar.
 *
 * v0.2.5 Phase 4 ships Rotate + Resize. Phases 5–7 fill in Crop,
 * Watermark, Recompress, AppIcon; the picker greys them out with a
 * "soon" badge in the meantime.
 */
export default function ImagePage() {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [files, setFiles] = useState<string[]>([]);
  const [op, setOp] = useState<ImageOperationKind>("rotate");
  const multiFile = files.length > 1;

  // Phase 4 ships only single-file ops. When multiFile is true the
  // picker shows the current op as disabled with a "drop a single
  // image" hint; the op-specific flow guards on `files.length === 1`
  // and renders nothing in that state. An auto-switch lands in
  // Phase 6 with `recompress` (the first `multiFileOk` op).

  const addPaths = useCallback((paths: string[]) => {
    const fresh = paths.filter(isImage);
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
        title: "Pick images",
        filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
      });
      if (!picked) return;
      const next = Array.isArray(picked) ? picked : [picked];
      addPaths(next);
    } catch (e) {
      enqueueToast({
        variant: "error",
        title: "Couldn't open image picker",
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
        <h2 className="font-display text-2xl font-semibold text-fg">
          Image Workshop
        </h2>
        <p className="text-sm text-fg-muted">
          Rotate, resize, and (soon) crop / watermark / app-icon export. Drop
          one or more images, pick an operation, and run.
        </p>
      </div>

      <DropZone onFiles={addPaths}>
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <p className="text-sm text-fg-secondary">
            Drop images here, or
          </p>
          <button
            type="button"
            onClick={() => void handleBrowse()}
            className="btn-press rounded-md border border-subtle bg-surface-2 px-4 py-2 text-sm font-medium text-fg hover:border-accent/60"
          >
            Pick images…
          </button>
          <p className="text-[11px] text-fg-muted">
            PNG, JPEG, WebP, BMP, GIF, TIFF, AVIF, JXL, HEIC
          </p>
        </div>
      </DropZone>

      {files.length > 0 && (
        <>
          <div className="text-xs text-fg-muted">
            {files.length} image{files.length !== 1 ? "s" : ""}
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

          <ImageOperationPicker
            selected={op}
            onSelect={setOp}
            multiFile={multiFile}
          />

          {files.length === 1 && op === "rotate" && (
            <ImageRotateFlow file={files[0]} onDone={handleDone} />
          )}
          {files.length === 1 && op === "resize" && (
            <ImageResizeFlow file={files[0]} onDone={handleDone} />
          )}
        </>
      )}
    </div>
  );
}
