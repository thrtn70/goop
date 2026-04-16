import { useEffect, useState } from "react";
import clsx from "clsx";
import { api } from "@/ipc/commands";
import type { Toast as ToastData } from "@/store/appStore";

interface ToastProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

const VARIANT_STYLES: Record<ToastData["variant"], string> = {
  success: "bg-surface-2 border-success/40",
  error: "bg-error-subtle border-error/40",
  cancelled: "bg-surface-2 border-border",
  info: "bg-surface-2 border-accent/40",
};

const VARIANT_ICONS: Record<ToastData["variant"], string> = {
  success: "✓",
  error: "!",
  cancelled: "×",
  info: "ⓘ",
};

const VARIANT_ICON_COLORS: Record<ToastData["variant"], string> = {
  success: "text-success",
  error: "text-error",
  cancelled: "text-fg-muted",
  info: "text-accent",
};

export default function Toast({ toast, onDismiss }: ToastProps) {
  const [expanded, setExpanded] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (toast.dismissAt === null || paused) return;
    const remaining = toast.dismissAt - Date.now();
    if (remaining <= 0) {
      onDismiss(toast.id);
      return;
    }
    const handle = setTimeout(() => onDismiss(toast.id), remaining);
    return () => clearTimeout(handle);
  }, [toast.dismissAt, toast.id, paused, onDismiss]);

  const handleReveal = () => {
    if (!toast.outputPath) return;
    void api.queue.reveal(toast.outputPath);
  };

  const canReveal = Boolean(toast.outputPath) && toast.variant === "success";
  const canExpand = Boolean(toast.detail) && toast.variant === "error";

  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={clsx(
        "enter-up pointer-events-auto flex min-w-[280px] max-w-[360px] items-start gap-3 rounded-lg border p-3 shadow-lg backdrop-blur",
        VARIANT_STYLES[toast.variant],
      )}
    >
      <span
        aria-hidden
        className={clsx(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-1 text-sm font-semibold",
          VARIANT_ICON_COLORS[toast.variant],
        )}
      >
        {VARIANT_ICONS[toast.variant]}
      </span>
      <div className="flex-1 min-w-0">
        <p className="truncate text-sm font-medium text-fg">{toast.title}</p>
        {toast.detail && toast.variant !== "error" && (
          <p className="mt-0.5 truncate text-xs text-fg-secondary">{toast.detail}</p>
        )}
        {canExpand && (
          <>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-xs text-accent hover:text-accent-hover"
            >
              {expanded ? "Hide details" : "Details"}
            </button>
            {expanded && (
              <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-surface-1 p-2 text-[10px] text-fg-secondary">
                {toast.detail}
              </pre>
            )}
          </>
        )}
        {canReveal && (
          <button
            type="button"
            onClick={handleReveal}
            className="mt-1 text-xs text-accent transition duration-fast ease-out hover:text-accent-hover"
          >
            Reveal
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 text-fg-muted transition duration-fast ease-out hover:text-fg"
      >
        ×
      </button>
    </div>
  );
}
