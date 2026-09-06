import { useWorkspaceOutcomeState } from "@/store/workspaceOutcomes";
import { useWorkspaceOperation } from "@/store/workspaceOperations";
import { withWorkspaceDrafts } from "@/store/workspaceDrafts";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { open } from "@tauri-apps/plugin-dialog";
import { api, imageRecompress } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";

interface ImageRecompressFlowProps {
  files: string[];
  onDone: () => void;
}

const DEFAULT_QUALITY = 75;

/**
 * Batch recompress. Takes N images at one quality (1..=100) and writes
 * them to a chosen output folder, preserving each input's basename +
 * extension. The first image op to produce a folder result.
 */
function ImageRecompressFlow({ files, onDone }: ImageRecompressFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [quality, setQuality] = useWorkspaceDraftState<number>("ImageRecompressFlow.quality", DEFAULT_QUALITY);
  const { busy, begin } = useWorkspaceOperation();
  const [error, setError] = useWorkspaceOutcomeState<string | null>("ImageRecompressFlow.error", null);

  const canApply = !busy && files.length > 0;

  async function handleApply() {
    if (!canApply) return;
    const finish = begin();
    if (!finish) return;
    setError(null);
    try {
      const dir = await open({
        directory: true,
        title: "Choose output folder",
      });
      const outDir = typeof dir === "string" ? dir : null;
      if (!outDir) {
        return;
      }
      await api.image.run(imageRecompress(files, outDir, quality));
      enqueueToast({ variant: "success", title: "Image recompress queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      finish();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted">
        Re-encode {files.length} image{files.length === 1 ? "" : "s"} at
        quality {quality}. JPEGs are re-compressed; WebPs and lossless
        formats are re-saved through the same codec.
      </p>

      <label className="flex items-center gap-3 text-sm">
        <span className="w-24 text-fg-secondary">Quality</span>
        <input
          type="range"
          min={1}
          max={100}
          step={1}
          value={quality}
          onChange={(e) => setQuality(Number(e.target.value))}
          className="flex-1 accent-accent"
        />
        <span className="w-12 text-right tabular-nums text-fg">{quality}</span>
      </label>

      <div className="flex items-center gap-3 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={!canApply}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy
            ? "Saving…"
            : `Recompress ${files.length} image${files.length === 1 ? "" : "s"}`}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}

export default withWorkspaceDrafts(ImageRecompressFlow, undefined, props => ["ImageRecompressFlow", ...props.files.slice().sort()]);
