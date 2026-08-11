/**
 * OKLCH → sRGB → WCAG contrast, for token tests.
 *
 * Lives under src/test/ because nothing in the app needs it at runtime:
 * the tokens are authored by hand and only the suite checks them. Kept out
 * of src/lib/ so it never lands in the shipped bundle.
 */

/** An OKLCH triplet as tokens.css stores it: lightness %, chroma, hue. */
export type Oklch = { l: number; c: number; h: number };

/** Matches `14% 0.008 160` — the unwrapped form the tokens use so Tailwind
 *  can inject an alpha value. */
const TRIPLET = /^\s*(\d+(?:\.\d+)?)%\s+(\d*\.?\d+)\s+(\d+(?:\.\d+)?)\s*$/;

export function parseOklch(value: string): Oklch | null {
  const m = TRIPLET.exec(value);
  if (!m) return null;
  return { l: Number(m[1]) / 100, c: Number(m[2]), h: Number(m[3]) };
}

function toLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);

  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.291485548 * b;

  const L = lp ** 3;
  const M = mp ** 3;
  const S = sp ** 3;

  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  return [
    clamp(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    clamp(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    clamp(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  ];
}

/** WCAG relative luminance. The linear-light sRGB values from the OKLCH
 *  transform are already un-gamma'd, so they feed straight in. */
function relativeLuminance(color: Oklch): number {
  const [r, g, b] = toLinearSrgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, 1–21. */
export function contrastRatio(a: Oklch, b: Oklch): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every `--token: <triplet>` declaration inside one rule block.
 *
 *  Brace-matched rather than regex-sliced so the `@media` wrapper around
 *  the `.system` light block doesn't swallow the rest of the file.
 */
export function tokenBlock(
  css: string,
  selector: string,
  fromIndex = 0,
): Map<string, Oklch> {
  const start = css.indexOf(selector, fromIndex);
  if (start === -1) throw new Error(`selector not found: ${selector}`);

  let depth = 0;
  let open = -1;
  let end = -1;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) open = i;
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (open === -1 || end === -1) throw new Error(`unterminated block: ${selector}`);

  // Comments come out before splitting: several of them contain a colon
  // ("Theme: dark is the default"), which would otherwise read as a
  // declaration once the body is split on semicolons.
  const body = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, Oklch>();
  for (const decl of body.split(";")) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const name = decl.slice(0, idx).trim();
    if (!name.startsWith("--")) continue;
    const parsed = parseOklch(decl.slice(idx + 1));
    if (parsed) out.set(name, parsed);
  }

  // Fail loudly rather than hand back an empty map. If the token syntax ever
  // changes (say the values get wrapped back in `oklch(...)`), every
  // declaration would stop matching and the callers that merely COMPARE two
  // blocks would go green against two empty maps — a guard that silently
  // stops guarding. Every block this is pointed at is expected to have colors.
  if (out.size === 0) {
    throw new Error(
      `no OKLCH tokens parsed from "${selector}" — the block was found but ` +
        `nothing matched the "<l>% <c> <h>" shape, so the token syntax has ` +
        `probably changed and this parser needs updating`,
    );
  }
  return out;
}
