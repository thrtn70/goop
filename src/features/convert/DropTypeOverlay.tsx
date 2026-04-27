interface DropTypeOverlayProps {
  visible: boolean;
}

/**
 * Generic drop-target pulse shown when the user is dragging files over
 * any of the Convert/Compress/Extract pages. Tauri 2's drag-over event
 * doesn't leak file paths until the drop, so we can't show per-file-type
 * icons — a single consistent affordance instead.
 */
export default function DropTypeOverlay({ visible }: DropTypeOverlayProps) {
  if (!visible) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <div className="animate-pulse rounded-full bg-accent/20 px-4 py-2 text-xs font-medium text-accent">
        Drop to add
      </div>
    </div>
  );
}
