import { useEffect, useRef, useState } from "react";

/**
 * Tween a number toward a target via exponential decay. Used by the
 * queue ETA so jittery progress updates ("ETA 12s … 11s … 13s") settle
 * smoothly instead of flickering.
 *
 * Implementation note: critically-damped exponential approach beats a
 * spring solver for monotonic targets like ETAs (no overshoot, no
 * oscillation, frame-rate independent). For elastic UI interactions
 * use a real spring.
 *
 * - `target` — desired value
 * - `stiffness` — fraction of remaining distance to close per frame
 *   at 60fps. 0.18 means "close ~18% of the gap each 16.7ms frame."
 *   Higher = snappier, lower = lazier.
 * - When `target` flips between `null` and a number, the value snaps
 *   to the new value immediately (we have no good interpolation
 *   between "no ETA known" and "ETA = 12s").
 */
export function useSpringValue(
  target: number | null,
  stiffness = 0.18,
): number | null {
  const [value, setValue] = useState<number | null>(target);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const valueRef = useRef<number | null>(target);
  valueRef.current = value;

  useEffect(() => {
    if (target === null) {
      setValue(null);
      return;
    }
    const current = valueRef.current;
    if (current === null) {
      // Snap on transition from null → number — interpolating from
      // "unknown" to a real value has no meaningful midpoint.
      setValue(target);
      return;
    }
    if (Math.abs(current - target) < 0.01) {
      // Already there; no need to animate.
      setValue(target);
      return;
    }
    let cancelled = false;
    const aim = target;
    function tick(now: number): void {
      if (cancelled) return;
      const last = lastFrameRef.current || now;
      const dtFrames = Math.min((now - last) / (1000 / 60), 4);
      lastFrameRef.current = now;
      const v: number = valueRef.current ?? aim;
      const next = v + (aim - v) * (1 - Math.pow(1 - stiffness, dtFrames));
      if (Math.abs(next - aim) < 0.05) {
        setValue(aim);
        return;
      }
      setValue(next);
      rafRef.current = requestAnimationFrame(tick);
    }
    lastFrameRef.current = 0;
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, stiffness]);

  return value;
}
