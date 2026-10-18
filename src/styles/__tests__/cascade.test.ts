import { describe, expect, it } from "vitest";
import css from "../index.css?raw";

/* Why this file exists.
 *
 * Tailwind 4 emits its output into native cascade layers (`theme`, `base`,
 * `components`, `utilities`), and any rule outside a layer beats every rule
 * inside one, whatever the specificity. So in index.css, *where* a rule sits
 * decides who wins, and two placements are load-bearing:
 *
 * - The global `:focus-visible` outline has to sit in `@layer base`. Left
 *   unlayered it beats `focus:outline-hidden`, and the 38 controls that turn
 *   it off (37 draw their own ring) get a second indicator on top.
 * - The motion classes, the workspace layout and the reduced-motion
 *   catch-all have to stay unlayered. Tailwind 3 let them win ties on source
 *   order; unlayered is what lets them keep winning. Inside a layer,
 *   `transition duration-fast` would override `.btn-press`, and
 *   `animate-pulse` would outrank the reduced-motion `animation: none`.
 *
 * Nothing about either fails loudly, so the placement is asserted here. */

/** Comments removed, strings kept. String-aware because index.css has
 *  `@source "../**\/*.{ts,tsx}"`, whose glob reads as a comment opener to a
 *  plain regex. */
function stripComments(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const end = source.indexOf(ch, i + 1);
      const stop = end === -1 ? source.length : end + 1;
      out += source.slice(i, stop);
      i = stop - 1;
    } else if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Splits a selector list on top-level commas only, so `:is(a, b)` stays one. */
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

interface Placed {
  selector: string;
  /** Enclosing at-rule preludes, outermost first, e.g. ["@layer base"]. */
  atRules: string[];
  /** Declarations, as written. */
  body: string;
}

/** Every style rule with the at-rules around it. Brace-matched, and blind to
 *  braces inside strings, so nested `@media` inside `@layer` (and the
 *  reverse) keep their real scope. */
function placedRules(source: string): Placed[] {
  const out: Placed[] = [];
  const stack: { head: string; rules: Placed[] }[] = [];
  let prelude = "";
  let quote: string | null = null;
  for (const ch of stripComments(source)) {
    for (const open of stack) for (const rule of open.rules) rule.body += ch;
    if (quote) {
      if (ch === quote) quote = null;
      prelude += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      prelude += ch;
    } else if (ch === "{") {
      const head = prelude.trim().replace(/\s+/g, " ");
      const atRules = stack.map((s) => s.head).filter((h) => h.startsWith("@"));
      const rules = head.startsWith("@")
        ? []
        : splitSelectors(head).map((selector) => ({ selector, atRules, body: "" }));
      out.push(...rules);
      stack.push({ head, rules });
      prelude = "";
    } else if (ch === "}") {
      stack.pop();
      prelude = "";
    } else if (ch === ";") {
      prelude = "";
    } else {
      prelude += ch;
    }
  }
  return out;
}

const rules = placedRules(css);

const REDUCED_MOTION = "prefers-reduced-motion";
const inReducedMotion = (p: Placed) => p.atRules.some((a) => a.includes(REDUCED_MOTION));

/** Layered in the cascade sense: Tailwind compiles `@utility` and `@theme`
 *  contents into its own layers too. */
const layered = (p: Placed, name?: string) =>
  p.atRules.some((a) =>
    name ? a === `@layer ${name}` : /^@(layer|utility|theme)\b/.test(a),
  );

const where = (p: Placed) => p.atRules.join(" > ") || "nothing";

function placementsOf(selector: string): Placed[] {
  const found = rules.filter((r) => r.selector === selector);
  // Anti-vacuity: a selector that is not in the file would make every
  // "not inside a layer" assertion below pass by default.
  expect(found, `${selector} not found in index.css`).not.toHaveLength(0);
  return found;
}

