import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProgressEvent, QueueEvent, SidecarEvent } from "@/types";

type Handlers = {
  onProgress?: (e: ProgressEvent) => void;
  onQueue?: (e: QueueEvent) => void;
  onSidecar?: (e: SidecarEvent) => void;
};

export async function subscribeAll(h: Handlers): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];
  if (h.onProgress) {
    unlisteners.push(
      await listen<ProgressEvent>("goop://queue/progress", (e) => h.onProgress!(e.payload)),
    );
  }
  if (h.onQueue) {
    unlisteners.push(
      await listen<QueueEvent>("goop://queue/state_changed", (e) => h.onQueue!(e.payload)),
    );
  }
  if (h.onSidecar) {
    unlisteners.push(
      await listen<SidecarEvent>("goop://sidecar/yt_dlp_updated", (e) =>
        h.onSidecar!(e.payload),
      ),
    );
    unlisteners.push(
      await listen<SidecarEvent>("goop://sidecar/warning", (e) => h.onSidecar!(e.payload)),
    );
  }
  return () => unlisteners.forEach((u) => u());
}
