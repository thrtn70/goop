import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Homebrew's tesseract bottles are linked for the macOS of the machine that
// built them (14.8.5 for 5.5.3 on Sonoma), so scripts/build-tesseract-macos.sh
// builds tesseract and libtesseract.5.dylib from source for the floor
// tauri.conf.json declares, and fetch-sidecars.sh bundles that build. These
// tests cover the script's refusal, reuse and rebuild decisions and the way
// fetch-sidecars.sh wires the build in.
const buildScriptPath = new URL("./build-tesseract-macos.sh", import.meta.url);
const buildScript = readFileSync(buildScriptPath, "utf8");
const fetchSidecars = readFileSync(new URL("./fetch-sidecars.sh", import.meta.url), "utf8");
const declaredFloor = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"))
  .bundle.macOS.minimumSystemVersion;
const pinnedVersion = buildScript.match(/^TESSERACT_VERSION="([^"]+)"$/m)?.[1];
const pinnedSha = buildScript.match(/^TESSERACT_SHA256="([0-9a-f]{64})"$/m)?.[1];
const scriptSha = createHash("sha256").update(readFileSync(buildScriptPath)).digest("hex");
const leptonica = "leptonica 1.87.0";
const libarchive = "libarchive 3.8.9";

// Hooks run with GIT_DIR and friends set; a scratch repo must not inherit them.
function envWithoutGit(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return { ...env, ...extra };
}

