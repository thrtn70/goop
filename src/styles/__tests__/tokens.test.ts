import { describe, expect, it } from "vitest";
import { contrastRatio, tokenBlock, type Oklch } from "@/test/oklch";
import css from "../tokens.css?raw";

const dark = tokenBlock(css, ":root {");
const light = tokenBlock(css, ":root.light {");
// The `.system` block that follows the prefers-color-scheme query, not the
// empty one above it that just documents "default dark".
const systemLight = tokenBlock(
  css,
  ":root.system {",
  css.indexOf("@media (prefers-color-scheme: light)"),
);

/** Text sits on these three. `--surface-3` is deliberately absent: it is a
 *  hover/keycap fill, and no body-size text is allowed on it (see the
 *  surface-3 test below). */
const TEXT_SURFACES = ["--surface-0", "--surface-1", "--surface-2"] as const;

function ratio(tokens: Map<string, Oklch>, fg: string, bg: string): number {
  const a = tokens.get(fg);
  const b = tokens.get(bg);
  if (!a) throw new Error(`missing token ${fg}`);
  if (!b) throw new Error(`missing token ${bg}`);
  return contrastRatio(a, b);
}

// The system block is included here, not just in the parity check below.
// Parity alone would leave the OS prefers-color-scheme path with no contrast
// enforcement of its own the moment the two blocks were edited together.
describe.each([
  ["dark", dark],
  ["light", light],
  ["system (prefers light)", systemLight],
])("%s theme contrast", (_theme, tokens) => {
  // 4.5:1 is the AA floor for body text. --fg-muted is included because it
  // renders the URL placeholder, queue-row ETAs and nav keycap labels — all
  // real copy a user has to read, not decoration.
  it.each(["--fg", "--fg-secondary", "--fg-muted"])(
    "%s clears AA body text on every text surface",
    (fg) => {
      for (const bg of TEXT_SURFACES) {
        expect(ratio(tokens, fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("keeps the accent legible as a UI component on the base surface", () => {
    // 3:1 is the AA floor for non-text UI (progress fills, icons, focus rings).
    expect(ratio(tokens, "--accent", "--surface-0")).toBeGreaterThanOrEqual(3);
    expect(ratio(tokens, "--accent", "--surface-1")).toBeGreaterThanOrEqual(3);
  });

  it("keeps accent foreground legible on the active nav pill", () => {
    // --accent-strong is the LeftNav pill; --accent-fg is the label on it.
    expect(ratio(tokens, "--accent-fg", "--accent-strong")).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["--success", "--error", "--warning"])(
    "%s reads as a state indicator on the surfaces it appears on",
    (semantic) => {
      for (const bg of TEXT_SURFACES) {
        expect(ratio(tokens, semantic, bg), `${semantic} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    },
  );
});

describe("surface-3 usage rule", () => {
  // --fg-muted cannot reach 4.5:1 against --surface-3 without becoming
  // indistinguishable from --fg-secondary, so the rule is a usage one:
  // anything sitting on surface-3 steps up to secondary. This test exists so
  // that rule is enforced rather than remembered.
  it.each([
    ["dark", dark],
    ["light", light],
    ["system (prefers light)", systemLight],
  ])("%s: --fg-secondary carries text on --surface-3", (_theme, tokens) => {
    expect(ratio(tokens, "--fg-secondary", "--surface-3")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("theme block parity", () => {
  // The light palette is written twice — once for the explicit `.light`
  // class and once inside the prefers-color-scheme query for `.system`.
  // Nothing but this test stops the two copies from drifting apart.
  it("keeps :root.light and the system light block identical", () => {
    // Guard the comparison before making it: two empty maps are also "equal",
    // so without this the check could go green having verified nothing.
    expect(light.size).toBeGreaterThan(0);
    expect(systemLight.size).toBe(light.size);
    expect(Object.fromEntries(systemLight)).toEqual(Object.fromEntries(light));
  });

  it("parses every colour token in each block", () => {
    // A count, not a spot-check: if a token is added to one theme and not the
    // others, or the parser silently drops one, this fails rather than
    // quietly narrowing what the contrast tests above cover.
    expect(dark.size).toBe(21);
    expect(light.size).toBe(21);
    expect(systemLight.size).toBe(21);
  });
});
