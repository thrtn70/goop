import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

const WILDCARD = /^[xX*]$/;
const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/;

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// A one-to-three-part version where a wildcard is never followed by a number
// ("22.x.0" is invalid). Returns the numeric parts given, wildcards dropped.
function partial(text, range) {
  const match = PARTIAL.exec(text);
  if (!match) throw new Error(`unsupported engines range: ${range}`);
  const parts = match.slice(1).filter((part) => part !== undefined);
  const wild = parts.findIndex((part) => WILDCARD.test(part));
  if (wild >= 0 && parts.slice(wild).some((part) => !WILDCARD.test(part))) throw new Error(`unsupported engines range: ${range}`);
  return (wild >= 0 ? parts.slice(0, wild) : parts).map(Number);
}

const filled = (parts) => [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
// The first version above every version that the given parts cover.
function next(parts) {
  if (parts.length === 0) return null;
  const bumped = [...parts];
  bumped[bumped.length - 1] += 1;
  return filled(bumped);
}

// One comparator as [lower bound, inclusive] and [upper bound, inclusive],
// with null for no bound, following npm's desugaring of partial versions.
function bounds(op, parts) {
  const low = filled(parts);
  const all = parts.length === 3;
  switch (op) {
    case ">=": return { low: [low, true], high: null };
    case ">": return all ? { low: [low, false], high: null } : { low: parts.length ? [next(parts), true] : null, high: parts.length ? null : [[0, 0, 0], false] };
    case "<": return { low: null, high: parts.length ? [low, false] : [[0, 0, 0], false] };
    case "<=": return all ? { low: null, high: [low, true] } : { low: null, high: parts.length ? [next(parts), false] : null };
    case "~": return { low: [low, true], high: parts.length ? [next(parts.slice(0, Math.min(parts.length, 2))), false] : null };
    case "^": {
      if (parts.length === 0) return { low: null, high: null };
      const lead = parts.findIndex((part, i) => part !== 0 || i === parts.length - 1);
      return { low: [low, true], high: [next(parts.slice(0, lead + 1)), false] };
    }
    default: return { low: [low, true], high: parts.length ? [next(parts), false] : null };
  }
}

// The subset of npm's range grammar that engines.node fields use. The whole
// range is parsed before anything is matched, so a malformed alternative or
// comparator throws even when another one would match.
function parse(range) {
  return range.split("||").map((alternative) => {
    const text = alternative.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1");
    if (text === "") return [];
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    // "A - B" is ">=A <=B", where a partial B covers everything it names.
    if (hyphen) return [bounds(">=", partial(hyphen[1], range)), bounds("<=", partial(hyphen[2], range))];
    return text.split(/\s+/).map((comparator) => {
      const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(comparator);
      return bounds(match[1] ?? "", partial(match[2], range));
    });
  });
}

export function satisfies(target, range) {
  return parse(range).some((comparators) => comparators.every(({ low, high }) =>
    (low === null || compare(target, low[0]) > (low[1] ? -1 : 0))
    && (high === null || compare(target, high[0]) < (high[1] ? 1 : 0))));
}

test("the range checker reads the forms engines fields use, as npm does", () => {
  const cases = [
    [[22, 12, 0], ">=22.12.0", true],
    [[22, 12, 0], "^20.19.0 || ^22.13.0 || >=24", false],
    [[22, 13, 0], "^20.19.0 || ^22.13.0 || >=24", true],
    [[22, 12, 0], ">= 12.0.0", true],
    [[22, 12, 0], ">= 20", true],
    [[22, 12, 0], "^18.18.0 || ^20.9.0 || >=21.1.0", true],
    [[22, 12, 0], "18 || 20 || >=22", true],
    [[22, 12, 0], "20.x", false],
    [[22, 12, 0], "22.x", true],
    [[22, 12, 0], "*", true],
    [[22, 12, 0], "<22", false],
    [[22, 12, 0], "18.0.0 - 22.12.0", true],
    [[22, 12, 0], "18.0.0 - 22.11.9", false],
    [[22, 13, 0], ">=18 <=24.0", true],
    [[22, 13, 0], ">=18 <=24.1", true],
    [[22, 13, 0], "<=22", true],
    [[22, 13, 0], "<=22.12", false],
    [[22, 13, 0], "18 - 24.1", true],
    [[22, 13, 0], "18 - 22.12", false],
    [[22, 13, 0], ">22", false],
    [[22, 13, 0], ">22.12", true],
    [[22, 13, 0], ">22.13.0", false],
    [[22, 13, 0], "<22.13", false],
    [[22, 13, 0], "~22", true],
    [[22, 13, 0], "~22.12", false],
    [[22, 13, 0], "^0.x", false],
    [[0, 3, 4], "^0.3", true],
    [[0, 4, 0], "^0.3", false],
  ];
  for (const [target, range, expected] of cases) assert.equal(satisfies(target, range), expected, `${target.join(".")} in ${range}`);
  for (const malformed of ["latest", ">=22 || latest", ">=22.13.0.99", "22.x.0", ">=22 foo"]) {
    assert.throws(() => satisfies([22, 13, 0], malformed), /unsupported/, malformed);
  }
});

test("every locked package accepts the declared minimum Node", () => {
  const declared = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(manifest.engines?.node ?? "");
  assert.ok(declared, 'package.json must declare engines.node as ">=X.Y.Z"');
  const minimum = declared.slice(1).map(Number);
  const refused = Object.entries(lock.packages)
    .filter(([, info]) => info.engines?.node !== undefined)
    .filter(([, info]) => typeof info.engines.node !== "string" || !satisfies(minimum, info.engines.node))
    .map(([path, info]) => `${path.replace(/^node_modules\//, "")}@${info.version} (${JSON.stringify(info.engines.node)})`);
  assert.deepEqual(refused, [], `declared Node ${declared.slice(1).join(".")} is below what these packages accept`);
});
