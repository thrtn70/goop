import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd: root });

// Generated output that is committed but deliberately not linted.
const GENERATED = [/^shared\/types\//, /^crates\/[^/]+\/bindings\//, /^site\/assets\//];

// A path git ignores can never be committed, so linting it only reports on
// local material that differs from one checkout to the next.
test("lint skips every directory that .gitignore excludes", async () => {
  const directories = readFileSync(new URL("../.gitignore", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\/[^*?[\]!#\s]+\/$/.test(line));
  assert.ok(directories.length > 0, ".gitignore must exclude at least one directory");
  for (const directory of directories) {
    const probe = `${directory.slice(1)}probe.mjs`;
    assert.equal(await eslint.isPathIgnored(probe), true, `${probe} must not be linted`);
  }
});

test("lint still covers every tracked source file outside generated output", async () => {
  const tracked = execFileSync("git", ["ls-files", "--", "*.js", "*.mjs", "*.cjs", "*.ts", "*.tsx"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  assert.ok(tracked.length > 100, "expected the repository's tracked sources");
  const skipped = [];
  for (const file of tracked) {
    if (GENERATED.some((pattern) => pattern.test(file))) continue;
    if (await eslint.isPathIgnored(file)) skipped.push(file);
  }
  assert.deepEqual(skipped, []);
});
