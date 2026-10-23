import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scrubbedEnv } from "./check-yt-dlp-runtime.mjs";

const checker = fileURLToPath(new URL("./check-yt-dlp-runtime.mjs", import.meta.url));
const fetchScript = fileURLToPath(new URL("./fetch-sidecars.sh", import.meta.url));

// What yt-dlp 2026.10.21's macOS binary printed for `--ignore-config -v`,
// trimmed to the lines the checker reads plus their neighbours.
const AT_FLOORS = {
  version: "stable@2026.10.21",
  certifi: "2026.10.19",
  urllib3: "2.8.0",
};

function libraries({ certifi, urllib3 }) {
  return [
    "Cryptodome-3.24.1",
    "brotli-1.2.0",
    certifi === undefined ? null : certifi === "" ? "certifi" : `certifi-${certifi}`,
    "curl_cffi-0.16.3",
    "mutagen-1.48.1",
    "requests-2.34.2",
    "sqlite3-3.50.4",
    urllib3 === undefined ? null : urllib3 === "" ? "urllib3" : `urllib3-${urllib3}`,
    "websockets-17.2",
    "yt_dlp_ejs-0.8.0",
  ].filter((entry) => entry !== null).join(", ");
}

function report(overrides = {}) {
  const r = { ...AT_FLOORS, ...overrides };
  return [
    "[debug] Command-line config: ['--ignore-config', '-v']",
    "[debug] Encodings: locale utf-8, fs utf-8, pref utf-8, out utf-8 (No ANSI), error utf-8 (No ANSI), screen utf-8 (No ANSI)",
    `[debug] yt-dlp version ${r.version} from yt-dlp/yt-dlp [8cdf4fea4] (darwin_exe)`,
    "[debug] Python 3.14.7 (CPython arm64 64bit) - macOS-14.7-arm64-arm-64bit-Mach-O (OpenSSL 3.5.7 9 Jun 2026)",
    "[debug] exe versions: none",
    `[debug] Optional libraries: ${libraries(r)}`,
    "[debug] JS runtimes: none",
    "[debug] Proxy map: {}",
    "[debug] Request Handlers: urllib, requests, websockets, curl_cffi",
    "[debug] Loaded 1747 extractors",
  ];
}

const NO_URL = [
  "",
  "Usage: yt-dlp [OPTIONS] URL [URL...]",
  "",
  "yt-dlp: error: You must provide at least one URL.",
  "Type yt-dlp --help to see a list of all options.",
];

