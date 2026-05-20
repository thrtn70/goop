import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import CropEditor, { type EditorRect } from "./CropEditor";
import { api, imageCrop } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";

interface ImageCropFlowProps {
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

function extOf(p: string): string {
  const name = basename(p);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "png";
}

/**
 * Interactive crop. Renders `CropEditor` (react-easy-crop wrapper) and
 * an Apply button. The editor reports the current rectangle in
 * source-pixel coords via `onChange`; we hand that straight to the
 * `imageCrop` IPC builder when the user picks an output path.
 */
export default function ImageCropFlow({ file, onDone }: ImageCropFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [rect, setRect] = useState<EditorRect | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canApply = rect !== null && !busy;

  async function handleApply() {
    if (!canApply || rect === null) return;
    setBusy(true);
    setError(null);
    try {
      const ext = extOf(file);
      const dest = await save({
        defaultPath: `${stemOf(file)}-cropped.${ext}`,
        title: "Save cropped image",
      });
      if (!dest) {
        setBusy(false);
        return;
      }
      await api.image.run(imageCrop(file, rect, dest));
      enqueueToast({ variant: "success", title: "Image crop queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <CropEditor file={file} onChange={setRect} />
      <div className="flex items-center gap-3 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={!canApply}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy
            ? "Saving…"
            : rect === null
              ? "Adjust the crop above"
              : `Crop to ${rect.width}×${rect.height}`}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}
