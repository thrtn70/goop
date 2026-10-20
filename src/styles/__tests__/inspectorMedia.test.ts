import { describe, expect, it } from "vitest";
import css from "../index.css?raw";

/* Why this file exists.
 *
 * The inspector is a height-bounded flex column: title, the pinned source
 * player, the settings scroll, then the action bar. In a short window (1000x600
 * with the queue open) the player used to keep its full height and push the
 * Convert/Compress button out of view. The fix is a chain of declarations that
 * only a layout engine acts on: the player slot may shrink, every wrapper down
 * to the media may shrink, the media scales down inside its box, and the
 * player's own bar and the action bar never shrink. jsdom lays nothing out, so
 * the chain is pinned here; remove any link and the button can be pushed off
 * again with every component test still green. */

/** Comments removed, strings kept: `@source "../**\/*.{ts,tsx}"` holds what a
 *  plain regex would read as a comment opener and a block. */
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

type Declarations = Map<string, string>;

/** Rules outside every at-rule, one entry per selector in each selector list, in source order. */
function topLevelRules(source: string): { selector: string; declarations: Declarations }[] {
  const rules: { selector: string; declarations: Declarations }[] = [];
  let depth = 0;
  let prelude = "";
  let body = "";
  let quote: string | null = null;
  for (const ch of stripComments(source)) {
    if (quote !== null || ch === '"' || ch === "'") {
      if (quote === null) quote = ch;
      else if (ch === quote) quote = null;
      if (depth === 0) prelude += ch;
      else body += ch;
    } else if (ch === "{") {
      if (depth > 0) body += ch;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth > 0) {
        body += ch;
        continue;
      }
      const head = prelude.trim().replace(/\s+/g, " ");
      if (!head.startsWith("@")) {
        const declarations: Declarations = new Map();
        for (const declaration of body.split(";")) {
          const colon = declaration.indexOf(":");
          if (colon !== -1) declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
        }
        for (const selector of head.split(",")) rules.push({ selector: selector.trim(), declarations });
      }
      prelude = "";
      body = "";
    } else if (depth === 0) {
      prelude = ch === ";" ? "" : prelude + ch;
    } else {
      body += ch;
    }
  }
  return rules;
}

const rules = topLevelRules(css);

/** Every top-level declaration for `selector`, later rules winning, as the cascade would have it. */
function declarationsOf(selector: string): Declarations {
  const found = rules.filter((rule) => rule.selector === selector);
  // Anti-vacuity: a selector missing from the file must fail, not pass every "has no overflow" check.
  expect(found, `${selector} not found at the top level of index.css`).not.toHaveLength(0);
  return new Map(found.flatMap((rule) => [...rule.declarations]));
}

/** The used flex-shrink: the longhand, else the shorthand's second number, else the initial value 1. */
function flexShrinkOf(declarations: Declarations): number {
  const longhand = declarations.get("flex-shrink");
  if (longhand !== undefined) return Number(longhand);
  const flex = declarations.get("flex");
  if (flex === undefined || flex === "auto" || flex === "initial") return 1;
  if (flex === "none") return 0;
  const numbers = flex.split(/\s+/).filter((token) => /^\d*\.?\d+$/.test(token));
  return numbers.length >= 2 ? Number(numbers[1]) : 1;
}

describe("flexShrinkOf", () => {
  it.each<[string, Record<string, string>, number]>([
    ["initial value", {}, 1],
    ["longhand", { "flex-shrink": "0" }, 0],
    ["three-value shorthand", { flex: "0 1 auto" }, 1],
    ["shorthand that forbids shrinking", { flex: "0 0 auto" }, 0],
    ["one-number shorthand", { flex: "1" }, 1],
    ["none", { flex: "none" }, 0],
  ])("reads the %s", (_name, declarations, expected) => {
    expect(flexShrinkOf(new Map(Object.entries(declarations)))).toBe(expected);
  });
});

describe("inspector player layout in index.css", () => {
  it("lets the player slot shrink, as a flex column, without clipping its bar", () => {
    const slot = declarationsOf(".workspace-inspector-media");
    expect(slot.get("min-height")).toBe("0");
    expect(flexShrinkOf(slot)).toBeGreaterThan(0);
    expect(slot.get("display")).toBe("flex");
    expect(slot.get("flex-direction")).toBe("column");
    expect(slot.get("overflow") ?? "visible").toBe("visible");
  });

  it("still hides an empty slot", () => {
    expect(declarationsOf(".workspace-inspector-media:empty").get("display")).toBe("none");
  });

  it("lets every wrapper between the slot and the media shrink", () => {
    const player = declarationsOf(".source-player");
    expect(player.get("min-height")).toBe("0");
    expect(player.get("display")).toBe("flex");
    expect(player.get("flex-direction")).toBe("column");
    expect(player.get("overflow") ?? "visible").toBe("visible");

    const body = declarationsOf(".source-player-body");
    expect(body.get("min-height")).toBe("0");
    expect(body.get("display")).toBe("flex");
    expect(body.get("flex-direction")).toBe("column");
    // What cannot scale (an audio bar, a message) is cut off here rather than spilling onto the settings.
    expect(body.get("overflow")).toBe("hidden");
  });

  it("never shrinks the player's own bar, so Hide preview stays whole", () => {
    expect(flexShrinkOf(declarationsOf(".source-player-bar"))).toBe(0);
  });

  it.each([".workspace-inspector-media img", ".workspace-inspector-media video"])(
    "scales %s down inside its box instead of holding its height",
    (selector) => {
      const media = declarationsOf(selector);
      expect(media.get("min-height")).toBe("0");
      expect(flexShrinkOf(media)).toBeGreaterThan(0);
      expect(media.get("max-height")).toBe("180px");
      expect(media.get("object-fit")).toBe("contain");
      expect(media.get("width")).toBe("100%");
    },
  );

  it("never shrinks the action bar", () => {
    expect(flexShrinkOf(declarationsOf(".workspace-inspector-actions"))).toBe(0);
  });
});
