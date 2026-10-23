#!/usr/bin/env node
// Prove that a downloaded yt-dlp binary is the pinned release and that the
// certifi and urllib3 it actually imports clear Goop's security floors.
//
// yt-dlp is fetched prebuilt (scripts/fetch-sidecars.sh), so its bundled
// libraries change only with YT_DLP_VERSION, and upstream's recipe is no
// proof the binary carries them. With -v and no URL, yt-dlp logs its version
// and the versions of the optional libraries it really imported, then stops
// on its no-URL usage error (exit 2) without touching the network.
// --ignore-config keeps a user config out of the run. The child gets a
// throwaway HOME/TMPDIR (PyInstaller unpacks there) and nothing else from
// this environment.
//
// Usage:
//   node scripts/check-yt-dlp-runtime.mjs --binary <path>
//        [--fetch-script <path>] [--timeout-ms <n>]
//
// Exit 0: the version matches the pin and every floor is met. 1: a mismatch,
// a library below its floor, or the binary could not report. 2: usage error.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_FETCH_SCRIPT = fileURLToPath(new URL("./fetch-sidecars.sh", import.meta.url));
const DEFAULT_TIMEOUT_MS = 30_000;
const YT_DLP_ARGS = ["--ignore-config", "-v"];
// Lowest versions a shipped yt-dlp may import.
//   certifi 2026.10.19 drops "emSign ECC Root CA - G3", whose intermediate CA
//   keys were compromised (GHSA-6q48-6c7w-9gw2).
//   urllib3 2.8.0 fixes GHSA-8988-9cw3-xx77, GHSA-vxq7-64xx-v4gw and
//   GHSA-gh4c-6fx4-qh6g, the floor the gallery-dl recipe already holds.
const FLOORS = { certifi: "2026.10.19", urllib3: "2.8.0" };
const DEBUG_LINE = /^\[debug\] (yt-dlp version|Python|Optional libraries):? (.+)$/;
const NO_URL_ERROR = /: error: You must provide at least one URL\.$/m;
const NO_URL_STATUS = 2;
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
        "fetch-script": { type: "string" },
        "timeout-ms": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (!values.binary) throw new UsageError("--binary <path> is required");
  const timeoutMs = values["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new UsageError(`--timeout-ms must be a positive integer, got "${values["timeout-ms"]}"`);
  }
  return {
    binary: values.binary,
    fetchScript: values["fetch-script"] ?? DEFAULT_FETCH_SCRIPT,
    timeoutMs,
  };
}

function readPin(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new CheckError(`cannot read fetch script ${path}: ${error.message}`);
  }
  const matches = [...text.matchAll(/^YT_DLP_VERSION="([^"\n]+)"$/gm)];
  if (matches.length !== 1) {
    throw new CheckError(`${path} must set YT_DLP_VERSION exactly once (found ${matches.length})`);
  }
  return matches[0][1];
}

function stderrContext(stderr) {
  const text = (stderr ?? "").trim();
  return text.length > STDERR_CONTEXT_CHARS ? `…${text.slice(-STDERR_CONTEXT_CHARS)}` : text;
}

// Windows needs SystemRoot to start Python and TEMP/TMP for the PyInstaller
// unpack directory; USERPROFILE is what expanduser reads there.
function scrubbedEnv(home) {
  const posix = {
    HOME: home,
    TMPDIR: home,
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
  };
  if (process.platform !== "win32") return { ...posix, PATH: "/usr/bin:/bin" };
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return {
    ...posix,
    USERPROFILE: home,
    APPDATA: join(home, "appdata"),
    LOCALAPPDATA: join(home, "localappdata"),
    TEMP: home,
    TMP: home,
    SystemRoot: systemRoot,
    PATH: `${systemRoot}\\System32;${systemRoot}`,
  };
}

