import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, imageRotate } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { RotationDegrees } from "@/types";

interface ImageRotateFlowProps {
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
 * Single-image rotation. Picks one of three clockwise rotations, runs
 * the `Rotate` op via the image worker, and surfaces the queued toast.
 *
 * Output keeps the input's file extension so a JPEG rotated stays a
 * JPEG; the user picks the destination path via the OS save dialog.
 */
export default function ImageRotateFlow({ file, onDone }: ImageRotateFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [degrees, setDegrees] = useState<RotationDegrees>("cw90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApply() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ext = extOf(file);
      const dest = await save({
        defaultPath: `${stemOf(file)}-rotated.${ext}`,
        title: "Save rotated image",
      });
      if (!dest) {
        setBusy(false);
        return;
      }
      await api.image.run(imageRotate(file, degrees, dest));
      enqueueToast({ variant: "success", title: "Image rotate queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  const options: { value: RotationDegrees; label: string }[] = [
    { value: "cw90", label: "90° CW" },
    { value: "cw180", label: "180°" },
    { value: "cw270", label: "90° CCW" },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* Tab-and-click pattern with aria-pressed, matching the
       *  rationale documented in PdfOperationPicker: the ARIA radio
       *  pattern requires roving-tabindex + arrow-key handling, and
       *  shipping the role without those handlers breaks the
       *  contract for AT. Plain buttons keep the surface honest. */}
      <div
        aria-label="Rotation amount"
        className="flex flex-wrap items-center gap-2 text-xs"
      >
        <span className="text-fg-muted">Rotation:</span>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            aria-pressed={degrees === opt.value}
            onClick={() => setDegrees(opt.value)}
            className={`btn-press rounded-md px-3 py-1.5 transition duration-fast ease-out ${
              degrees === opt.value
                ? "bg-accent text-accent-fg"
                : "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Rotate image"}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}
