import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  certifi: "2026.10.19",
  caBundle: "certifi",
};

const PINNED_REQUIREMENTS = [
  "certifi==2026.10.19 \\",
  `    --hash=sha256:${"e".repeat(64)}`,
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
    `[goop-probe][debug] certifi ${r.certifi} - requests CA bundle ${r.caBundle}`,
    `[gallery-dl][debug] Version ${r.version} - Executable (None)`,
    `[gallery-dl][debug] Python ${r.python} - ${r.platform}`,
    `[gallery-dl][debug] requests ${r.requests} - urllib3 ${r.urllib3}`,
    "[gallery-dl][debug] Configuration Files []",
  ];
}

// A stand-in for the frozen binary: prints the given debug lines on stderr
// (where gallery-dl's logger writes), a module list on stdout, and records
// its argv, environment and the probe module it was handed so the tests can
// see how it was invoked.
function fakeBinary(dir, { stderrLines = report(), exitCode = 0, hang = false } = {}) {
  const path = join(dir, "gallery-dl");
  const record = join(dir, "record");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > '${record}.args'`,
    `printf '%s' "$HOME" > '${record}.home'`,
    `printf '%s' "\${GOOP_LEAK_PROBE-unset}" > '${record}.leak'`,
    `for arg in "$@"; do case "$arg" in globals=*) cp "\${arg#globals=}" '${record}.probe' ;; esac; done`,
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

test("refuses the certifi 2026.07.22 bundle that still trusts the compromised emSign root", () => {
  withDir((dir) => {
    const bin = fakeBinary(dir, { stderrLines: report({ certifi: "2026.07.22" }) });
    const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::.*certifi 2026\.07\.22.*2026\.10\.19/);
  });
});

// certifi's __version__ zero-pads the month and day; a pip pin is normalised.
test("matches certifi's zero-padded version against the recipe's normalised pin", async (t) => {
  const recipeWith = (pin) => PINNED_REQUIREMENTS.replace("certifi==2026.10.19", `certifi==${pin}`);
  await t.test("same date", () => {
    withDir((dir) => {
      const bin = fakeBinary(dir, { stderrLines: report({ certifi: "2026.07.02" }) });
      const result = check([
        "--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir, recipeWith("2026.7.2")),
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /certifi 2026\.07\.02/);
    });
  });
  await t.test("different date", () => {
    withDir((dir) => {
      const bin = fakeBinary(dir, { stderrLines: report({ certifi: "2026.07.02" }) });
      const result = check([
        "--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir, recipeWith("2026.7.20")),
      ]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /::error::.*certifi 2026\.07\.02.*2026\.7\.20/);
    });
  });
  await t.test("different number of parts", () => {
    withDir((dir) => {
      const bin = fakeBinary(dir, { stderrLines: report({ certifi: "2026.10" }) });
      const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /::error::.*certifi 2026\.10 does not match.*2026\.10\.19/);
    });
  });
});

test("refuses a binary whose requests trusts a CA bundle other than certifi's", () => {
  withDir((dir) => {
    const bin = fakeBinary(dir, { stderrLines: report({ caBundle: "other" }) });
    const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::.*requests.*CA bundle/);
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
    // What a gallery-dl that stopped honouring the "globals" option would print.
    ["missing certifi probe line", "[goop-probe]", /::error::.*did not report.*certifi/],
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
  await t.test("repeated certifi probe line", () => {
    withDir((dir) => {
      const lines = [...report(), "[goop-probe][debug] certifi 2026.07.22 - requests CA bundle certifi"];
      const bin = fakeBinary(dir, { stderrLines: lines });
      const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /::error::.*certifi.*more than once/);
    });
  });
  await t.test("unrecognised certifi probe line", () => {
    withDir((dir) => {
      const bin = fakeBinary(dir, { stderrLines: report({ caBundle: "unknown" }) });
      const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /::error::unrecognised gallery-dl "certifi" line/);
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
      .replace("urllib3==2.8.0", "urllib3==9.5.6")
      .replace("certifi==2026.10.19", "certifi==9.7.8");
    const bin = fakeBinary(dir, {
      stderrLines: report({ version: "9.1.2", requests: "9.3.4", urllib3: "9.5.6", certifi: "9.7.8" }),
    });
    const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir, custom)]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /urllib3 9\.5\.6/);
    assert.match(result.stdout, /certifi 9\.7\.8/);
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
    const args = readFileSync(`${bin.record}.args`, "utf8").trim().split("\n");
    assert.deepEqual(args.slice(0, 3), ["--config-ignore", "--verbose", "-o"]);
    assert.equal(args[4], "--list-modules");
    assert.equal(args.length, 5);
    const probe = /^globals=(.+\.py)$/.exec(args[3])?.[1];
    assert.ok(probe, `expected -o globals=<probe>.py, got ${args[3]}`);
    assert.ok(existsSync(`${bin.record}.probe`), "the probe must exist while the binary runs");
    const isolatedHome = readFileSync(`${bin.record}.home`, "utf8");
    assert.notEqual(isolatedHome, "");
    assert.notEqual(isolatedHome, homedir());
    assert.ok(probe.startsWith(`${isolatedHome}/`), "the probe must live inside the isolated home");
    // gallery-dl puts the probe's directory on sys.path; the home holds
    // PyInstaller's unpacked _MEI* tree and gallery-dl's own files.
    assert.notEqual(dirname(probe), isolatedHome, "the probe needs a directory of its own");
    assert.equal(existsSync(isolatedHome), false, "the isolated home must be removed after the run");
    assert.equal(readFileSync(`${bin.record}.leak`, "utf8"), "unset");
  });
});

// The probe runs inside the frozen interpreter, so run the module the checker
// hands over under a real Python with stand-in certifi and requests packages.
function runProbe(probeSource, { requestsBundle }) {
  return withDir((dir) => {
    const stubs = join(dir, "stubs");
    const probeDir = join(dir, "probe");
    for (const path of [join(stubs, "certifi"), join(stubs, "requests"), probeDir]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(
      join(stubs, "certifi", "__init__.py"),
      '__version__ = "2026.10.19"\n\ndef where():\n    return "/frozen/certifi/cacert.pem"\n',
    );
    writeFileSync(join(stubs, "requests", "__init__.py"), "");
    writeFileSync(join(stubs, "requests", "utils.py"), `DEFAULT_CA_BUNDLE_PATH = ${JSON.stringify(requestsBundle)}\n`);
    writeFileSync(join(probeDir, "probe_under_test.py"), probeSource);
    return spawnSync(
      "python3",
      ["-I", "-c", "import sys; sys.path[:0] = sys.argv[1:]; import probe_under_test", probeDir, stubs],
      { encoding: "utf8" },
    );
  });
}

test("the probe reports the certifi the interpreter imports and the CA bundle requests trusts", async (t) => {
  const probeSource = withDir((dir) => {
    const bin = fakeBinary(dir);
    const result = check(["--binary", bin.path, "--python", "3.14.6", "--requirements", requirements(dir)]);
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(`${bin.record}.probe`, "utf8");
  });
  for (const [name, requestsBundle, expected] of [
    ["requests trusts certifi's bundle", "/frozen/certifi/cacert.pem", "certifi"],
    ["requests trusts another bundle", "/etc/ssl/cert.pem", "other"],
  ]) {
    await t.test(name, () => {
      const result = runProbe(probeSource, { requestsBundle });
      assert.equal(result.error, undefined, `python3 is required to run the probe: ${result.error?.message}`);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, `[goop-probe][debug] certifi 2026.10.19 - requests CA bundle ${expected}\n`);
      assert.equal(result.stdout, "");
    });
  }
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

test("the default requirements file is the macOS gallery-dl recipe and pins every checked package", () => {
  const text = readFileSync(recipe, "utf8");
  const checked = ["gallery-dl", "requests", "urllib3", "certifi"];
  for (const name of checked) {
    assert.match(text, new RegExp(`^${name}==\\d+\\.\\d+\\.\\d+ \\\\$`, "m"), `recipe must pin ${name}`);
  }
  withDir((dir) => {
    const pins = Object.fromEntries(
      checked.map((name) => [name, text.match(new RegExp(`^${name}==(\\S+)`, "m"))[1]]),
    );
    const bin = fakeBinary(dir, {
      stderrLines: report({
        version: pins["gallery-dl"],
        requests: pins.requests,
        urllib3: pins.urllib3,
        certifi: pins.certifi,
      }),
    });
    const result = check(["--binary", bin.path, "--python", "3.14.6"]);
    assert.equal(result.status, 0, result.stderr);
  });
});