describe("cascade placement in index.css", () => {
  it("keeps the global :focus-visible outline in @layer base", () => {
    const outlines = placementsOf(":focus-visible").filter((p) => /(^|[;\s])outline\s*:/.test(p.body));
    expect(outlines).not.toHaveLength(0);
    for (const p of outlines) {
      expect(layered(p, "base"), `:focus-visible outline inside ${where(p)}`).toBe(true);
    }
  });

  it("keeps the :focus-visible radius unlayered, as Tailwind 3 applied it", () => {
    // Under Tailwind 3 this came after the utilities and overrode a focused
    // control's own rounded-* class. Layering it would quietly reshape every
    // focused pill and card.
    const radii = placementsOf(":focus-visible").filter((p) => /border-radius\s*:/.test(p.body));
    expect(radii).not.toHaveLength(0);
    for (const p of radii) {
      expect(layered(p), `:focus-visible radius inside ${where(p)}`).toBe(false);
    }
  });

  it.each([
    ".btn-press",
    ".btn-press:active",
    ".enter-stagger",
    ".enter-up",
    ".path-swap",
    ".hover-lift:hover",
    ".pulse-running",
    ".pulse-glow",
    ".progress-flow",
    ".dropzone-glow",
    ".dropzone-ripple",
    ".tabular-nums",
    ".workspace-shell",
    ".workspace-url:focus-within",
  ])("keeps the primary %s rule outside every layer", (selector) => {
    // Primary: outside the reduced-motion block, which repeats several of
    // these selectors and would otherwise keep one "found" after the real
    // rule had been deleted.
    const primary = placementsOf(selector).filter((p) => !inReducedMotion(p));
    expect(primary, `${selector} only appears under reduced motion`).not.toHaveLength(0);
    for (const p of primary) {
      expect(layered(p), `${selector} inside ${where(p)}`).toBe(false);
    }
  });

  it("keeps the reduced-motion catch-all outside every layer", () => {
    const catchAll = placementsOf('[class*="animate-"]');
    for (const p of catchAll) {
      expect(inReducedMotion(p)).toBe(true);
      expect(layered(p), `catch-all inside ${where(p)}`).toBe(false);
    }
  });

  it("puts no class rule inside a layer", () => {
    // The project's own classes all depend on being unlayered; utilities
    // belong in `@utility`, where they are named in the prelude instead.
    const layeredClasses = rules.filter((r) => r.selector.startsWith(".") && layered(r));
    expect(layeredClasses.map((r) => `${r.selector} in ${where(r)}`)).toEqual([]);
  });

  it("imports tokens.css after Tailwind and without a layer", () => {
    // `@import "./tokens.css" layer(base)` ahead of Tailwind's own layer
    // statement puts `base` before `theme`; the theme layer's same-named
    // variables then win and every radius, font and text size goes invalid.
    const source = stripComments(css);
    const tailwind = source.search(/^@import\s+["']tailwindcss["']/m);
    const tokens = source.search(/^@import\s+["']\.\/tokens\.css["'];/m);
    expect(tailwind).toBeGreaterThanOrEqual(0);
    expect(tokens).toBeGreaterThan(tailwind);
  });

  it("uses no Tailwind 3 directive or placeholder", () => {
    const source = stripComments(css);
    expect(source).not.toMatch(/@tailwind\b/);
    // Tailwind 4 has no `<alpha-value>`; left in a declaration it makes the
    // whole declaration invalid, silently.
    expect(source).not.toContain("<alpha-value>");
  });

  it("parses the file it is guarding", () => {
    // The parser is brace-matched by hand; prove it found real rules and
    // kept the glob string intact.
    expect(rules.length).toBeGreaterThan(50);
    expect(rules.some((r) => r.selector === "body" && r.atRules.length === 0)).toBe(true);
    expect(stripComments(css)).toContain('@source "../**/*.{ts,tsx}"');
    expect(splitSelectors(":is(.a, .b), .c")).toEqual([":is(.a, .b)", ".c"]);
  });
});
