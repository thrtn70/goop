import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface DropZoneProps {
  onFiles: (paths: string[]) => void;
  children: React.ReactNode;
}

/**
 * Drop zone with three layered cues that escalate as a drag becomes
 * a drop:
 * - Idle: a soft 1px subtle border sits behind the dashed perimeter.
 * - Hovering: an inline SVG rectangle traces a flowing dash around
 *   the perimeter; a warm radial gradient overlays the zone.
 * - Just dropped: a brief warm-color ripple scales out from the zone
 *   centre and dissipates over ~600ms.
 *
 * Tauri's drag events fire at the window level and don't carry cursor
 * coordinates, so we keep all effects centred on the zone rather than
 * faking cursor follow. That sidesteps a subtle UX lie ("the gradient
 * follows my cursor!") and stays honest with what the platform reports.
 */
export default function DropZone({ onFiles, children }: DropZoneProps) {
  const [hovering, setHovering] = useState(false);
  const [ripples, setRipples] = useState<number[]>([]);
  // Track pending ripple-eviction timers so we can clear them in the
  // effect cleanup. Without this, a setTimeout that fires after
  // unmount would call setRipples on stale state.
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

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
            if (paths.length > 0) {
              // Each ripple gets its own monotonic id so multiple
              // drops stack without reusing the same React key. After
              // the animation duration the id is evicted so the DOM
              // doesn't accumulate dead nodes.
              const rippleId = Date.now() + Math.random();
              setRipples((r) => [...r, rippleId]);
              const timer = setTimeout(() => {
                if (!mounted) return;
                setRipples((r) => r.filter((id) => id !== rippleId));
                timersRef.current = timersRef.current.filter((t) => t !== timer);
              }, 700);
              timersRef.current = [...timersRef.current, timer];
              onFiles(paths);
            }
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
      // Clear all pending ripple-eviction timers so they don't fire
      // setRipples after the component is gone.
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current = [];
      void unlistenPromise.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once on mount; onFiles is stable via useCallback in parent
  }, []);

  return (
    <div
      className={`relative min-h-[120px] rounded-lg transition-colors duration-fast ease-out ${
        hovering ? "bg-accent-subtle/60" : "bg-surface-1/50"
      }`}
    >
      {/* Animated perimeter stroke. SVG sits on top, behind hit-testing,
       *  so the children remain interactive. The dash pattern slides
       *  via stroke-dashoffset keyframes when `hovering` is on. */}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        preserveAspectRatio="none"
      >
        <rect
          x="1"
          y="1"
          width="calc(100% - 2px)"
          height="calc(100% - 2px)"
          rx="8"
          ry="8"
          fill="none"
          strokeWidth="2"
          stroke={hovering ? "oklch(var(--accent))" : "oklch(var(--border))"}
          strokeDasharray="8 6"
          className={hovering ? "dropzone-stroke-flow" : "dropzone-stroke-static"}
        />
      </svg>

      {/* Warm radial overlay during hover. Centred on the zone — Tauri
       *  drag events don't give cursor position. */}
      {hovering && (
        <div
          aria-hidden="true"
          className="dropzone-glow pointer-events-none absolute inset-0 rounded-lg"
        />
      )}

      {/* On-drop ripples. Each ripple is its own absolutely-positioned
       *  span scaling from 0 to ~150% opacity-fading; cleaned up after
       *  700ms by the setTimeout above. */}
      {ripples.map((id) => (
        <span
          key={id}
          aria-hidden="true"
          className="dropzone-ripple pointer-events-none absolute left-1/2 top-1/2 h-32 w-32 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/40"
        />
      ))}

      <div className="relative">{children}</div>
    </div>
  );
}