// A stand-in for the downloaded binary: prints the given lines on stderr
// (where yt-dlp writes its debug header and usage errors), exits like
// yt-dlp does when given no URL, and records its argv and environment.
// POSIX shell only, so these tests run on the macOS gate and the Linux web job.
function fakeBinary(dir, { stderrLines = [...report(), ...NO_URL], exitCode = 2, hang = false } = {}) {
  const path = join(dir, "yt-dlp");
  const record = join(dir, "record");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > '${record}.args'`,
    `printf '%s' "$HOME" > '${record}.home'`,
    `pwd -P > '${record}.cwd'`,
    `printf '%s' "\${GOOP_LEAK_PROBE-unset}" > '${record}.leak'`,
    hang ? "exec sleep 10" : "",
    "cat >&2 <<'EOF'",
    ...stderrLines,
    "EOF",
    `exit ${exitCode}`,
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { path, record };
}

function pins(dir, text = 'YT_DLP_VERSION="2026.10.21"\nYT_DLP_MACOS_SHA256="00"\n') {
  const path = join(dir, "fetch-sidecars.sh");
  writeFileSync(path, text);
  return path;
}

function check(args, env = {}) {
  return spawnSync(process.execPath, [checker, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "goop-yt-dlp-runtime-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir, binary, extra = []) {
  return check(["--binary", binary.path, "--fetch-script", pins(dir), ...extra]);
}

test("accepts the pinned yt-dlp when certifi and urllib3 sit exactly at the floors", () => {
  withDir((dir) => {
    const result = run(dir, fakeBinary(dir));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /yt-dlp stable@2026\.10\.21/);
    assert.match(result.stdout, /certifi 2026\.10\.19/);
    assert.match(result.stdout, /urllib3 2\.8\.0/);
    assert.match(result.stdout, /Python 3\.14\.7/);
  });
});

// Shaped like the Windows exe: Python 3.10, websockets 16, its own program
// name in the usage error, and CRLF line ends.
function windowsReport() {
  return [
    ...report().map((line) =>
      line
        .replace("(darwin_exe)", "(win_exe)")
        .replace(/Python 3\.14\.7 .*/, "Python 3.10.11 (CPython AMD64 64bit) - Windows-10-10.0.26100-SP0 (OpenSSL 3.0.15 3 Sep 2024)")
        .replace("websockets-17.2", "websockets-16.1.1"),
    ),
    "",
    "Usage: yt-dlp-x86_64-pc-windows-msvc.exe [OPTIONS] URL [URL...]",
    "",
    "yt-dlp-x86_64-pc-windows-msvc.exe: error: You must provide at least one URL.",
    "Type yt-dlp --help to see a list of all options.",
  ].map((line) => `${line}\r`);
}

test("reads the Windows binary's output", () => {
  withDir((dir) => {
    const result = run(dir, fakeBinary(dir, { stderrLines: windowsReport() }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Python 3\.10\.11, certifi 2026\.10\.19, urllib3 2\.8\.0$/m);
  });
});

test("gives a Windows child only what Python and the PyInstaller unpack need", () => {
  const home = "C:\\Users\\runner\\AppData\\Local\\Temp\\goop-yt-dlp-home-x";
  const env = scrubbedEnv(home, {
    platform: "win32",
    env: { SystemRoot: "D:\\Win", GITHUB_TOKEN: "secret", GOOP_LEAK_PROBE: "leaked", PATH: "C:\\tools" },
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "APPDATA", "HOME", "LOCALAPPDATA", "PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR",
    "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  ]);
  assert.equal(env.SystemRoot, "D:\\Win");
  assert.equal(env.PATH, "D:\\Win\\System32;D:\\Win");
  for (const name of ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR"]) assert.equal(env[name], home, name);
  assert.equal(scrubbedEnv(home, { platform: "win32", env: {} }).SystemRoot, "C:\\Windows");
});

test("gives a POSIX child a throwaway home and the system PATH only", () => {
  const env = scrubbedEnv("/tmp/goop-yt-dlp-home-x", { platform: "darwin", env: { GITHUB_TOKEN: "secret" } });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]);
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.TMPDIR, "/tmp/goop-yt-dlp-home-x");
});

test("compares versions numerically, not as text", () => {
  withDir((dir) => {
    const bin = fakeBinary(dir, { stderrLines: [...report({ certifi: "2027.01.05", urllib3: "2.10.0" }), ...NO_URL] });
    const result = run(dir, bin);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /urllib3 2\.10\.0/);
  });
});

test("treats missing version parts as zero", async (t) => {
  for (const [name, overrides, status] of [
    ["a two-part version at the floor", { urllib3: "2.8" }, 0],
    ["a four-part version above the floor", { urllib3: "2.8.0.1" }, 0],
    ["a four-part version below the floor", { certifi: "2026.10.18.9" }, 1],
  ]) {
    await t.test(name, () => {
      withDir((dir) => {
        const result = run(dir, fakeBinary(dir, { stderrLines: [...report(overrides), ...NO_URL] }));
        assert.equal(result.status, status, result.stderr);
      });
    });
  }
});

test("refuses the certifi and urllib3 that yt-dlp 2026.08.19 shipped", () => {
  withDir((dir) => {
    const bin = fakeBinary(dir, { stderrLines: [...report({ certifi: "2026.07.22", urllib3: "2.7.0" }), ...NO_URL] });
    const result = run(dir, bin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::certifi 2026\.07\.22 is below the 2026\.10\.19 floor/);
    assert.match(result.stderr, /::error::urllib3 2\.7\.0 is below the 2\.8\.0 floor/);
  });
});

test("refuses each library one step below its floor", async (t) => {
  for (const [name, overrides, message] of [
    ["certifi", { certifi: "2026.10.18" }, /::error::certifi 2026\.10\.18 is below/],
    ["urllib3", { urllib3: "2.7.9" }, /::error::urllib3 2\.7\.9 is below/],
  ]) {
    await t.test(name, () => {
      withDir((dir) => {
        const result = run(dir, fakeBinary(dir, { stderrLines: [...report(overrides), ...NO_URL] }));
        assert.equal(result.status, 1);
        assert.match(result.stderr, message);
      });
    });
  }
});

test("fails closed when a floored library is absent, unversioned or unparseable", async (t) => {
  for (const [name, overrides, message] of [
    ["no certifi", { certifi: undefined }, /::error::.*did not report certifi/],
    ["no urllib3", { urllib3: undefined }, /::error::.*did not report urllib3/],
    ["certifi without a version", { certifi: "" }, /::error::.*certifi.*no version/],
    ["pre-release urllib3", { urllib3: "2.9.0rc1" }, /::error::.*urllib3 version "2\.9\.0rc1"/],
  ]) {
    await t.test(name, () => {
      withDir((dir) => {
        const result = run(dir, fakeBinary(dir, { stderrLines: [...report(overrides), ...NO_URL] }));
        assert.equal(result.status, 1);
        assert.match(result.stderr, message);
      });
    });
  }
});

test("refuses a binary that is not the pinned yt-dlp release", () => {
  withDir((dir) => {
    const bin = fakeBinary(dir, { stderrLines: [...report({ version: "stable@2026.08.19" }), ...NO_URL] });
    const result = run(dir, bin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::yt-dlp 2026\.08\.19 is not the pinned 2026\.10\.21/);
  });
});

test("fails closed when a debug line is missing or repeated", async (t) => {
  const without = (needle) => [...report().filter((line) => !line.includes(needle)), ...NO_URL];
  for (const [name, stderrLines, message] of [
    ["missing version line", without("yt-dlp version"), /::error::.*"yt-dlp version/],
    ["missing libraries line", without("Optional libraries"), /::error::.*"Optional libraries/],
    ["repeated libraries line", [...report(), `[debug] Optional libraries: ${libraries({ certifi: "2026.07.22", urllib3: "2.7.0" })}`, ...NO_URL], /::error::.*more than once/],
    [
      "a library listed twice",
      report().map((line) => line.replace("certifi-2026.10.19", "certifi-2026.07.22, certifi-2026.10.19")).concat(NO_URL),
      /::error::.*certifi more than once/,
    ],
    [
      "an unparseable version line",
      report().map((line) => line.replace("yt-dlp version stable@", "yt-dlp version  stable@")).concat(NO_URL),
      /::error::unrecognised "yt-dlp version" line/,
    ],
    ["no debug output at all", NO_URL, /::error::yt-dlp did not report a "yt-dlp version/],
  ]) {
    await t.test(name, () => {
      withDir((dir) => {
        const result = run(dir, fakeBinary(dir, { stderrLines }));
        assert.equal(result.status, 1);
        assert.match(result.stderr, message);
      });
    });
  }
});

test("fails unless yt-dlp ends on its no-URL usage error", async (t) => {
  for (const [name, options] of [
    ["exit 0", { exitCode: 0 }],
    ["exit 1 (an uncaught Python error)", { exitCode: 1 }],
    ["exit 2 without the usage error", { stderrLines: report() }],
  ]) {
    await t.test(name, () => {
      withDir((dir) => {
        const result = run(dir, fakeBinary(dir, options));
        assert.equal(result.status, 1);
        assert.match(result.stderr, /::error::.*(?:exited with status|no-URL usage error)/);
      });
    });
  }
});

test("the binary's own output cannot issue workflow commands", () => {
  withDir((dir) => {
    const forged = ["::warning::forged annotation", "::add-mask::2026.10.19"];
    const result = run(dir, fakeBinary(dir, { stderrLines: [...report(), ...forged], exitCode: 1 }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^::error::yt-dlp exited with status 1/m);
    assert.doesNotMatch(result.stderr, /^::(?:warning|add-mask)::/m);
    assert.match(result.stderr, /forged annotation/, "the output is still shown, just not as a command");
  });
});

test("fails when the binary hangs past the timeout", () => {
  withDir((dir) => {
    const started = Date.now();
    const result = run(dir, fakeBinary(dir, { hang: true }), ["--timeout-ms", "300"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::.*timed out/i);
    assert.ok(Date.now() - started < 8000, "the checker must not wait for the hung binary");
  });
});

test("takes the expected yt-dlp version from the fetch script", () => {
  withDir((dir) => {
    const bin = fakeBinary(dir, { stderrLines: [...report({ version: "stable@2031.02.03" }), ...NO_URL] });
    const result = check(["--binary", bin.path, "--fetch-script", pins(dir, 'YT_DLP_VERSION="2031.02.03"\n')]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2031\.02\.03/);
  });
});

test("refuses a fetch script that does not pin yt-dlp exactly once", async (t) => {
  for (const [name, text] of [
    ["no pin", 'GALLERY_DL_VERSION="v1.32.11"\n'],
    ["two pins", 'YT_DLP_VERSION="2026.10.21"\nYT_DLP_VERSION="2026.08.19"\n'],
  ]) {
    await t.test(name, () => {
      withDir((dir) => {
        const result = check(["--binary", fakeBinary(dir).path, "--fetch-script", pins(dir, text)]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /::error::.*YT_DLP_VERSION exactly once/);
      });
    });
  }
});

test("runs with no user config, no plugins, no URL, an isolated home and a scrubbed environment", () => {
  withDir((dir) => {
    const bin = fakeBinary(dir);
    const result = check(["--binary", bin.path, "--fetch-script", pins(dir)], { GOOP_LEAK_PROBE: "leaked" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      readFileSync(`${bin.record}.args`, "utf8").trim().split("\n"),
      ["--ignore-config", "--no-plugin-dirs", "-v"],
    );
    const isolatedHome = readFileSync(`${bin.record}.home`, "utf8");
    assert.notEqual(isolatedHome, "");
    assert.notEqual(isolatedHome, homedir());
    assert.equal(
      readFileSync(`${bin.record}.cwd`, "utf8").trim(),
      join(realpathSync(dirname(isolatedHome)), basename(isolatedHome)),
      "the binary runs in the isolated home, not the checkout, so no yt-dlp.conf or plugin there is in reach",
    );
    assert.equal(existsSync(isolatedHome), false, "the isolated home must be removed after the run");
    assert.equal(readFileSync(`${bin.record}.leak`, "utf8"), "unset");
  });
});

test("resolves a relative --binary against the caller's directory, as audit.yml passes it", () => {
  withDir((dir) => {
    fakeBinary(dir);
    const result = spawnSync(process.execPath, [checker, "--binary", "./yt-dlp", "--fetch-script", pins(dir)], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("reports usage errors and a missing binary distinctly", async (t) => {
  for (const [name, args, message] of [
    ["missing --binary", [], /--binary/],
    ["zero --timeout-ms", ["--timeout-ms", "0"], /--timeout-ms/],
    ["a URL passed through", ["https://example.test/watch"], /Unexpected argument/],
  ]) {
    await t.test(name, () => {
      withDir((dir) => {
        const binary = name === "missing --binary" ? [] : ["--binary", fakeBinary(dir).path];
        const result = check([...binary, "--fetch-script", pins(dir), ...args]);
        assert.equal(result.status, 2);
        assert.match(result.stderr, message);
      });
    });
  }
  await t.test("binary does not exist", () => {
    withDir((dir) => {
      const result = check(["--binary", join(dir, "absent"), "--fetch-script", pins(dir)]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /::error::.*absent/);
    });
  });
});

test("the default fetch script is scripts/fetch-sidecars.sh and its pin is what a binary must report", () => {
  const pinned = readFileSync(fetchScript, "utf8").match(/^YT_DLP_VERSION="([^"]+)"$/m)?.[1];
  assert.ok(pinned, "fetch-sidecars.sh must pin YT_DLP_VERSION");
  withDir((dir) => {
    const bin = fakeBinary(dir, { stderrLines: [...report({ version: `stable@${pinned}` }), ...NO_URL] });
    const result = check(["--binary", bin.path]);
    assert.equal(result.status, 0, result.stderr);
  });
});