function stubCommand(root, name, script) {
  writeFileSync(join(root, "stub", name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(root, "stub", name), 0o755);
}

// A scratch repo holding the build script, its helpers and the given
// tauri.conf.json. `curl` logs and fails, so any download shows up in
// `downloaded` and nothing reaches the network. `brew` answers for the two
// formulas tesseract links against.
function populateRepo(root, config, { brewLeptonica = leptonica } = {}) {
  for (const directory of ["scripts", "src-tauri", "stub"]) mkdirSync(join(root, directory));
  for (const name of ["build-tesseract-macos.sh", "fetch-with-retry.sh", "macos-deployment-target.mjs"]) {
    copyFileSync(new URL(`./${name}`, import.meta.url), join(root, "scripts", name));
  }
  writeFileSync(join(root, "src-tauri", "tauri.conf.json"), JSON.stringify(config));
  stubCommand(root, "curl", `echo "$*" >> '${join(root, "curl.log")}'\nexit 22`);
  stubCommand(
    root,
    "brew",
    [
      'case "$1 $2 $3" in',
      `  "list --versions leptonica") echo "${brewLeptonica}" ;;`,
      `  "list --versions libarchive") echo "${libarchive}" ;;`,
      '  "--prefix leptonica ") echo /opt/homebrew/opt/leptonica ;;',
      '  "--prefix libarchive ") echo /opt/homebrew/opt/libarchive ;;',
      '  *) echo "brew stub: unexpected $*" >&2; exit 1 ;;',
      "esac",
    ].join("\n"),
  );
  const init = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8", env: envWithoutGit() });
  assert.equal(init.status, 0, init.stderr);
}

function runBuild(root, args = []) {
  const result = spawnSync("bash", ["scripts/build-tesseract-macos.sh", ...args], {
    cwd: root,
    encoding: "utf8",
    env: envWithoutGit({ PATH: `${join(root, "stub")}:${process.env.PATH}` }),
  });
  return { status: result.status, log: result.stdout + result.stderr, downloaded: existsSync(join(root, "curl.log")) };
}

function withRepo(config, body, options) {
  // Resolved, as `git rev-parse --show-toplevel` resolves it: /var is a
  // symlink on macOS, and the prefix path is compared byte for byte.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "goop-tesseract-")));
  try {
    populateRepo(root, config, options);
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const declaring = (floor) => ({ bundle: { macOS: { minimumSystemVersion: floor } } });

// What the script records about a build it made, one fact per line.
function buildInfo({ floor = declaredFloor, lept = leptonica } = {}) {
  return [`tesseract ${pinnedVersion} ${pinnedSha}`, `macos ${floor}`, lept, libarchive, `script ${scriptSha}`].join("\n") + "\n";
}

// A prefix shaped like a finished build: a real libtesseract.5.dylib with the
// install name and versions libtool gives it, and a tesseract linked to it.
function populatePrefix(root, { libMinos = declaredFloor, exeMinos = declaredFloor, info = buildInfo(), loads } = {}) {
  const prefix = join(root, ".tesseract-deps");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(join(prefix, "lib"), { recursive: true });
  const lib = join(prefix, "lib", "libtesseract.5.dylib");
  const installName = loads ?? lib;
  writeFileSync(join(root, "lib.c"), "int TessVersionProbe(void) { return 5; }\n");
  writeFileSync(join(root, "main.c"), "int TessVersionProbe(void);\nint main(void) { return TessVersionProbe() - 5; }\n");
  const clang = (args) => {
    const run = spawnSync("clang", args, { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  };
  clang([
    "-dynamiclib",
    `-mmacosx-version-min=${libMinos}`,
    "-install_name",
    installName,
    "-compatibility_version",
    "6.0.0",
    "-current_version",
    "6.5.0",
    "lib.c",
    "-o",
    lib,
  ]);
  clang([`-mmacosx-version-min=${exeMinos}`, "main.c", lib, "-o", join(prefix, "bin", "tesseract")]);
  if (info !== null) writeFileSync(join(prefix, "BUILD-INFO"), info);
  return prefix;
}

const needsMacTools = process.platform === "darwin" ? {} : { skip: "builds real Mach-O fixtures with clang and reads them with otool" };

test("the tesseract source pin is the version fetch-sidecars.sh holds Homebrew's gs to", () => {
  assert.match(pinnedVersion ?? "", /^\d+\.\d+\.\d+$/, "TESSERACT_VERSION");
  assert.ok(pinnedSha, "TESSERACT_SHA256 must be a 64-digit hex digest");
  const homebrew = fetchSidecars.match(/^MACOS_TESSERACT_VERSION="([^"]+)"$/m)?.[1];
  assert.equal(pinnedVersion, homebrew, "gs links Homebrew's libtesseract and loads this build's in its place");
  assert.match(buildScript, /^TESSERACT_URL="https:\/\/github\.com\/tesseract-ocr\/tesseract\/archive\/refs\/tags\/\$\{TESSERACT_VERSION\}\.tar\.gz"$/m);
});

test("the tesseract build stops before it downloads or reuses anything when no floor is declared", () => {
  for (const config of [{ version: "0.3.6" }, declaring("")]) {
    withRepo(config, (root) => {
      const run = runBuild(root);
      assert.notEqual(run.status, 0, run.log);
      assert.match(run.log, /bundle\.macOS\.minimumSystemVersion/);
      assert.equal(run.downloaded, false, run.log);
      assert.equal(existsSync(join(root, ".tesseract-deps")), false);
    });
  }
  withRepo(declaring(declaredFloor), (root) => {
    writeFileSync(join(root, "scripts", "macos-deployment-target.mjs"), "// prints nothing, exits 0\n");
    const run = runBuild(root);
    assert.notEqual(run.status, 0, run.log);
    assert.match(run.log, /macOS floor/);
    assert.equal(run.downloaded, false, run.log);
  });
});

test("the tesseract build runs on macOS only", () => {
  withRepo(declaring(declaredFloor), (root) => {
    stubCommand(root, "uname", 'echo Linux');
    for (const args of [[], ["--check"]]) {
      const run = runBuild(root, args);
      assert.notEqual(run.status, 0, run.log);
      assert.match(run.log, /macOS only/);
      assert.equal(run.downloaded, false, run.log);
    }
  });
});

test("the tesseract build rejects arguments it does not know", () => {
  withRepo(declaring(declaredFloor), (root) => {
    const run = runBuild(root, ["--force"]);
    assert.notEqual(run.status, 0, run.log);
    assert.match(run.log, /usage/i);
    assert.equal(run.downloaded, false, run.log);
  });
});

test("a tesseract build for the floor against the installed libraries is reused", needsMacTools, () => {
  withRepo(declaring(declaredFloor), (root) => {
    populatePrefix(root);
    const check = runBuild(root, ["--check"]);
    assert.equal(check.status, 0, check.log);
    const run = runBuild(root);
    assert.equal(run.status, 0, run.log);
    assert.match(run.log, /already present/);
    assert.equal(run.downloaded, false, run.log);
  });
});

test("a tesseract build that is not the one this checkout would make is rebuilt", needsMacTools, async (t) => {
  const newer = `${Number(declaredFloor.split(".")[0]) + 1}.0`;
  const older = "13.0";
  const stale = (name, prefixOptions, pattern, repoOptions) =>
    t.test(name, () => {
      withRepo(
        declaring(declaredFloor),
        (root) => {
          const prefix = populatePrefix(root, prefixOptions);
          const check = runBuild(root, ["--check"]);
          assert.equal(check.status, 1, check.log);
          assert.match(check.log, pattern);
          assert.equal(check.downloaded, false, "--check never downloads");
          const run = runBuild(root);
          assert.doesNotMatch(run.log, /already present/);
          assert.match(run.log, pattern);
          assert.equal(run.downloaded, true, run.log);
          // The stub download fails, so the rebuild stops there, and a failed
          // download must not cost the developer the build they already had.
          assert.notEqual(run.status, 0, run.log);
          assert.equal(existsSync(join(prefix, "lib", "libtesseract.5.dylib")), true);
        },
        repoOptions,
      );
    });
  const minos = (version) => new RegExp(`minos ${version.replace(".", "\\.")}`);
  await stale(`libtesseract built for macOS ${newer}`, { libMinos: newer }, minos(newer));
  await stale(`tesseract built for macOS ${newer}`, { exeMinos: newer }, minos(newer));
  await stale(`tesseract built for macOS ${older}`, { exeMinos: older }, minos(older));
  await stale("built for another floor", { info: buildInfo({ floor: "13.3" }) }, /BUILD-INFO/);
  await stale("built against another leptonica", {}, /BUILD-INFO/, { brewLeptonica: "leptonica 1.88.0" });
  await stale("no record of what it was built for", { info: null }, /BUILD-INFO: missing/);
  await stale(
    "tesseract loads a libtesseract outside the prefix",
    { loads: "/opt/homebrew/opt/tesseract/lib/libtesseract.5.dylib" },
    /does not load .*\.tesseract-deps\/lib\/libtesseract\.5\.dylib/,
  );
});

test("otool that cannot run fails the tesseract build and keeps the prefix", needsMacTools, () => {
  withRepo(declaring(declaredFloor), (root) => {
    const prefix = populatePrefix(root);
    stubCommand(root, "otool", "echo 'otool: unusable toolchain' >&2\nexit 69");
    const run = runBuild(root);
    assert.notEqual(run.status, 0, run.log);
    assert.match(run.log, /otool/);
    assert.doesNotMatch(run.log, /already present/);
    assert.equal(run.downloaded, false, run.log);
    assert.equal(existsSync(join(prefix, "bin", "tesseract")), true);
  });
});

test("the old tesseract build is discarded only once the source is verified and the tools are found", () => {
  const discard = buildScript.indexOf('\nrm -rf "${PREFIX}"\n');
  assert.notEqual(discard, -1);
  const fetched = buildScript.indexOf('fetch_verified "${TESSERACT_URL}" "${TESSERACT_SHA256}"');
  assert.ok(fetched !== -1 && fetched < discard, "the source is fetched and verified first");
  for (const tool of ["autoconf", "automake", "pkg-config"]) {
    assert.match(buildScript.slice(0, discard), new RegExp(`\\b${tool}\\b`), `${tool} is looked for first`);
  }
  assert.ok(discard < buildScript.indexOf("./autogen.sh"), "nothing is configured before the discard");
});

test("tesseract is built the way Homebrew builds it, for the floor, and checked after it is built", () => {
  // MACOSX_DEPLOYMENT_TARGET reaches every compile and the libtool link, which
  // decides the minos; a flag in CFLAGS alone does not reach the link.
  assert.match(buildScript, /^export MACOSX_DEPLOYMENT_TARGET="\$\{MACOS_FLOOR\}"$/m);
  const configure = buildScript.match(/^\.\/configure [\s\S]*?>\/dev\/null$/m)?.[0];
  assert.ok(configure, "missing the configure call");
  // Homebrew's own data path, so the binary falls back exactly as the
  // Homebrew one did; Goop always passes --tessdata-dir anyway.
  assert.match(configure, /--datarootdir=\/opt\/homebrew\/share/);
  for (const off of ["--disable-legacy", "--without-archive", "--without-curl"]) {
    assert.doesNotMatch(configure, new RegExp(off), `${off}: gs was built against a libtesseract with it on`);
  }
  const install = buildScript.lastIndexOf("make install");
  assert.notEqual(install, -1);
  const after = buildScript.slice(install);
  assert.match(after, /stale="\$\(stale_report\)"/, "the finished build is checked like a reused one");
  assert.match(after, /--version/, "the finished build must report the pinned version");
});

test("fetch-sidecars.sh bundles this tesseract build, before gs, and holds both copies to the floor", () => {
  const at = (needle) => {
    const index = fetchSidecars.indexOf(needle);
    assert.notEqual(index, -1, `missing ${needle}`);
    return index;
  };
  const build = at('/scripts/build-tesseract-macos.sh"');
  const copy = at('cp "$TESS_PREFIX/bin/tesseract" "$OUT_DIR/tesseract-$TARGET"');
  assert.match(fetchSidecars, /^ {4}TESS_PREFIX="\$\(git rev-parse --show-toplevel\)\/\.tesseract-deps"$/m);
  assert.doesNotMatch(fetchSidecars, /^\s*TESS_PREFIX="\$\("\$GS_BREW" --prefix tesseract\)"/m, "never Homebrew's binary");
  // bundle_macos_dylibs keeps the first copy of a basename, so gs, which
  // Homebrew linked against its own libtesseract.5.dylib, loads this one.
  const tesseract = at('bundle_macos_dylibs "$OUT_DIR/tesseract-$TARGET"');
  const gs = at('bundle_macos_dylibs "$OUT_DIR/gs-$TARGET"');
  assert.ok(build < copy && copy < tesseract && tesseract < gs, "tesseract must be built and bundled before gs");
  const floorCheck = at('for f in "$OUT_DIR/tesseract-$TARGET" "$OUT_DIR/libtesseract.5.dylib"; do');
  assert.ok(gs < floorCheck, "the floor is checked once gs has been bundled too");
});

test("the bundled load-command sweep rejects any absolute path outside the system", () => {
  const sweep = fetchSidecars.match(/for f in "\$OUT_DIR\/gs-\$TARGET" "\$OUT_DIR\/tesseract-\$TARGET" "\$OUT_DIR"\/\*\.dylib; do[\s\S]*?\n {4}done\n/)?.[0];
  assert.ok(sweep, "missing the load-command sweep");
  // The build prefix is an absolute path too; a load command left pointing
  // there loads on the build machine and nowhere else.
  assert.match(sweep, /^ {10}\/usr\/lib\/\*\|\/System\/\*\) ;;$/m);
  assert.match(sweep, /^ {10}\/\*\)$/m);
});

test("the tesseract build directory is ignored", () => {
  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^\/\.tesseract-deps$/m);
});
