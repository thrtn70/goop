import { useCallback } from "react";
import { useAppStore } from "@/store/appStore";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";

export function useRevealFile(): (path: string) => Promise<void> {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  return useCallback(
    async (path: string) => {
      try {
        await api.queue.reveal(path);
      } catch (e) {
        enqueueToast({
          variant: "info",
          title: "File moved or deleted",
          detail: formatError(e),
        });
      }
    },
    [enqueueToast],
  );
}
