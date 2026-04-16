import { createPortal } from "react-dom";
import { useAppStore } from "@/store/appStore";
import Toast from "./Toast";

const MAX_VISIBLE = 3;

/**
 * Portal-mounted stack of toast notifications.
 *
 * Renders into `#toast-root` (declared in index.html). Caps at 3 visible
 * toasts; older toasts are hidden until the visible set drains (they keep
 * their own auto-dismiss timers, so they'll either disappear on their own
 * or cycle in once space is available).
 */
export default function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);

  const root = typeof document !== "undefined" ? document.getElementById("toast-root") : null;
  if (!root) return null;

  // Show the newest 3 toasts. (FIFO: older fade as they time out.)
  const visible = toasts.slice(-MAX_VISIBLE);

  return createPortal(
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
    >
      {visible.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={dismissToast} />
      ))}
    </div>,
    root,
  );
}
