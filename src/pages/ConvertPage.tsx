import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import DropZone from "@/features/convert/DropZone";
import FileRow from "@/features/convert/FileRow";
import ConvertActionBar from "@/features/convert/ConvertActionBar";
import type { TargetFormat } from "@/types";

interface FileEntry {
  path: string;
  target: TargetFormat;
  sourceDir: string;
}

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
      const fresh = paths
        .filter((p) => !existing.has(p))
        .map((p) => ({ path: p, target: "mp4" as TargetFormat, sourceDir: dirname(p) }));
      return [...prev, ...fresh];
    });
  }, []);

  const handleTargetChange = useCallback((path: string, target: TargetFormat) => {
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, target } : f)));
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
          <div className="flex flex-col items-center justify-center py-10 text-center text-neutral-500">
            <div className="text-4xl">↻</div>
            <p className="mt-2">
              Drop files here to convert, or{" "}
              <button
                type="button"
                onClick={() => void handleBrowse()}
                className="text-sky-400 underline hover:text-sky-300"
              >
                browse
              </button>
              .
            </p>
          </div>
        )}
        {hasFiles && (
          <div className="p-3">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs text-neutral-400">
                {files.length} file{files.length !== 1 ? "s" : ""}
              </span>
              <button
                type="button"
                onClick={() => void handleBrowse()}
                className="text-xs text-sky-400 hover:text-sky-300"
              >
                Add more…
              </button>
            </div>
          </div>
        )}
      </DropZone>

      {hasFiles && (
        <div className="mt-4 flex flex-1 flex-col gap-2 overflow-auto">
          {files.map((f) => (
            <FileRow
              key={f.path}
              path={f.path}
              onTargetChange={handleTargetChange}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}

      {hasFiles && (
        <div className="mt-4 border-t border-neutral-800 pt-4">
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
