import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-gallery-dl-runtime.mjs", import.meta.url));
const recipe = fileURLToPath(new URL("./gallery-dl-macos-requirements.txt", import.meta.url));

const MATCHING = {
  version: "1.32.11",
  python: "3.14.6",
  platform: "macOS-14.7-arm64-arm-64bit-Mach-O",
  requests: "2.34.2",
  urllib3: "2.8.0",
};

const PINNED_REQUIREMENTS = [
  "gallery-dl==1.32.11 \\",
  `    --hash=sha256:${"a".repeat(64)}`,
  "requests==2.34.2 \\",
  `    --hash=sha256:${"b".repeat(64)}`,
  "urllib3==2.8.0 \\",
  `    --hash=sha256:${"c".repeat(64)}`,
  "",
].join("\n");

function report(overrides = {}) {
  const r = { ...MATCHING, ...overrides };
  return [
    `[gallery-dl][debug] Version ${r.version} - Executable (None)`,
    `[gallery-dl][debug] Python ${r.python} - ${r.platform}`,
    `[gallery-dl][debug] requests ${r.requests} - urllib3 ${r.urllib3}`,
    "[gallery-dl][debug] Configuration Files []",
  ];
}

// A stand-in for the frozen binary: prints the given debug lines on stderr
// (where gallery-dl's logger writes), a module list on stdout, and records
// its argv and environment so the tests can see how it was invoked.
function fakeBinary(dir, { stderrLines = report(), exitCode = 0, hang = false } = {}) {
  const path = join(dir, "gallery-dl");
  const record = join(dir, "record");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > '${record}.args'`,
    `printf '%s' "$HOME" > '${record}.home'`,
    `printf '%s' "\${GOOP_LEAK_PROBE-unset}" > '${record}.leak'`,
    hang ? "exec sleep 10" : "",
    "cat >&2 <<'EOF'",
    ...stderrLines,
    "EOF",
    "printf 'imgur\\nbunkr\\n'",
    `exit ${exitCode}`,
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { path, record };
}

function check(args, env = {}) {
  return spawnSync(process.execPath, [checker, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "goop-gallery-runtime-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function requirements(dir, text = PINNED_REQUIREMENTS) {
  const path = join(dir, "requirements.txt");
  writeFileSync(path, text);
  return path;
}

test("accepts a binary whose reported runtime matches every pin", () => {
  withDir((dir) => {
    const bin = fakeBinary(dir);
    const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /gallery-dl 1\.32\.11/);
    assert.match(result.stdout, /urllib3 2\.8\.0/);
    assert.match(result.stdout, /Python 3\.14\.6/);
  });
});

test("refuses the urllib3 2.7.0 runtime the withdrawn releases shipped", () => {
  withDir((dir) => {
    const bin = fakeBinary(dir, { stderrLines: report({ urllib3: "2.7.0" }) });
    const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::.*urllib3 2\.7\.0.*2\.8\.0/);
  });
});

test("refuses a mismatched gallery-dl, requests or Python version", async (t) => {
  const cases = [
    ["gallery-dl", { version: "1.32.10" }, /gallery-dl 1\.32\.10/],
    ["requests", { requests: "2.33.0" }, /requests 2\.33\.0/],
    ["Python", { python: "3.13.9" }, /Python 3\.13\.9/],
  ];
  for (const [name, overrides, message] of cases) {
    await t.test(name, () => {
      withDir((dir) => {
        const bin = fakeBinary(dir, { stderrLines: report(overrides) });
        const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, message);
      });
    });
  }
});

test("refuses an interpreter that is not arm64", () => {
  withDir((dir) => {
    const bin = fakeBinary(dir, { stderrLines: report({ platform: "macOS-14.7-x86_64-i386-64bit" }) });
    const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::.*arm64/);
  });
});

test("fails closed when a version line is missing or repeated", async (t) => {
  for (const [name, needle, message] of [
    ["missing Version line", "] Version ", /::error::.*Version/],
    ["missing Python line", "] Python ", /::error::.*Python/],
  ]) {
    await t.test(name, () => {
      withDir((dir) => {
        const bin = fakeBinary(dir, { stderrLines: report().filter((line) => !line.includes(needle)) });
        const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, message);
      });
    });
  }
  await t.test("missing urllib3 line", () => {
    withDir((dir) => {
      const lines = report().filter((line) => !line.includes("urllib3"));
      const bin = fakeBinary(dir, { stderrLines: lines });
      const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /::error::.*requests/);
    });
  });
  await t.test("repeated urllib3 line", () => {
    withDir((dir) => {
      const lines = [...report(), "[gallery-dl][debug] requests 2.34.2 - urllib3 2.7.0"];
      const bin = fakeBinary(dir, { stderrLines: lines });
      const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /::error::.*more than once/);
    });
  });
  await t.test("no debug output at all", () => {
    withDir((dir) => {
      const bin = fakeBinary(dir, { stderrLines: [] });
      const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /::error::/);
    });
  });
});

test("fails on a non-zero exit even when the report matches", () => {
  withDir((dir) => {
    const bin = fakeBinary(dir, { exitCode: 3 });
    const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::.*exit(?:ed)? .*3/);
  });
});

test("fails when the binary hangs past the timeout", () => {
  withDir((dir) => {
    const bin = fakeBinary(dir, { hang: true });
    const started = Date.now();
    const result = check([
      "--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir), "--timeout-ms", "300",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::.*(?:timed out|timeout)/i);
    assert.ok(Date.now() - started < 8000, "the checker must not wait for the hung binary");
  });
});

test("takes every expected version from the requirements file", () => {
  withDir((dir) => {
    const custom = PINNED_REQUIREMENTS
      .replace("gallery-dl==1.32.11", "gallery-dl==9.1.2")
      .replace("requests==2.34.2", "requests==9.3.4")
      .replace("urllib3==2.8.0", "urllib3==9.5.6");
    const bin = fakeBinary(dir, { stderrLines: report({ version: "9.1.2", requests: "9.3.4", urllib3: "9.5.6" }) });
    const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir, custom)]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /urllib3 9\.5\.6/);
  });
});

test("refuses a requirements file without a needed pin", () => {
  withDir((dir) => {
    const withoutRequests = PINNED_REQUIREMENTS.replace(/requests==[^\n]*\n[^\n]*\n/, "");
    const bin = fakeBinary(dir);
    const result = check([
      "--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir, withoutRequests),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::.*requests/);
  });
});

test("runs list-modules with no user config, an isolated home and a scrubbed environment", () => {
  withDir((dir) => {
    const bin = fakeBinary(dir);
    const result = check(
      ["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)],
      { GOOP_LEAK_PROBE: "leaked" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      readFileSync(`${bin.record}.args`, "utf8").trim().split("\n"),
      ["--config-ignore", "--verbose", "--list-modules"],
    );
    const isolatedHome = readFileSync(`${bin.record}.home`, "utf8");
    assert.notEqual(isolatedHome, "");
    assert.notEqual(isolatedHome, homedir());
    assert.equal(existsSync(isolatedHome), false, "the isolated home must be removed after the run");
    assert.equal(readFileSync(`${bin.record}.leak`, "utf8"), "unset");
  });
});

test("refuses a requirements file that pins a package twice", () => {
  withDir((dir) => {
    const twice = `${PINNED_REQUIREMENTS}urllib3==2.7.0 \\\n    --hash=sha256:${"d".repeat(64)}\n`;
    const bin = fakeBinary(dir);
    const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir, twice)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::.*urllib3 exactly once/);
  });
});

test("reports usage errors and a missing binary distinctly", async (t) => {
  // An empty --python is what a skipped or renamed setup-python step yields.
  for (const [name, args] of [
    ["missing --python", []],
    ["empty --python", ["--python", ""]],
    ["inexact --python", ["--python", "3.14"]],
  ]) {
    await t.test(name, () => {
      withDir((dir) => {
        const bin = fakeBinary(dir);
        const result = check(["--binary", bin.path, ...args, "--requirements", requirements(dir)]);
        assert.equal(result.status, 2);
        assert.match(result.stderr, /--python/);
      });
    });
  }
  await t.test("binary does not exist", () => {
    withDir((dir) => {
      const result = check(["--binary", join(dir, "absent"), "--python", "3.14.6", "--requirements", requirements(dir)]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /::error::.*absent/);
    });
  });
});

test("the default requirements file is the macOS gallery-dl recipe and pins all three packages", () => {
  const text = readFileSync(recipe, "utf8");
  for (const name of ["gallery-dl", "requests", "urllib3"]) {
    assert.match(text, new RegExp(`^${name}==\\d+\\.\\d+\\.\\d+ \\\\$`, "m"), `recipe must pin ${name}`);
  }
  withDir((dir) => {
    const pins = Object.fromEntries(
      ["gallery-dl", "requests", "urllib3"].map((name) => [name, text.match(new RegExp(`^${name}==(\\S+)`, "m"))[1]]),
    );
    const bin = fakeBinary(dir, {
      stderrLines: report({ version: pins["gallery-dl"], requests: pins.requests, urllib3: pins.urllib3 }),
    });
    const result = check(["--binary", bin.path, "--python", "3.14.6"]);
    assert.equal(result.status, 0, result.stderr);
  });
});
