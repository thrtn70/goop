import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

function version(text) {
  const parts = text.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : null));
  while (parts.length < 3) parts.push(null);
  return parts.slice(0, 3);
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// The subset of npm's range grammar that engines.node fields use: "||"
// alternatives, space-separated comparators (an operator may be followed by a
// space), ^, ~, x-ranges and hyphen ranges. Anything else throws, so an
// unfamiliar range fails the check instead of passing it.
export function satisfies(target, range) {
  return range.split("||").some((alternative) => {
    const text = alternative.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1");
    if (text === "" || text === "*" || text === "x") return true;
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen) return satisfies(target, `>=${hyphen[1]} <=${hyphen[2]}`);
    return text.split(/\s+/).every((comparator) => {
      const match = /^(>=|<=|>|<|=|\^|~)?v?(\d+(?:\.(?:\d+|x|\*))*)$/.exec(comparator);
      if (!match) throw new Error(`unsupported engines range: ${range}`);
      const [, op = "", raw] = match;
      const bound = version(raw);
      const fixed = bound.filter((part) => part !== null).length;
      const low = bound.map((part) => part ?? 0);
      const t = target;
      switch (op) {
        case ">=": return compare(t, low) >= 0;
        case ">": return fixed === 3 ? compare(t, low) > 0 : t.slice(0, fixed).some((part, i) => part > low[i]) && compare(t, low) > 0;
        case "<": return compare(t, low) < 0;
        case "<=": return fixed === 3 ? compare(t, low) <= 0 : t.slice(0, fixed).every((part, i) => part <= low[i]);
        case "^": {
          if (compare(t, low) < 0) return false;
          const lead = low.findIndex((part, i) => part !== 0 || i === Math.max(fixed - 1, 0));
          return t.slice(0, lead + 1).every((part, i) => part === low[i]);
        }
        case "~": return compare(t, low) >= 0 && t[0] === low[0] && (fixed < 2 || t[1] === low[1]);
        default: return t.slice(0, fixed).every((part, i) => part === low[i]);
      }
    });
  });
}

test("the range checker reads the forms engines fields use", () => {
  const cases = [
    [[22, 12, 0], ">=22.12.0", true],
    [[22, 12, 0], "^20.19.0 || ^22.13.0 || >=24", false],
    [[22, 13, 0], "^20.19.0 || ^22.13.0 || >=24", true],
    [[22, 12, 0], ">= 12.0.0", true],
    [[22, 12, 0], ">= 20", true],
    [[22, 12, 0], "^18.18.0 || ^20.9.0 || >=21.1.0", true],
    [[22, 12, 0], "^14.17.0 || ^16.10.0 || >=17.0.0", true],
    [[22, 12, 0], "18 || 20 || >=22", true],
    [[22, 12, 0], "20.x", false],
    [[22, 12, 0], "22.x", true],
    [[22, 12, 0], "*", true],
    [[22, 12, 0], "<22", false],
    [[22, 12, 0], "18.0.0 - 22.12.0", true],
    [[22, 12, 0], "18.0.0 - 22.11.9", false],
  ];
  for (const [target, range, expected] of cases) assert.equal(satisfies(target, range), expected, `${target.join(".")} in ${range}`);
  assert.throws(() => satisfies([22, 12, 0], "latest"), /unsupported/);
});

test("every locked package accepts the declared minimum Node", () => {
  const declared = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.engines?.node ?? "");
  assert.ok(declared, 'package.json must declare engines.node as ">=X.Y.Z"');
  const minimum = version(declared[1]);
  const refused = Object.entries(lock.packages)
    .filter(([, info]) => typeof info.engines?.node === "string")
    .filter(([, info]) => !satisfies(minimum, info.engines.node))
    .map(([path, info]) => `${path.replace(/^node_modules\//, "")}@${info.version} (${info.engines.node})`);
  assert.deepEqual(refused, [], `declared Node ${declared[1]} is below what these packages accept`);
});
