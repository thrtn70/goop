import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const gate = fileURLToPath(new URL("./npm-audit-gate.mjs", import.meta.url));
const acceptedFile = fileURLToPath(new URL("./npm-audit-accepted.json", import.meta.url));
const auditWorkflow = readFileSync(new URL("../.github/workflows/audit.yml", import.meta.url), "utf8");
const prePush = readFileSync(new URL("./pre-push.sh", import.meta.url), "utf8");

const BRACES = "GHSA-vfj7-8cjw-p6xm";
const SELECTOR = "GHSA-rj75-hqrm-r3gf";
const SHIPPED = "GHSA-2222-3333-4444";
const FUTURE = "2999-12-31";

function advisory(id, pkg, severity) {
  return {
    source: 1,
    name: pkg,
    dependency: pkg,
    title: `${pkg} advisory`,
    url: `https://github.com/advisories/${id}`,
    severity,
    range: "<9.9.9",
  };
}

// npm audit --json (auditReportVersion 2): one entry per vulnerable package.
// `via` holds advisory objects for a package's own advisories and plain
// package names for vulnerabilities it only inherits.
function report(entries) {
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(
      entries.map(({ pkg, severity, via }) => [
        pkg,
        { name: pkg, severity, isDirect: false, via, effects: [], range: "*", nodes: [`node_modules/${pkg}`] },
      ]),
    ),
    metadata: { vulnerabilities: {} },
  };
}

const CHAIN = [
  { pkg: "braces", severity: "high", via: [advisory(BRACES, "braces", "high")] },
  { pkg: "micromatch", severity: "high", via: ["braces"] },
  { pkg: "postcss-selector-parser", severity: "moderate", via: [advisory(SELECTOR, "postcss-selector-parser", "moderate")] },
  { pkg: "tailwindcss", severity: "high", via: ["micromatch", "postcss-selector-parser"] },
];
const TAILWIND_CHAIN = report(CHAIN);
const withChain = (...extra) => report([...CHAIN, ...extra]);
const CLEAN = report([]);

const ACCEPTED = {
  advisories: [
    { id: BRACES, package: "braces", expires: FUTURE, reason: "Build-time only, through tailwindcss 3; no patched release." },
    { id: SELECTOR, package: "postcss-selector-parser", expires: FUTURE, reason: "Build-time only, through tailwindcss 3." },
  ],
};

// The npm network failure shape (npm 10 and 11): exit 1, this JSON on stdout.
const NPM_NETWORK_ERROR = {
  message: "request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
  error: { summary: "", detail: "" },
};

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "goop-npm-audit-gate-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeIn(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

function run({ full = TAILWIND_CHAIN, prod = CLEAN, accepted = ACCEPTED } = {}) {
  return withDir((dir) =>
    spawnSync(
      process.execPath,
      [
        gate,
        "--full-report", writeIn(dir, "full.json", full),
        "--prod-report", writeIn(dir, "prod.json", prod),
        "--accepted", writeIn(dir, "accepted.json", accepted),
      ],
      { encoding: "utf8" },
    ),
  );
}

