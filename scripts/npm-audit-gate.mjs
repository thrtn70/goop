// npm dependency audit with a reviewed exception list.
//
// Shipped dependencies stay strict: `npm audit --omit=dev` must report no
// advisory at moderate or above, and nothing can excuse one. For the full
// tree, every advisory at moderate or above must appear in
// scripts/npm-audit-accepted.json, identified by its GHSA id AND the package
// it affects. An accepted entry that no longer appears is an error too, so the
// list shrinks as soon as an upstream fix lands instead of quietly growing,
// and each entry carries an expiry date that forces a fresh review.
//
// Usage:
//   node scripts/npm-audit-gate.mjs [--accepted <file>]
//        [--full-report <npm-audit.json> --prod-report <npm-audit.json>]
// Without report files the gate runs `npm audit --json` itself.
// Exit 0: pass. 1: a finding, or an unusable report or list. 2: usage.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_ACCEPTED = fileURLToPath(new URL("./npm-audit-accepted.json", import.meta.url));
const BLOCKING = new Set(["moderate", "high", "critical"]);
const KNOWN_SEVERITIES = new Set(["info", "low", ...BLOCKING]);
const GHSA_ID = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
const GHSA_URL = /^https:\/\/github\.com\/advisories\/(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NPM_TIMEOUT_MS = 180_000;
const CONTEXT_CHARS = 300;

class UsageError extends Error {}
class GateError extends Error {}

function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        accepted: { type: "string" },
        "full-report": { type: "string" },
        "prod-report": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (Boolean(values["full-report"]) !== Boolean(values["prod-report"])) {
    throw new UsageError("pass both --full-report and --prod-report, or neither");
  }
  return {
    accepted: values.accepted ?? DEFAULT_ACCEPTED,
    fullReport: values["full-report"],
    prodReport: values["prod-report"],
  };
}

function readAccepted(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new GateError(`cannot read the accepted advisory list ${path}: ${error.message}`);
  }
  if (!Array.isArray(parsed?.advisories)) {
    throw new GateError(`accepted advisory list ${path} must hold an "advisories" array`);
  }
  const accepted = new Map();
  for (const entry of parsed.advisories) {
    const label = JSON.stringify(entry);
    if (typeof entry?.id !== "string" || !GHSA_ID.test(entry.id)) {
      throw new GateError(`accepted advisory list entry needs a GHSA id: ${label}`);
    }
    if (typeof entry.package !== "string" || entry.package.trim() === "") {
      throw new GateError(`accepted advisory list entry ${entry.id} must name its package`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new GateError(`accepted advisory list entry ${entry.id} must give a reason`);
    }
    entry.expiresAt = expiryInstant(entry);
    if (accepted.has(entry.id)) throw new GateError(`accepted advisory list repeats ${entry.id}`);
    accepted.set(entry.id, entry);
  }
  return accepted;
}

// An entry is valid through the end of its expiry day (UTC).
function expiryInstant(entry) {
  const match = ISO_DATE.exec(typeof entry.expires === "string" ? entry.expires : "");
  const date = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!date || date.toISOString().slice(0, 10) !== entry.expires) {
    throw new GateError(`accepted advisory list entry ${entry.id} needs an "expires" date as YYYY-MM-DD`);
  }
  return date.getTime() + 24 * 60 * 60 * 1000;
}

function runNpmAudit(extraArgs) {
  const args = ["audit", "--json", ...extraArgs];
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: NPM_TIMEOUT_MS,
  });
  if (result.error?.code === "ETIMEDOUT") throw new GateError(`npm ${args.join(" ")} timed out after ${NPM_TIMEOUT_MS} ms`);
  if (result.error) throw new GateError(`could not run npm audit: ${result.error.message}`);
  // npm audit exits non-zero whenever it finds anything; the JSON decides.
  return { label: `npm ${args.join(" ")}`, text: result.stdout, status: result.status, stderr: result.stderr };
}

