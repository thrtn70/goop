/**
 * Empty-state illustration for the Compress drop zone. Suggests
 * "shrinking a file" without depicting a specific format — a muted
 * outer rectangle (the original) with a smaller accent rectangle
 * inside (the compressed result), and two arrows pressing inward.
 * Intentionally distinct from MediaBlob so Convert and Compress
 * read as different surfaces at a glance.
 *
 * Decorative; aria-hidden by default.
 */
export default function CompressBlob({ size = 96 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={Math.round(size * 0.75)}
      viewBox="0 0 128 96"
      fill="none"
      role="presentation"
      aria-hidden="true"
      className="isolate"
    >
      {/* Outer frame — the source size. Dashed border reads as
       *  "boundary that's about to shrink", not a solid container. */}
      <rect
        x="14"
        y="14"
        width="100"
        height="68"
        rx="10"
        fill="oklch(var(--surface-3))"
        stroke="oklch(var(--border))"
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
      {/* Inner frame — the compressed result. Solid accent so the
       *  eye lands here as the meaningful end state. */}
      <rect
        x="42"
        y="32"
        width="44"
        height="32"
        rx="6"
        fill="oklch(var(--accent-subtle))"
        stroke="oklch(var(--accent) / 0.5)"
        strokeWidth="1.5"
      />
      {/* Inward arrows — left and right squeezing the source toward
       *  the result. Centred on y=48 (viewBox vertical centre). */}
      <path
        d="M20 48 L36 48 M32 44 L36 48 L32 52"
        stroke="oklch(var(--accent))"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M108 48 L92 48 M96 44 L92 48 L96 52"
        stroke="oklch(var(--accent))"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