// Runs the gate with no report files, so it calls `npm` itself, with a stub
// npm first on PATH that logs its argv and answers like npm audit (exit 1).
function runWithStubNpm({ fullStdout, prodStdout, stderr = "", accepted = ACCEPTED }) {
  return withDir((dir) => {
    const log = join(dir, "argv.log");
    const fullOut = writeIn(dir, "full.out", fullStdout);
    const prodOut = writeIn(dir, "prod.out", prodStdout);
    const npm = join(dir, "npm");
    writeFileSync(
      npm,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> '${log}'`,
        `printf '%s' '${stderr}' >&2`,
        `case " $* " in *" --omit=dev "*) cat '${prodOut}' ;; *) cat '${fullOut}' ;; esac`,
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(npm, 0o755);
    const result = spawnSync(process.execPath, [gate, "--accepted", writeIn(dir, "accepted.json", accepted)], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
    });
    return { ...result, argv: readFileSync(log, "utf8").trim().split("\n") };
  });
}

test("passes when every development advisory is accepted and shipped dependencies are clean", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /shipped dependencies: no advisories/);
  assert.match(result.stdout, new RegExp(`${BRACES}.*braces`));
  assert.match(result.stdout, new RegExp(`${SELECTOR}.*postcss-selector-parser`));
});

test("fails on a moderate or higher advisory that is not accepted", async (t) => {
  for (const severity of ["moderate", "high", "critical"]) {
    await t.test(severity, () => {
      const full = withChain({ pkg: "esbuild", severity, via: [advisory("GHSA-5555-6666-7777", "esbuild", severity)] });
      const result = run({ full });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /::error::unaccepted advisory GHSA-5555-6666-7777.*esbuild/);
    });
  }
});

test("ignores low and info advisories, as the previous audit level did", () => {
  const full = withChain(
    { pkg: "debug", severity: "low", via: [advisory("GHSA-8888-9999-cccc", "debug", "low")] },
    { pkg: "ms", severity: "info", via: [advisory("GHSA-8888-9999-dddd", "ms", "info")] },
  );
  const result = run({ full });
  assert.equal(result.status, 0, result.stderr);
});

test("keeps shipped dependencies strict: an accepted advisory still fails if it reaches them", () => {
  const prod = report([{ pkg: "braces", severity: "high", via: [advisory(BRACES, "braces", "high")] }]);
  const result = run({ prod });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`::error::shipped dependencies have ${BRACES}`));
});

test("fails on any shipped advisory at moderate or above", () => {
  const shipped = { pkg: "react-dom", severity: "moderate", via: [advisory(SHIPPED, "react-dom", "moderate")] };
  const result = run({ prod: report([shipped]), full: withChain(shipped) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`::error::shipped dependencies have ${SHIPPED}`));
});

test("fails when an accepted advisory no longer appears, so the list cannot go stale", () => {
  const full = report([CHAIN[0]]);
  const result = run({ full });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`::error::accepted advisory ${SELECTOR}.*no longer appears`));
});

test("an accepted ID only covers the package it names", async (t) => {
  await t.test("reported for a different package", () => {
    const full = report([
      { pkg: "braces", severity: "high", via: [advisory(BRACES, "fill-range", "high")] },
      CHAIN[2],
    ]);
    const result = run({ full });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`::error::${BRACES} is accepted for braces only, but also affects fill-range`));
  });
  for (const order of ["after", "before"]) {
    await t.test(`reported for its package and another listed ${order} it`, () => {
      const other = { pkg: "fill-range", severity: "high", via: [advisory(BRACES, "fill-range", "high")] };
      const full = order === "after" ? withChain(other) : report([other, ...CHAIN]);
      const result = run({ full });
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`::error::${BRACES} is accepted for braces only, but also affects fill-range`));
    });
  }
});

test("an accepted advisory past its expiry date fails until it is revisited", () => {
  const accepted = { advisories: [{ ...ACCEPTED.advisories[0], expires: "2000-01-01" }, ACCEPTED.advisories[1]] };
  const result = run({ accepted });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`::error::accepted advisory ${BRACES} \\(braces\\) expired on 2000-01-01`));
});

// Each bad report is otherwise valid next to the accepted chain, so only the
// named defect can fail it; each is tried as the full and as the shipped report.
test("fails closed on an unusable full or shipped report", async (t) => {
  const badAdvisory = (overrides) => ({ pkg: "x", severity: "high", via: [{ ...advisory("GHSA-aaaa-bbbb-cccc", "x", "high"), ...overrides }] });
  const cases = [
    ["not JSON", () => "npm ERR! network", /did not produce JSON/],
    ["npm network error", () => NPM_NETWORK_ERROR, /failed: request to .*getaddrinfo ENOTFOUND/],
    ["no vulnerabilities key", () => ({ auditReportVersion: 2 }), /not an npm audit report/],
    ["unknown report version", () => ({ ...CLEAN, auditReportVersion: 1 }), /not an npm audit report/],
    ["advisory without a GHSA id", (base) => [...base, badAdvisory({ url: "https://example.test/1" })], /without a GHSA id/],
    ["unknown severity", (base) => [...base, badAdvisory({ severity: "severe" })], /unknown severity/],
  ];
  for (const [name, make, message] of cases) {
    for (const which of ["full", "prod"]) {
      await t.test(`${name} (${which})`, () => {
        const built = make(which === "full" ? CHAIN : []);
        const bad = Array.isArray(built) ? report(built) : built;
        const result = run(which === "full" ? { full: bad } : { prod: bad });
        assert.equal(result.status, 1);
        assert.match(result.stderr, new RegExp(`::error::.*${message.source}`));
      });
    }
  }
});

test("rejects a malformed accepted list", async (t) => {
  const one = ACCEPTED.advisories[0];
  for (const [name, accepted] of [
    ["not JSON", "{"],
    ["no advisories array", {}],
    ["bad id", { advisories: [{ ...one, id: "CVE-2026-1" }] }],
    ["duplicate id", { advisories: [one, one] }],
    ["missing package", { advisories: [{ id: one.id, expires: FUTURE, reason: one.reason }] }],
    ["empty reason", { advisories: [{ ...one, reason: " " }] }],
    ["missing expiry", { advisories: [{ id: one.id, package: one.package, reason: one.reason }] }],
    ["impossible expiry", { advisories: [{ ...one, expires: "2026-13-40" }] }],
  ]) {
    await t.test(name, () => {
      const result = run({ accepted });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /::error::.*accepted advisory list/i);
    });
  }
});

// Explicit includes override an inherited npm_config_omit (or NODE_ENV)
// that would otherwise drop dev, optional or peer packages from a run.
test("runs npm audit itself: every dependency type, then shipped only", () => {
  const result = runWithStubNpm({ fullStdout: JSON.stringify(TAILWIND_CHAIN), prodStdout: JSON.stringify(CLEAN) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.argv, [
    "audit --json --include=dev --include=optional --include=peer",
    "audit --json --omit=dev --include=optional --include=peer",
  ]);
});

test("reports why npm audit failed", async (t) => {
  await t.test("network error JSON", () => {
    const result = runWithStubNpm({ fullStdout: JSON.stringify(NPM_NETWORK_ERROR), prodStdout: JSON.stringify(CLEAN) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::.*getaddrinfo ENOTFOUND registry\.npmjs\.org/);
  });
  await t.test("no output at all", () => {
    const result = runWithStubNpm({ fullStdout: "", prodStdout: "", stderr: "npm ERR! cannot reach the registry" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::.*exited 1.*cannot reach the registry/);
  });
});

test("the repository's accepted list is well formed and explains each entry", () => {
  const { advisories } = JSON.parse(readFileSync(acceptedFile, "utf8"));
  assert.ok(Array.isArray(advisories) && advisories.length > 0);
  for (const entry of advisories) {
    assert.match(entry.id, /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/);
    assert.ok(entry.package.length > 0);
    assert.match(entry.expires, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.reason.trim().length > 20, `${entry.id} needs a real reason`);
  }
});

test("CI runs the gate in place of the bare npm audit, and both gates run these tests", () => {
  const web = auditWorkflow.slice(auditWorkflow.indexOf("\n  web:\n"), auditWorkflow.indexOf("\n  legal:\n"));
  assert.match(web, /^ {6}- run: node scripts\/npm-audit-gate\.mjs$/m);
  assert.doesNotMatch(web, /npm audit --audit-level/);
  assert.match(web, /^ {6}- run: node --test scripts\/npm-audit-gate\.test\.mjs$/m);
  assert.match(prePush, /node --test scripts\/npm-audit-gate\.test\.mjs/);
});
