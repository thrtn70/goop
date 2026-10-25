#!/usr/bin/env node
// Prove which gallery-dl, Python, requests, urllib3 and certifi a frozen
// gallery-dl binary actually runs, and compare them with the macOS freezer
// recipe.
//
// A pin in gallery-dl-macos-requirements.txt is not proof the binary carries
// it: the freezer could resolve a different wheel, or a stale binary could be
// bundled. With --verbose, gallery-dl logs the versions of the modules it
// really imported, so ask the binary. It does not log certifi, whose CA bundle
// is what requests trusts, so a probe module passed through gallery-dl's
// "globals" option reports it from inside the frozen interpreter. A gallery-dl
// that ignores the option prints no probe line and fails the check.
// --list-modules exits 0 with no URL and no network; --config-ignore keeps a
// user config out of the run. The child gets a throwaway HOME/TMPDIR
// (PyInstaller unpacks there, and the probe lives there) and nothing else from
// this environment.
//
// Usage:
//   node scripts/check-gallery-dl-runtime.mjs --binary <path> --python <x.y.z>
//        [--requirements <path>] [--timeout-ms <n>]
//
// Exit 0: every reported version matches. 1: a mismatch, or the binary could
// not report. 2: usage error.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_REQUIREMENTS = fileURLToPath(new URL("./gallery-dl-macos-requirements.txt", import.meta.url));
const DEFAULT_TIMEOUT_MS = 30_000;
const PINNED_PACKAGES = ["gallery-dl", "requests", "urllib3", "certifi"];
// gallery-dl imports this file at startup, before it logs anything, and writes
// in its own log format so one parser reads both.
const PROBE_MODULE = [
  "import sys",
  "",
  "import certifi",
  "import requests.utils",
  "",
  'bundle = "certifi" if requests.utils.DEFAULT_CA_BUNDLE_PATH == certifi.where() else "other"',
  'print(f"[goop-probe][debug] certifi {certifi.__version__} - requests CA bundle {bundle}", file=sys.stderr)',
  "",
].join("\n");
// gallery-dl's default log format is "[{name}][{levelname}] {message}" on stderr.
const DEBUG_LINE = /^\[[^\]\n]+\]\[debug\] (Version|Python|requests|certifi) (.+)$/;
const STDERR_CONTEXT_CHARS = 2_000;

class UsageError extends Error {}
class CheckError extends Error {}

function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        binary: { type: "string" },
        python: { type: "string" },
        requirements: { type: "string" },
        "timeout-ms": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (!values.binary) throw new UsageError("--binary <path> is required");
  if (!values.python) throw new UsageError("--python <x.y.z> is required");
  if (!/^\d+\.\d+\.\d+$/.test(values.python)) {
    throw new UsageError(`--python must be an exact x.y.z version, got "${values.python}"`);
  }
  const timeoutMs = values["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new UsageError(`--timeout-ms must be a positive integer, got "${values["timeout-ms"]}"`);
  }
  return {
    binary: values.binary,
    python: values.python,
    requirements: values.requirements ?? DEFAULT_REQUIREMENTS,
    timeoutMs,
  };
}

function readPins(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new CheckError(`cannot read requirements file ${path}: ${error.message}`);
  }
  const pins = {};
  for (const name of PINNED_PACKAGES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = [...text.matchAll(new RegExp(`^${escaped}==([^\\s\\\\]+)`, "gm"))];
    if (matches.length !== 1) {
      throw new CheckError(`${path} must pin ${name} exactly once (found ${matches.length})`);
    }
    pins[name] = matches[0][1];
  }
  return pins;
}

function stderrContext(stderr) {
  const text = (stderr ?? "").trim();
  return text.length > STDERR_CONTEXT_CHARS ? `…${text.slice(-STDERR_CONTEXT_CHARS)}` : text;
}

