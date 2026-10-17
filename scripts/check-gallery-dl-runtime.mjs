#!/usr/bin/env node
// Prove which gallery-dl, Python, requests and urllib3 a frozen gallery-dl
// binary actually runs, and compare them with the macOS freezer recipe.
//
// A pin in gallery-dl-macos-requirements.txt is not proof the binary carries
// it: the freezer could resolve a different wheel, or a stale binary could be
// bundled. With --verbose, gallery-dl logs the versions of the modules it
// really imported, so ask the binary. --list-modules exits 0 with no URL and
// no network; --config-ignore keeps a user config out of the run. The child
// gets a throwaway HOME/TMPDIR (PyInstaller unpacks there) and nothing else
// from this environment.
//
// Usage:
//   node scripts/check-gallery-dl-runtime.mjs --binary <path> --python <x.y.z>
//        [--requirements <path>] [--timeout-ms <n>]
//
// Exit 0: every reported version matches. 1: a mismatch, or the binary could
// not report. 2: usage error.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_REQUIREMENTS = fileURLToPath(new URL("./gallery-dl-macos-requirements.txt", import.meta.url));
const DEFAULT_TIMEOUT_MS = 30_000;
const PINNED_PACKAGES = ["gallery-dl", "requests", "urllib3"];
const GALLERY_DL_ARGS = ["--config-ignore", "--verbose", "--list-modules"];
// gallery-dl's default log format is "[{name}][{levelname}] {message}" on stderr.
const DEBUG_LINE = /^\[[^\]\n]+\]\[debug\] (Version|Python|requests) (.+)$/;
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
    const result = spawnSync(binary, GALLERY_DL_ARGS, {
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
  return { version, python, platform, requests, urllib3 };
}

function compare(report, pins, python) {
  const problems = [];
  const pairs = [
    ["gallery-dl", report.version],
    ["requests", report.requests],
    ["urllib3", report.urllib3],
  ];
  for (const [name, actual] of pairs) {
    if (actual !== pins[name]) problems.push(`${name} ${actual} does not match the recipe's ${pins[name]}`);
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
      `requests ${report.requests}, urllib3 ${report.urllib3}`;
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
