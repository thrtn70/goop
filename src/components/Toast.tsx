import { useEffect, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, Check, Info, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRevealFile } from "@/hooks/useRevealFile";
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
  warning: "bg-warning-subtle border-warning/40",
};

const VARIANT_ICONS: Record<ToastData["variant"], LucideIcon> = {
  success: Check,
  error: AlertTriangle,
  cancelled: X,
  info: Info,
  warning: AlertTriangle,
};

const VARIANT_ICON_COLORS: Record<ToastData["variant"], string> = {
  success: "text-success",
  error: "text-error",
  cancelled: "text-fg-muted",
  info: "text-accent",
  warning: "text-warning",
};

function truncateForAria(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export default function Toast({ toast, onDismiss }: ToastProps) {
  const [expanded, setExpanded] = useState(false);
  const [paused, setPaused] = useState(false);
  const revealFile = useRevealFile();

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
    void revealFile(toast.outputPath);
  };

  const canReveal = Boolean(toast.outputPath) && toast.variant === "success";
  const canExpand = Boolean(toast.detail) && toast.variant === "error";

  // Errors should pre-empt other content (`role="alert"` +
  // `aria-live="assertive"`); successes / info / cancels queue politely.
  const isError = toast.variant === "error";
  const Icon = VARIANT_ICONS[toast.variant];
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={clsx(
        "enter-up pointer-events-auto flex min-w-[280px] max-w-[360px] items-start gap-3 rounded-lg border p-3 shadow-lg backdrop-blur",
        VARIANT_STYLES[toast.variant],
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-1",
          VARIANT_ICON_COLORS[toast.variant],
        )}
      >
        <Icon size={12} strokeWidth={2.5} />
      </span>
      <div className="flex-1 min-w-0">
        <p className="truncate text-sm font-medium text-fg">{toast.title}</p>
        {toast.detail && toast.variant !== "error" && (
          <p className="mt-0.5 truncate text-xs text-fg-secondary">
            {toast.detail}
          </p>
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
            {/* Capped and scrollable. The container grows upward from the
             *  bottom of the viewport and an error toast never
             *  auto-dismisses, so an uncapped block pushes this toast's own
             *  dismiss button off the top of the screen and strands it
             *  there. `tabIndex` because a scroll container a keyboard user
             *  cannot focus is a scroll container they cannot read. */}
            {expanded && (
              <pre
                tabIndex={0}
                className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-1 p-2 text-[10px] text-fg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
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
        aria-label={`Dismiss: ${truncateForAria(toast.title)}`}
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 text-fg-muted transition duration-fast ease-out hover:text-fg"
      >
        <X size={14} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </div>
  );
}
