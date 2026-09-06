import { useWorkspaceOutcomeState } from "@/store/workspaceOutcomes";
import { useWorkspaceOperation } from "@/store/workspaceOperations";
import { withWorkspaceDrafts } from "@/store/workspaceDrafts";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { save } from "@tauri-apps/plugin-dialog";
import { api, imageWatermark } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { WatermarkPosition } from "@/types";

interface ImageWatermarkFlowProps {
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

interface PositionOption {
  value: WatermarkPosition;
  label: string;
}

const POSITIONS: PositionOption[] = [
  { value: "top_left", label: "Top left" },
  { value: "top_right", label: "Top right" },
  { value: "bottom_left", label: "Bottom left" },
  { value: "bottom_right", label: "Bottom right" },
  { value: "center", label: "Center" },
];

const DEFAULT_TEXT = "© goop";
const DEFAULT_POSITION: WatermarkPosition = "bottom_right";
const DEFAULT_OPACITY = 80;

/**
 * Text-only watermark editor. Picks the text, anchor, and opacity;
 * the backend rasterizes via the bundled Roboto Regular font and
 * composites onto the source image. v0.2.5 ships text-only;
 * image-overlay watermarks defer to v0.2.6.
 */
function ImageWatermarkFlow({ file, onDone }: ImageWatermarkFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [text, setText] = useWorkspaceDraftState("ImageWatermarkFlow.text", DEFAULT_TEXT);
  const [position, setPosition] = useWorkspaceDraftState<WatermarkPosition>("ImageWatermarkFlow.position", DEFAULT_POSITION);
  const [opacity, setOpacity] = useWorkspaceDraftState<number>("ImageWatermarkFlow.opacity", DEFAULT_OPACITY);
  const { busy, begin } = useWorkspaceOperation();
  const [error, setError] = useWorkspaceOutcomeState<string | null>("ImageWatermarkFlow.error", null);

  const canApply = !busy && text.trim().length > 0;

  async function handleApply() {
    if (!canApply) return;
    const finish = begin();
    if (!finish) return;
    setError(null);
    try {
      const ext = extOf(file);
      const dest = await save({
        defaultPath: `${stemOf(file)}-watermarked.${ext}`,
        title: "Save watermarked image",
      });
      if (!dest) {
        return;
      }
      await api.image.run(
        imageWatermark(
          file,
          { text: text.trim(), position, opacity },
          dest,
        ),
      );
      enqueueToast({ variant: "success", title: "Image watermark queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      finish();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm">
        <span className="w-24 text-fg-secondary">Text</span>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={120}
          placeholder="© Your Name"
          className="flex-1 rounded-md border border-subtle bg-surface-1 px-2 py-1 text-sm text-fg"
        />
      </label>

      <div role="group" aria-label="Watermark position" className="flex flex-col gap-2">
        <span className="text-xs text-fg-muted">Position</span>
        <div className="flex flex-wrap items-center gap-2">
          {POSITIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={position === opt.value}
              onClick={() => setPosition(opt.value)}
              className={`btn-press rounded-md px-3 py-1.5 text-xs transition duration-fast ease-out ${
                position === opt.value
                  ? "bg-accent text-accent-fg"
                  : "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-3 text-xs text-fg-muted">
        <span className="w-24">Opacity</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          className="flex-1 accent-accent"
        />
        <span className="w-12 text-right tabular-nums">{opacity}%</span>
      </label>

      <div className="flex items-center gap-3 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={!canApply}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Apply watermark"}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}

export default withWorkspaceDrafts(ImageWatermarkFlow, undefined, props => ["source", props.file]);
