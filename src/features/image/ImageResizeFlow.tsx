import { withWorkspaceDrafts } from "@/store/workspaceDrafts";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, imageResize } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { ResizeMode } from "@/types";

interface ImageResizeFlowProps {
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

interface ModeOption {
  value: ResizeMode;
  label: string;
  hint: string;
}

const MODES: ModeOption[] = [
  {
    value: "fit_within",
    label: "Fit within",
    hint: "Preserve aspect ratio, fit inside the target box",
  },
  {
    value: "fit_exact",
    label: "Fit exact",
    hint: "Stretch or squash to exact dimensions",
  },
  {
    value: "scale",
    label: "Scale %",
    hint: "Resize by a percentage of the source size",
  },
];

const DEFAULT_BOX = 1024;
const DEFAULT_SCALE = 50;

/**
 * Single-image resize. Three modes:
 * - `fit_within` and `fit_exact` use the (width, height) inputs.
 * - `scale` uses the width input as a percentage (1–2000); height is
 *   ignored.
 *
 * Inputs are clamped numerically; the backend re-validates and returns
 * a friendly error for zero / overflow values.
 */
function ImageResizeFlow({ file, onDone }: ImageResizeFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [mode, setMode] = useWorkspaceDraftState<ResizeMode>("ImageResizeFlow.mode", "fit_within");
  const [width, setWidth] = useWorkspaceDraftState<number>("ImageResizeFlow.width", DEFAULT_BOX);
  const [height, setHeight] = useWorkspaceDraftState<number>("ImageResizeFlow.height", DEFAULT_BOX);
  const [scale, setScale] = useWorkspaceDraftState<number>("ImageResizeFlow.scale", DEFAULT_SCALE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isScale = mode === "scale";
  const canApply = !busy && (isScale ? scale >= 1 && scale <= 2000 : width > 0 && height > 0);

  async function handleApply() {
    if (!canApply) return;
    setBusy(true);
    setError(null);
    try {
      const ext = extOf(file);
      const dest = await save({
        defaultPath: `${stemOf(file)}-resized.${ext}`,
        title: "Save resized image",
      });
      if (!dest) {
        setBusy(false);
        return;
      }
      // Scale mode encodes the percentage in `width`; height is ignored
      // (the backend reads `width` as the percent and computes new
      // dimensions itself). Use 0 for height as a small marker.
      const op = isScale
        ? imageResize(file, scale, 0, "scale", dest)
        : imageResize(file, width, height, mode, dest);
      await api.image.run(op);
      enqueueToast({ variant: "success", title: "Image resize queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* aria-pressed buttons (not a real radiogroup) — same rationale
       *  as PdfOperationPicker: shipping role="radio" without
       *  roving-tabindex + arrow-key cycling breaks the AT contract. */}
      <div aria-label="Resize mode" className="flex flex-col gap-2">
        {MODES.map((opt) => {
          const active = mode === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() => setMode(opt.value)}
              className={`flex items-start gap-3 rounded-lg border p-3 text-left transition duration-fast ease-out ${
                active
                  ? "border-accent bg-accent-subtle"
                  : "border-subtle bg-surface-1 hover:border-accent/60"
              }`}
            >
              <span
                className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  active ? "border-accent bg-accent" : "border-fg-muted"
                }`}
                aria-hidden="true"
              >
                {active && (
                  <span className="h-1.5 w-1.5 rounded-full bg-accent-fg" />
                )}
              </span>
              <span>
                <span className="block text-sm font-medium text-fg">
                  {opt.label}
                </span>
                <span className="block text-xs text-fg-muted">{opt.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      {isScale ? (
        <label className="flex items-center gap-2 text-sm">
          <span className="w-24 text-fg-secondary">Scale (%)</span>
          <input
            type="number"
            min={1}
            max={2000}
            value={scale}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next)) setScale(Math.round(next));
            }}
            className="w-28 rounded-md border border-subtle bg-surface-1 px-2 py-1 text-sm text-fg"
          />
          <span className="text-xs text-fg-muted">1–2000</span>
        </label>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="w-24 text-fg-secondary">Width (px)</span>
            <input
              type="number"
              min={1}
              max={32768}
              value={width}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next)) setWidth(Math.round(next));
              }}
              className="w-28 rounded-md border border-subtle bg-surface-1 px-2 py-1 text-sm text-fg"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="w-24 text-fg-secondary">Height (px)</span>
            <input
              type="number"
              min={1}
              max={32768}
              value={height}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next)) setHeight(Math.round(next));
              }}
              className="w-28 rounded-md border border-subtle bg-surface-1 px-2 py-1 text-sm text-fg"
            />
          </label>
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={!canApply}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Resize image"}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}

export default withWorkspaceDrafts(ImageResizeFlow, undefined, props => ["source", props.file]);