function readReport({ label, text, status, stderr }) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    const exit = status === undefined ? "" : ` (exited ${status}${stderr?.trim() ? `: ${stderr.trim().slice(0, CONTEXT_CHARS)}` : ""})`;
    throw new GateError(`${label} did not produce JSON${exit}: ${text.trim().slice(0, CONTEXT_CHARS)}`);
  }
  if (report?.error) {
    // npm puts the cause in `message`; `error.summary` is often empty.
    const cause = report.message || report.error.summary || JSON.stringify(report.error);
    throw new GateError(`${label} failed: ${cause}`);
  }
  if (report?.auditReportVersion !== 2 || typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
    throw new GateError(`${label} is not an npm audit report (auditReportVersion 2 with vulnerabilities)`);
  }
  return report;
}

// One record per advisory at moderate or above. A package's `via` lists its
// own advisories as objects and inherited ones as bare package names; only the
// objects are advisories.
function blockingAdvisories(report, label) {
  const found = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      if (!KNOWN_SEVERITIES.has(via.severity)) {
        throw new GateError(`${label} reports an advisory with unknown severity: ${JSON.stringify(via)}`);
      }
      if (!BLOCKING.has(via.severity)) continue;
      const id = GHSA_URL.exec(via.url ?? "")?.[1];
      if (!id) throw new GateError(`${label} reports an advisory without a GHSA id: ${JSON.stringify(via)}`);
      const packages = found.get(id)?.packages ?? new Set();
      packages.add(via.name);
      found.set(id, { id, severity: via.severity, title: via.title, packages });
    }
  }
  return found;
}

function describe(advisory) {
  return `${advisory.id} (${advisory.severity}) in ${[...advisory.packages].join(", ")}: ${advisory.title}`;
}

function evaluate(full, prod, accepted, now) {
  const problems = [];
  for (const entry of accepted.values()) {
    if (now >= entry.expiresAt) {
      problems.push(`accepted advisory ${entry.id} (${entry.package}) expired on ${entry.expires}; fix it, or review it again and set a new date`);
    }
  }
  for (const advisory of prod.values()) {
    problems.push(`shipped dependencies have ${describe(advisory)}; shipped advisories cannot be accepted`);
  }
  for (const advisory of full.values()) {
    const entry = accepted.get(advisory.id);
    if (!entry) {
      problems.push(`unaccepted advisory ${describe(advisory)}`);
      continue;
    }
    const others = [...advisory.packages].filter((name) => name !== entry.package);
    if (others.length > 0) {
      problems.push(`${advisory.id} is accepted for ${entry.package} only, but also affects ${others.join(", ")}`);
    }
  }
  for (const entry of accepted.values()) {
    if (!full.has(entry.id)) {
      problems.push(`accepted advisory ${entry.id} (${entry.package}) no longer appears; remove it from the list`);
    }
  }
  return problems;
}

function main(argv) {
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(`usage: npm-audit-gate.mjs [--accepted <file>] [--full-report <file> --prod-report <file>]\n${error.message}`);
    return 2;
  }
  try {
    const accepted = readAccepted(options.accepted);
    // Explicit includes override an inherited NODE_ENV=production or
    // npm_config_omit, which would otherwise silently drop dev, optional or
    // peer packages from a run. Only the shipped run omits anything: dev.
    const keep = ["--include=optional", "--include=peer"];
    const fullSource = options.fullReport
      ? { label: options.fullReport, text: readFileSync(options.fullReport, "utf8") }
      : runNpmAudit(["--include=dev", ...keep]);
    const prodSource = options.prodReport
      ? { label: options.prodReport, text: readFileSync(options.prodReport, "utf8") }
      : runNpmAudit(["--omit=dev", ...keep]);
    const full = blockingAdvisories(readReport(fullSource), fullSource.label);
    const prod = blockingAdvisories(readReport(prodSource), prodSource.label);
    const problems = evaluate(full, prod, accepted, Date.now());
    if (problems.length > 0) {
      for (const problem of problems) console.error(`::error::${problem}`);
      return 1;
    }
    console.log("shipped dependencies: no advisories at moderate or above");
    if (full.size === 0) {
      console.log("development dependencies: no advisories at moderate or above");
    } else {
      console.log(`development dependencies: ${full.size} accepted advisory(ies):`);
      for (const advisory of full.values()) console.log(`  ${describe(advisory)}`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(`::error::${error.message}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
