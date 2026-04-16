/** @type {import('tailwindcss').Config} */

/* Helper: wrap OKLCH component vars so Tailwind can inject <alpha-value> */
const oklch = (v) => `oklch(var(${v}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: oklch("--surface-0"),
          1: oklch("--surface-1"),
          2: oklch("--surface-2"),
          3: oklch("--surface-3"),
        },
        fg: {
          DEFAULT: oklch("--fg"),
          secondary: oklch("--fg-secondary"),
          muted: oklch("--fg-muted"),
        },
        accent: {
          DEFAULT: oklch("--accent"),
          hover: oklch("--accent-hover"),
          subtle: oklch("--accent-subtle"),
          fg: oklch("--accent-fg"),
        },
        success: {
          DEFAULT: oklch("--success"),
          subtle: oklch("--success-subtle"),
        },
        error: {
          DEFAULT: oklch("--error"),
          subtle: oklch("--error-subtle"),
        },
        warning: {
          DEFAULT: oklch("--warning"),
          subtle: oklch("--warning-subtle"),
        },
      },
      borderColor: {
        DEFAULT: oklch("--border"),
        subtle: oklch("--border-subtle"),
      },
      fontFamily: {
        display: "var(--font-display)",
        body: "var(--font-body)",
      },
      fontSize: {
        xs: ["var(--text-xs)", { lineHeight: "var(--leading-normal)" }],
        sm: ["var(--text-sm)", { lineHeight: "var(--leading-normal)" }],
        base: ["var(--text-base)", { lineHeight: "var(--leading-normal)" }],
        lg: ["var(--text-lg)", { lineHeight: "var(--leading-tight)" }],
        xl: ["var(--text-xl)", { lineHeight: "var(--leading-tight)" }],
        "2xl": ["var(--text-2xl)", { lineHeight: "var(--leading-tight)" }],
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        full: "var(--radius-full)",
      },
      spacing: {
        1: "var(--space-1)",
        2: "var(--space-2)",
        3: "var(--space-3)",
        4: "var(--space-4)",
        6: "var(--space-6)",
        8: "var(--space-8)",
        12: "var(--space-12)",
        16: "var(--space-16)",
        24: "var(--space-24)",
      },
      transitionDuration: {
        instant: "var(--duration-instant)",
        fast: "var(--duration-fast)",
        normal: "var(--duration-normal)",
        slow: "var(--duration-slow)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        in: "var(--ease-in)",
        "in-out": "var(--ease-in-out)",
      },
    },
  },
  plugins: [],
};
