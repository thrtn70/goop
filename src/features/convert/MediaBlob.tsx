/**
 * Empty-state illustration for the Convert / Compress drop zones.
 * Suggests "media files stacked together" without specifying a format —
 * three soft, asymmetric rounded shapes layered with a slight rotation
 * so they read as a small pile rather than identical icons. Tinted
 * toward the accent so the brand colour reaches into otherwise-quiet
 * empty surfaces.
 *
 * Decorative; aria-hidden by default.
 */
export default function MediaBlob({ size = 96 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={Math.round(size * 0.75)}
      viewBox="0 0 128 96"
      fill="none"
      role="presentation"
      aria-hidden
      className="isolate"
    >
      {/* Back tile — most muted, slight clockwise tilt */}
      <rect
        x="14"
        y="22"
        width="56"
        height="58"
        rx="10"
        transform="rotate(-6 42 51)"
        fill="oklch(var(--surface-3))"
        stroke="oklch(var(--border))"
        strokeWidth="1.5"
      />
      {/* Middle tile — closer to centre, lighter weight */}
      <rect
        x="46"
        y="14"
        width="62"
        height="64"
        rx="11"
        transform="rotate(4 77 46)"
        fill="oklch(var(--surface-2))"
        stroke="oklch(var(--border))"
        strokeWidth="1.5"
      />
      {/* Front tile — brand accent tint, no rotation. The "primary" file. */}
      <rect
        x="38"
        y="26"
        width="64"
        height="56"
        rx="10"
        fill="oklch(var(--accent-subtle))"
        stroke="oklch(var(--accent) / 0.4)"
        strokeWidth="1.5"
      />
      {/* Front-tile inner glyph: a play triangle that suggests "media".
       *  Centred on the front tile (38+32, 26+28) = (70, 54). Soft
       *  accent-fg fill so it reads as a label, not an icon. */}
      <path
        d="M64 44 L80 54 L64 64 Z"
        fill="oklch(var(--accent) / 0.5)"
      />
    </svg>
  );
}
