import { createPortal } from "react-dom";
import { useAppStore } from "@/store/appStore";
import Toast from "./Toast";

const MAX_VISIBLE = 3;

/**
 * Portal-mounted stack of toast notifications.
 *
 * Renders into `#toast-root` (declared in index.html). Caps at 3 visually
 * presented toasts while mounting older overflow offscreen, so every event
 * still gets exactly one semantic live-region owner and its normal timer.
 */
export default function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);

  const root = typeof document !== "undefined" ? document.getElementById("toast-root") : null;
  if (!root) return null;

  const newest = toasts.slice(-MAX_VISIBLE);
  const visibleIds = new Set(newest.map((toast) => toast.id));
  const activeToastId =
    typeof document !== "undefined" && document.activeElement instanceof Element
      ? document.activeElement.closest<HTMLElement>("[data-toast-id]")?.dataset.toastId
      : undefined;
  if (
    activeToastId &&
    !visibleIds.has(activeToastId) &&
    toasts.some((toast) => toast.id === activeToastId)
  ) {
    const oldestNewest = newest[0];
    if (oldestNewest) visibleIds.delete(oldestNewest.id);
    visibleIds.add(activeToastId);
  }

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <Toast
          key={t.id}
          toast={t}
          onDismiss={dismissToast}
          visuallyHidden={!visibleIds.has(t.id)}
        />
      ))}
    </div>,
    root,
  );
}