function runGalleryDl(binary, timeoutMs) {
  if (!existsSync(binary)) throw new CheckError(`gallery-dl binary not found: ${binary}`);
  const home = mkdtempSync(join(tmpdir(), "goop-gallery-dl-home-"));
  try {
    // gallery-dl puts the probe's directory on sys.path, so give it its own.
    const probeDir = join(home, "probe");
    mkdirSync(probeDir);
    const probe = join(probeDir, "goop_runtime_probe.py");
    writeFileSync(probe, PROBE_MODULE);
    const args = ["--config-ignore", "--verbose", "-o", `globals=${probe}`, "--list-modules"];
    const result = spawnSync(binary, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        HOME: home,
        TMPDIR: home,
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        PATH: "/usr/bin:/bin",
      },
    });
    // On timeout only the direct child is killed. A PyInstaller onefile
    // bootloader may leave its unpacked child running; that is acceptable on
    // an ephemeral runner, and the check still fails promptly.
    if (result.error?.code === "ETIMEDOUT") {
      throw new CheckError(`gallery-dl timed out after ${timeoutMs} ms and was killed`);
    }
    if (result.error) throw new CheckError(`could not run ${binary}: ${result.error.message}`);
    if (result.signal) throw new CheckError(`gallery-dl was killed by ${result.signal}`);
    if (result.status !== 0) {
      throw new CheckError(`gallery-dl exited with status ${result.status}\n${stderrContext(result.stderr)}`);
    }
    return result.stderr;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function requireField(found, key, pattern, description) {
  const value = found.get(key);
  if (value === undefined) throw new CheckError(`gallery-dl did not report a "${description}" debug line`);
  const match = pattern.exec(value);
  if (!match) throw new CheckError(`unrecognised gallery-dl "${key}" line: ${value}`);
  return match;
}

function parseReport(stderr) {
  const found = new Map();
  for (const line of stderr.split(/\r?\n/)) {
    const match = DEBUG_LINE.exec(line);
    if (!match) continue;
    if (found.has(match[1])) throw new CheckError(`gallery-dl reported its "${match[1]}" line more than once`);
    found.set(match[1], match[2]);
  }
  const [, version] = requireField(found, "Version", /^(\S+)(?: - .+)?$/, "Version …");
  const [, python, platform] = requireField(found, "Python", /^(\S+) - (\S+)$/, "Python … - <platform>");
  const [, requests, urllib3] = requireField(
    found,
    "requests",
    /^(\S+) - urllib3 (\S+)$/,
    "requests … - urllib3 …",
  );
  const [, certifi, caBundle] = requireField(
    found,
    "certifi",
    /^(\S+) - requests CA bundle (certifi|other)$/,
    "certifi … - requests CA bundle …",
  );
  return { version, python, platform, requests, urllib3, certifi, caBundle };
}

// certifi's __version__ zero-pads the month and day ("2026.07.22") while a pip
// pin is normalised ("2026.7.22"), so compare all-numeric versions part by part
// by value, as PEP 440 does. Every other package reports its canonical form.
function versionsMatch(reported, pinned) {
  const numeric = /^\d+(?:\.\d+)*$/;
  if (!numeric.test(reported) || !numeric.test(pinned)) return reported === pinned;
  const a = reported.split(".").map(Number);
  const b = pinned.split(".").map(Number);
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

function compare(report, pins, python) {
  const problems = [];
  const pairs = [
    ["gallery-dl", report.version],
    ["requests", report.requests],
    ["urllib3", report.urllib3],
    ["certifi", report.certifi],
  ];
  for (const [name, actual] of pairs) {
    if (!versionsMatch(actual, pins[name])) problems.push(`${name} ${actual} does not match the recipe's ${pins[name]}`);
  }
  if (report.caBundle !== "certifi") {
    problems.push("requests trusts a CA bundle other than the bundled certifi's");
  }
  if (report.python !== python) {
    problems.push(`Python ${report.python} does not match the build interpreter ${python}`);
  }
  if (!/(?:^|-)arm64(?:-|$)/.test(report.platform)) {
    problems.push(`the frozen interpreter's platform ${report.platform} is not arm64`);
  }
  return problems;
}

function main(argv) {
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(`usage: check-gallery-dl-runtime.mjs --binary <path> --python <x.y.z> [--requirements <path>] [--timeout-ms <n>]\n${error.message}`);
    return 2;
  }
  try {
    const pins = readPins(options.requirements);
    const report = parseReport(runGalleryDl(options.binary, options.timeoutMs));
    const problems = compare(report, pins, options.python);
    const summary =
      `gallery-dl ${report.version}, Python ${report.python} (${report.platform}), ` +
      `requests ${report.requests}, urllib3 ${report.urllib3}, certifi ${report.certifi}`;
    if (problems.length > 0) {
      for (const problem of problems) console.error(`::error::${problem}`);
      console.error(`reported by ${options.binary}: ${summary}`);
      return 1;
    }
    console.log(`gallery-dl runtime matches ${basename(options.requirements)}: ${summary}`);
    return 0;
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    console.error(`::error::${error.message}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
