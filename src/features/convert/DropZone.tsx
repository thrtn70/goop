import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface DropZoneProps {
  onFiles: (paths: string[]) => void;
  children: React.ReactNode;
}

export default function DropZone({ onFiles, children }: DropZoneProps) {
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    let mounted = true;
    const setup = async () => {
      try {
        const unlisten = await getCurrentWindow().onDragDropEvent((event) => {
          if (!mounted) return;
          if (event.payload.type === "over") {
            setHovering(true);
          } else if (event.payload.type === "drop") {
            setHovering(false);
            const paths = event.payload.paths;
            if (paths.length > 0) onFiles(paths);
          } else {
            setHovering(false);
          }
        });
        return unlisten;
      } catch {
        return () => {};
      }
    };
    const unlistenPromise = setup();
    return () => {
      mounted = false;
      void unlistenPromise.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once on mount; onFiles is stable via useCallback in parent
  }, []);

  return (
    <div
      className={`min-h-[120px] rounded-lg border-2 border-dashed transition duration-fast ease-out ${
        hovering
          ? "border-accent bg-accent-subtle"
          : "border-border bg-surface-1/50"
      }`}
    >
      {children}
    </div>
  );
}
