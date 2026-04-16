import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import DropZone from "@/features/convert/DropZone";
import CompressFileRow from "@/features/compress/CompressFileRow";
import type { CompressRowOptions } from "@/features/compress/CompressFileRow";
import CompressActionBar from "@/features/compress/CompressActionBar";
import type { CompressFileEntry } from "@/features/compress/CompressActionBar";
import PresetChips from "@/features/presets/PresetChips";
import type { Preset, TargetFormat } from "@/types";

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const last = normalized.lastIndexOf("/");
  return last > 0 ? normalized.slice(0, last) : ".";
}

/**
 * Guess the target format from a file extension. Compress keeps the source
 * format — this is just for the output filename. The backend verifies.
 */
function targetFromPath(path: string): TargetFormat {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, TargetFormat> = {
    mp4: "mp4",
    m4v: "mp4",
    mkv: "mkv",
    webm: "webm",
    avi: "avi",
    mov: "mov",
    mp3: "mp3",
    m4a: "m4a",
    opus: "opus",
    wav: "wav",
    flac: "flac",
    ogg: "ogg",
    aac: "aac",
    png: "png",
    jpg: "jpeg",
    jpeg: "jpeg",
    webp: "webp",
    bmp: "bmp",
  };
  return map[ext] ?? "mp4";
}

export default function CompressPage() {
  const [files, setFiles] = useState<CompressFileEntry[]>([]);

  const addPaths = useCallback((paths: string[]) => {
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.path));
      const fresh: CompressFileEntry[] = paths
        .filter((p) => !existing.has(p))
        .map((p) => ({
          path: p,
          target: targetFromPath(p),
          sourceDir: dirname(p),
          mode: { kind: "quality", value: 75 },
        }));
      return [...prev, ...fresh];
    });
  }, []);

  const handleOptionsChange = useCallback(
    (path: string, opts: CompressRowOptions) => {
      setFiles((prev) =>
        prev.map((f) => (f.path === path ? { ...f, mode: opts.mode } : f)),
      );
    },
    [],
  );

  const handleRemove = useCallback((path: string) => {
    setFiles((prev) => prev.filter((f) => f.path !== path));
  }, []);

  const applyPreset = useCallback((preset: Preset) => {
    if (!preset.compress_mode) return;
    const mode = preset.compress_mode;
    setFiles((prev) => prev.map((f) => ({ ...f, mode })));
  }, []);

  const handleBrowse = async () => {
    const picked = await open({
      multiple: true,
      title: "Select files to compress",
    });
    if (picked) {
      const paths = Array.isArray(picked) ? picked : [picked];
      addPaths(paths.filter((p): p is string => typeof p === "string"));
    }
  };

  const hasFiles = files.length > 0;

  return (
    <div className="flex h-full flex-col p-6">
      <DropZone onFiles={addPaths}>
        {!hasFiles && (
          <div className="enter-up flex flex-col items-center justify-center py-12 text-center">
            <svg
              width="40"
              height="40"
              viewBox="0 0 40 40"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-fg-muted/30"
            >
              <path d="M14 22V14a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v8" strokeLinecap="round" />
              <path d="M12 30h16" strokeLinecap="round" />
              <rect x="4" y="4" width="32" height="32" rx="6" strokeDasharray="4 3" />
            </svg>
            <p className="mt-3 text-sm text-fg-secondary">
              Drop files here, or{" "}
              <button
                type="button"
                onClick={() => void handleBrowse()}
                className="text-accent transition duration-fast ease-out hover:text-accent-hover"
              >
                pick from your computer
              </button>
              .
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              Video, audio, and images. Smaller files, same format.
            </p>
          </div>
        )}
        {hasFiles && (
          <div className="p-3">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs text-fg-muted">
                {files.length} file{files.length !== 1 ? "s" : ""}
              </span>
              <button
                type="button"
                onClick={() => void handleBrowse()}
                className="text-xs text-accent transition duration-fast ease-out hover:text-accent-hover"
              >
                Add more...
              </button>
            </div>
          </div>
        )}
      </DropZone>

      {hasFiles && (
        <div className="mt-3">
          <PresetChips kind="compress" onApply={applyPreset} />
        </div>
      )}

      {hasFiles && (
        <div className="mt-2 flex flex-1 flex-col gap-2 overflow-auto">
          {files.map((f, i) => (
            <CompressFileRow
              key={f.path}
              path={f.path}
              index={i}
              onOptionsChange={handleOptionsChange}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}

      {hasFiles && (
        <div className="mt-4 border-t border-subtle pt-4">
          <CompressActionBar
            files={files}
            disabled={false}
            onEnqueued={() => setFiles([])}
          />
        </div>
      )}
    </div>
  );
}
