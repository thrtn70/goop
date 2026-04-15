import { useEffect, useState } from "react";

export function useDropTarget(onFiles?: (paths: string[]) => void) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let counter = 0;
    const enter = (e: DragEvent) => {
      e.preventDefault();
      counter++;
      setActive(true);
    };
    const leave = (e: DragEvent) => {
      e.preventDefault();
      counter = Math.max(0, counter - 1);
      if (counter === 0) setActive(false);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      counter = 0;
      setActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length && onFiles) {
        // Note: File.path is non-standard — only populated in Tauri's webview.
        // Fall back to File.name for tests / non-Tauri environments.
        onFiles(files.map((f) => (f as File & { path?: string }).path ?? f.name));
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [onFiles]);
  return active;
}
