import { describe, expect, it } from "vitest";
import css from "../index.css?raw";

/* Why this file exists.
 *
 * The reduced-motion block used to neutralise motion by listing our own class
 * names — .pulse-running, .pulse-glow, .dropzone-ripple and friends. That list
 * can only ever cover the vocabulary we invented. Tailwind ships its own
 * animation utilities, and `animate-pulse` was in use at six call sites while
 * the block said nothing about it, so it kept running at `pulse 2s … infinite`
 * for anyone who had asked the OS to stop animations. README.md advertises
 * "`prefers-reduced-motion` respected on every animation" as part of a WCAG
 * 2.1 AA pass, so the claim was false in the shipped app.
 *
 * Neither token collapse caught it: tokens.css zeroes the four `--duration-*`
 * variables, and Tailwind's keyframes do not read them.
 *
 * These tests are deliberately implementation-agnostic. A catch-all selector
 * and an explicit list both satisfy them; what they refuse to allow is a
 * Tailwind animation utility with no coverage at all. */

/** Comments go first, because neither parser below is comment-aware and this
 *  stylesheet's comments quote CSS in prose — `.animate-pulse`, `!important`,
 *  `@keyframes enter-up`. A brace inside one would merge two media blocks into
 *  a mis-scoped single block; a comma would split a selector list into prose
 *  fragments. Both were reproducible before this ran: an injected `{` dropped
 *  the block count from 2 to 1 with every assertion still green. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Bodies of every `@media (prefers-reduced-motion: reduce)` block, concatenated.
 *  Brace-balanced rather than regex-delimited: the file has more than one such
 *  block and a lazy `{[^}]*}` would stop at the first inner rule. */
function reducedMotionSource(source: string): { blocks: number; body: string } {
  const marker = "@media (prefers-reduced-motion: reduce)";
  const bodies: string[] = [];
  let from = 0;

  for (;;) {
    const at = source.indexOf(marker, from);
    if (at === -1) break;
    const open = source.indexOf("{", at);
    if (open === -1) break;

    let depth = 0;
    let i = open;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(open + 1, i));
    from = i + 1;
  }

  return { blocks: bodies.length, body: bodies.join("\n") };
}

interface Rule {
  selectors: string[];
  body: string;
}

/** Flat `selector { declarations }` pairs. The reduced-motion blocks contain no
 *  nested at-rules, so a flat scan is sufficient and keeps the parser honest. */
function rules(block: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.push({
      selectors: m[1].split(",").map((s) => s.trim()).filter(Boolean),
      body: m[2].trim(),
    });
  }
  return out;
}

const reduced = reducedMotionSource(stripComments(css));
const reducedRules = rules(reduced.body);

/** True when some rule under reduced motion stops this utility animating —
 *  either by naming it outright or via a substring selector that covers it. */
function neutralises(utility: string): boolean {
  return reducedRules.some((rule) => {
    const covered = rule.selectors.some((sel) => {
      if (sel === `.${utility}`) return true;
      const substring = /\[class\*=\s*["']([^"']+)["']\s*\]/.exec(sel);
      return substring !== null && utility.includes(substring[1]);
    });
    return covered && /animation(-name)?\s*:\s*none/.test(rule.body);
  });
}

describe("reduced motion", () => {
  it("parses both reduced-motion blocks in index.css", () => {
    // Anti-vacuity: every assertion below is trivially true against an empty
    // parse, which is exactly how a broken parser would look like a pass.
    //
    // The count is exact, not `> 0`. A brace smuggled into a comment merges
    // two blocks into one mis-scoped block, and `> 0` waves that through — the
    // corruption that actually reproduced here. index.css has two: the main
    // one, and the view-transition one at the foot of the file. tokens.css has
    // a third, deliberately not read here. If this fails after adding a block,
    // confirm the parser still scopes correctly before bumping the number.
    expect(reduced.blocks).toBe(2);
    expect(reducedRules.length).toBeGreaterThan(0);
  });

  it("parses selectors, not comment prose", () => {
    // Before comments were stripped, the catch-all rule came back with eleven
    // "selectors", ten of them fragments of the comment above it, and passed
    // only because no comma sat next to the bracket text.
    const catchAll = reducedRules.find((r) =>
      r.selectors.some((s) => s.includes("[class*=")),
    );
    expect(catchAll).toBeDefined();
    expect(catchAll?.selectors).toHaveLength(1);
    for (const rule of reducedRules) {
      for (const selector of rule.selectors) {
        expect(selector).not.toContain("*/");
      }
    }
  });

  it("still neutralises the project's own animation classes", () => {
    // The original enumeration was correct as far as it went. Losing it while
    // adding Tailwind coverage would trade one gap for another.
    expect(neutralises("pulse-running")).toBe(true);
    expect(neutralises("dropzone-ripple")).toBe(true);
  });

  it.each(["animate-pulse", "animate-spin", "animate-bounce", "animate-ping"])(
    "neutralises Tailwind's %s",
    (utility) => {
      expect(neutralises(utility)).toBe(true);
    },
  );

  it("does not neutralise a class nothing covers", () => {
    // Guards the matcher itself: a selector check loose enough to pass
    // everything would make the cases above meaningless.
    expect(neutralises("not-a-real-class-xyz")).toBe(false);
  });
});