function runYtDlp(binary, timeoutMs) {
  if (!existsSync(binary)) throw new CheckError(`yt-dlp binary not found: ${binary}`);
  const home = mkdtempSync(join(tmpdir(), "goop-yt-dlp-home-"));
  try {
    const result = spawnSync(binary, YT_DLP_ARGS, {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      env: scrubbedEnv(home),
    });
    // On timeout only the direct child is killed. A PyInstaller onefile
    // bootloader may leave its unpacked child running; that is acceptable on
    // an ephemeral runner, and the check still fails promptly.
    if (result.error?.code === "ETIMEDOUT") {
      throw new CheckError(`yt-dlp timed out after ${timeoutMs} ms and was killed`);
    }
    if (result.error) throw new CheckError(`could not run ${binary}: ${result.error.message}`);
    if (result.signal) throw new CheckError(`yt-dlp was killed by ${result.signal}`);
    if (result.status !== NO_URL_STATUS) {
      throw new CheckError(
        `yt-dlp exited with status ${result.status}, not its no-URL usage error (${NO_URL_STATUS})\n` +
          stderrContext(result.stderr),
      );
    }
    if (!NO_URL_ERROR.test(result.stderr)) {
      throw new CheckError(`yt-dlp exited ${NO_URL_STATUS} without its no-URL usage error\n${stderrContext(result.stderr)}`);
    }
    return result.stderr;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function parseLibraries(text) {
  const libraries = new Map();
  for (const entry of text.split(", ")) {
    const match = /^(.+?)(?:-(\S+))?$/.exec(entry.trim());
    if (match) libraries.set(match[1], match[2]);
  }
  return libraries;
}

function parseReport(stderr) {
  const found = new Map();
  for (const line of stderr.split(/\r?\n/)) {
    const match = DEBUG_LINE.exec(line);
    if (!match) continue;
    if (found.has(match[1])) throw new CheckError(`yt-dlp reported its "${match[1]}" line more than once`);
    found.set(match[1], match[2]);
  }
  const versionLine = found.get("yt-dlp version");
  if (versionLine === undefined) throw new CheckError('yt-dlp did not report a "yt-dlp version …" debug line');
  const version = /^(?:([\w.-]+)@)?(\S+)/.exec(versionLine);
  const librariesLine = found.get("Optional libraries");
  if (librariesLine === undefined) throw new CheckError('yt-dlp did not report an "Optional libraries: …" debug line');
  return {
    channel: version[1],
    version: version[2],
    python: found.get("Python")?.split(" ")[0] ?? "unreported",
    libraries: parseLibraries(librariesLine),
  };
}

function numericParts(name, version) {
  if (!/^\d+(?:\.\d+)*$/.test(version)) {
    throw new CheckError(`unrecognised ${name} version "${version}"; the floor check needs a numeric release`);
  }
  return version.split(".").map(Number);
}

function isBelow(name, actual, floor) {
  const a = numericParts(name, actual);
  const b = numericParts(name, floor);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

function compare(report, pin) {
  const problems = [];
  if (report.version !== pin) problems.push(`yt-dlp ${report.version} is not the pinned ${pin}`);
  for (const [name, floor] of Object.entries(FLOORS)) {
    if (!report.libraries.has(name)) {
      problems.push(`yt-dlp did not report ${name} among its optional libraries`);
      continue;
    }
    const actual = report.libraries.get(name);
    if (actual === undefined) {
      problems.push(`yt-dlp reported ${name} with no version`);
    } else if (isBelow(name, actual, floor)) {
      problems.push(`${name} ${actual} is below the ${floor} floor`);
    }
  }
  return problems;
}

function summarise(report) {
  const library = (name) => `${name} ${report.libraries.get(name) ?? "unreported"}`;
  const label = report.channel ? `${report.channel}@${report.version}` : report.version;
  return `yt-dlp ${label}, Python ${report.python}, ${library("certifi")}, ${library("urllib3")}`;
}

function main(argv) {
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(`usage: check-yt-dlp-runtime.mjs --binary <path> [--fetch-script <path>] [--timeout-ms <n>]\n${error.message}`);
    return 2;
  }
  try {
    const pin = readPin(options.fetchScript);
    const report = parseReport(runYtDlp(options.binary, options.timeoutMs));
    const problems = compare(report, pin);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`::error::${problem}`);
      console.error(`reported by ${options.binary}: ${summarise(report)}`);
      return 1;
    }
    console.log(
      `yt-dlp runtime matches the pin and clears the floors ` +
        `(certifi >= ${FLOORS.certifi}, urllib3 >= ${FLOORS.urllib3}): ${summarise(report)}`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    console.error(`::error::${error.message}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
