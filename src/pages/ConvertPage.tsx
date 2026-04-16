import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import DropZone from "@/features/convert/DropZone";
import FileRow from "@/features/convert/FileRow";
import type { FileRowOptions } from "@/features/convert/FileRow";
import ConvertActionBar from "@/features/convert/ConvertActionBar";
import type { FileEntry } from "@/features/convert/ConvertActionBar";
import type { TargetFormat } from "@/types";

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const last = normalized.lastIndexOf("/");
  return last > 0 ? normalized.slice(0, last) : ".";
}

export default function ConvertPage() {
  const [files, setFiles] = useState<FileEntry[]>([]);

  const addPaths = useCallback((paths: string[]) => {
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.path));
      const fresh: FileEntry[] = paths
        .filter((p) => !existing.has(p))
        .map((p) => ({
          path: p,
          target: "mp4" as TargetFormat,
          sourceDir: dirname(p),
          qualityPreset: "original",
          resolutionCap: "original",
          gifOptions: null,
        }));
      return [...prev, ...fresh];
    });
  }, []);

  const handleOptionsChange = useCallback((path: string, opts: FileRowOptions) => {
    setFiles((prev) =>
      prev.map((f) =>
        f.path === path
          ? {
              ...f,
              target: opts.target,
              qualityPreset: opts.qualityPreset,
              resolutionCap: opts.resolutionCap,
              gifOptions: opts.gifOptions,
            }
          : f,
      ),
    );
  }, []);

  const handleRemove = useCallback((path: string) => {
    setFiles((prev) => prev.filter((f) => f.path !== path));
  }, []);

  const handleBrowse = async () => {
    const picked = await open({
      multiple: true,
      title: "Select files to convert",
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
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-fg-muted/30">
              <path d="M20 28V12M14 18l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
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
            <p className="mt-1 text-xs text-fg-muted">Video, audio, and images. Goop picks the best format automatically.</p>
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
        <div className="mt-4 flex flex-1 flex-col gap-2 overflow-auto">
          {files.map((f, i) => (
            <FileRow
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
          <ConvertActionBar
            files={files}
            disabled={false}
            onEnqueued={() => setFiles([])}
          />
        </div>
      )}
    </div>
  );
}
