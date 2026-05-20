import { useCallback, useEffect, useMemo, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { CropRect } from "@/types";

/** Pixel-space rect emitted to the parent flow on every crop change.
 *  Mirrors the `goop_core::CropRect` shape so the parent can hand it
 *  straight to the IPC builder without mapping. */
export type EditorRect = CropRect;

export type AspectPreset = "free" | "1:1" | "4:3" | "16:9";

interface CropEditorProps {
  /** Absolute filesystem path to the source image. The editor wraps
   *  it via `convertFileSrc` so the Tauri asset protocol serves it
   *  to the WebView with the correct CSP allowance. */
  file: string;
  /** Called whenever the user finishes a drag / zoom adjustment with
   *  the current rectangle in source-pixel coordinates. */
  onChange: (rect: EditorRect | null) => void;
}

function aspectOf(preset: AspectPreset): number | undefined {
  switch (preset) {
    case "1:1":
      return 1;
    case "4:3":
      return 4 / 3;
    case "16:9":
      return 16 / 9;
    case "free":
      return undefined;
  }
}

/**
 * react-easy-crop wrapper with an aspect-ratio preset toolbar. The
 * `Cropper` component renders absolutely positioned inside the
 * surrounding `relative` div — it needs an explicit pixel height,
 * which we set to `h-96` (24rem) below.
 *
 * Switching aspect presets does *not* discard the current crop —
 * react-easy-crop reconciles the box to the new ratio while keeping
 * it centred on the current focus. The user can still nudge from
 * there.
 */
export default function CropEditor({ file, onChange }: CropEditorProps) {
  const [aspect, setAspect] = useState<AspectPreset>("free");
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  // convertFileSrc is a stable synchronous helper but we memoize so
  // the Cropper's `image` prop doesn't churn each render and force a
  // reload.
  const imageSrc = useMemo(() => convertFileSrc(file), [file]);

  const onCropComplete = useCallback(
    (_croppedArea: Area, croppedAreaPixels: Area) => {
      // `Area` from react-easy-crop is in fractional pixels relative
      // to the natural image dimensions — round before handing to
      // the Rust side which expects integer `u32` coords.
      onChange({
        x: Math.max(0, Math.round(croppedAreaPixels.x)),
        y: Math.max(0, Math.round(croppedAreaPixels.y)),
        width: Math.max(1, Math.round(croppedAreaPixels.width)),
        height: Math.max(1, Math.round(croppedAreaPixels.height)),
      });
    },
    [onChange],
  );

  // Reset the crop state when the file changes so a new image
  // doesn't start at the previous image's coordinates.
  useEffect(() => {
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    onChange(null);
  }, [file, onChange]);

  const presets: AspectPreset[] = ["free", "1:1", "4:3", "16:9"];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-fg-muted">Aspect:</span>
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={aspect === preset}
            onClick={() => setAspect(preset)}
            className={`btn-press rounded-md px-3 py-1.5 transition duration-fast ease-out ${
              aspect === preset
                ? "bg-accent text-accent-fg"
                : "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg"
            }`}
          >
            {preset === "free" ? "Free" : preset}
          </button>
        ))}
      </div>

      <div className="relative h-96 overflow-hidden rounded-lg border border-subtle bg-surface-0">
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          aspect={aspectOf(aspect)}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropComplete}
          showGrid
          objectFit="contain"
        />
      </div>

      <label className="flex items-center gap-3 text-xs text-fg-muted">
        <span className="w-12">Zoom</span>
        <input
          type="range"
          min={1}
          max={4}
          step={0.05}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="flex-1 accent-accent"
        />
        <span className="w-12 text-right tabular-nums">{zoom.toFixed(2)}×</span>
      </label>
    </div>
  );
}
