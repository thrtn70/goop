/**
 * Phase L (a11y): a "Skip to main content" link that's visually hidden
 * until it receives keyboard focus. Lets keyboard-only users jump past
 * the persistent TopBar and LeftNav on each page navigation. Targets
 * the `<main id="main">` element added in Layout.
 *
 * WCAG 2.4.1 (Bypass Blocks) — required at AA.
 */
export default function SkipNav() {
  return (
    <a
      href="#main"
      className="sr-only fixed left-2 top-2 z-[100] rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg shadow-lg focus:not-sr-only focus-visible:not-sr-only"
    >
      Skip to main content
    </a>
  );
}
