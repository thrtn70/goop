import clsx from "clsx";

interface BrandMarkProps {
  /** Sets both width and height. Defaults to 64. */
  size?: number;
  /** Extra classes for positioning. */
  className?: string;
  /** Hide from screen readers (decorative). Defaults to true. */
  decorative?: boolean;
}

/**
 * Goop's brand mark — a soft, organic blob suggesting fluidity. The
 * shape isn't literally "a drop of goop" but reads warm and a little
 * playful, which matches the brand voice. Two stacked layers (back +
 * front) with a slight offset create the impression of motion: the
 * back layer tints toward the brand subtle, the front toward the
 * accent. CSS isolates so the SVG never bleeds blend modes.
 *
 * Used in Onboarding (welcome + ready steps) and could power a real
 * favicon / logo down the road.
 */
export default function BrandMark({
  size = 64,
  className,
  decorative = true,
}: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      role={decorative ? "presentation" : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : "Goop"}
      className={clsx("isolate", className)}
    >
      {/* Back layer: slightly larger, subtle accent tint, drifted up-left.
       *  The deliberate two-blob composition creates the soft "drop with
       *  motion behind it" look. */}
      <path
        d="M55.6 10.2c10.6 1.5 19 9.6 22.8 19.6 3.7 9.7 1.6 20.3-3.6 28.8-5 8.2-13.7 14.6-23.6 16.4-10.5 1.9-22.2-1.6-29.5-9.5-7.5-8.1-9.4-20.2-6.4-30.7C18.2 24.2 26.8 16.5 36.5 12.8c6-2.3 12.6-3.5 19.1-2.6Z"
        fill="oklch(var(--accent-subtle))"
        transform="translate(-2 -2)"
      />
      {/* Front layer: the main blob, a little softer in form than the
       *  back. The slight asymmetry — wider on the left, taper on the
       *  right — keeps it from feeling like a default circle. */}
      <path
        d="M58.2 14.8c10.4 2 18 10.6 21 20.6 3 10-.5 21-7.2 28.6-6.5 7.4-16.5 11.8-26.4 11-9.7-.7-19.4-6.4-24-14.9-4.7-8.7-3.7-19.9 1.4-28.3C28.4 23.1 37.5 16.4 47.4 14.6c3.6-.7 7.2-.5 10.8.2Z"
        fill="oklch(var(--accent))"
      />
      {/* Highlight: a small inner shape suggesting a wet sheen. Just
       *  enough to give the blob dimension without going skeuomorphic. */}
      <path
        d="M37 26c4.6-2.4 10.6-3.4 14.5-.2 1.6 1.3 1.4 3.6-.2 4.6-3.7 2.3-8.4 1.7-12.2 4.2-2 1.4-4.4 1.2-5.6-.7-1.4-2.2.7-6.2 3.5-7.9Z"
        fill="oklch(var(--accent-fg) / 0.55)"
      />
    </svg>
  );
}
