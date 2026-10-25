import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// libde265 and libheif are linked statically into the app, so their objects
// must target the macOS the app declares. An object built for a newer macOS
// links with only a warning, and the executable's minos then claims a floor
// the code inside it does not keep. These tests cover the floor helper and
// scripts/build-static-heif-deps.sh; release-workflow.test.mjs holds the
// workflows' cache keys to the same floor.
const heifDepsScript = readFileSync(new URL("./build-static-heif-deps.sh", import.meta.url), "utf8");
const declaredFloor = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"))
  .bundle.macOS.minimumSystemVersion;
const floorCli = fileURLToPath(new URL("./macos-deployment-target.mjs", import.meta.url));

// Hooks run with GIT_DIR and friends set; a scratch repo must not inherit them.
function envWithoutGit(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return { ...env, ...extra };
}

// A scratch repo holding the build script, its helpers and the given
// tauri.conf.json. `curl` is a stub that logs and fails, so any download
// shows up in `downloaded` and nothing reaches the network.
function populateHeifDepsRepo(root, config) {
  for (const directory of ["scripts", "src-tauri", "stub"]) mkdirSync(join(root, directory));
  for (const name of ["build-static-heif-deps.sh", "fetch-with-retry.sh", "macos-deployment-target.mjs"]) {
    const source = new URL(`./${name}`, import.meta.url);
    if (existsSync(source)) copyFileSync(source, join(root, "scripts", name));
  }
  writeFileSync(join(root, "src-tauri", "tauri.conf.json"), JSON.stringify(config));
  stubCommand(root, "curl", `echo "$*" >> '${join(root, "curl.log")}'\nexit 22`);
  const init = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8", env: envWithoutGit() });
  assert.equal(init.status, 0, init.stderr);
}

// A stub command for the scratch repo's PATH, shadowing the real one.
function stubCommand(root, name, script) {
  writeFileSync(join(root, "stub", name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(root, "stub", name), 0o755);
}

function runHeifDeps(root) {
  const result = spawnSync("bash", ["scripts/build-static-heif-deps.sh"], {
    cwd: root,
    encoding: "utf8",
    env: envWithoutGit({ PATH: `${join(root, "stub")}:${process.env.PATH}` }),
  });
  return { status: result.status, log: result.stdout + result.stderr, downloaded: existsSync(join(root, "curl.log")) };
}

function withHeifDepsRepo(config, body) {
  const root = mkdtempSync(join(tmpdir(), "goop-heif-deps-"));
  try {
    populateHeifDepsRepo(root, config);
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the macOS deployment target is tauri.conf.json's minimumSystemVersion or nothing", async () => {
  const { deploymentTarget } = await import("./macos-deployment-target.mjs");
  const declaring = (value) => ({ bundle: { macOS: { minimumSystemVersion: value } } });
  assert.equal(deploymentTarget(declaring("13.3")), "13.3");
  assert.equal(deploymentTarget(declaring("10.15.4")), "10.15.4");
  const rejected = [
    null,
    {},
    { bundle: {} },
    { bundle: { macOS: {} } },
    declaring(13.3),
    declaring(""),
    declaring("13"),
    declaring("latest"),
    declaring(" 13.3"),
    declaring("13.3\n-DCMAKE_C_FLAGS=-O0"),
    declaring("13.3;id"),
    declaring("13.3\n"),
  ];
  for (const config of rejected) {
    assert.throws(() => deploymentTarget(config), /bundle\.macOS\.minimumSystemVersion/, JSON.stringify(config));
  }
});

test("the deployment target CLI prints the declared floor and fails closed without one", () => {
  const declared = spawnSync(process.execPath, [floorCli], { encoding: "utf8" });
  assert.equal(declared.status, 0, declared.stderr);
  assert.equal(declared.stdout, `${declaredFloor}\n`);

  const directory = mkdtempSync(join(tmpdir(), "goop-macos-floor-"));
  try {
    const config = join(directory, "tauri.conf.json");
    for (const body of [JSON.stringify({ bundle: { macOS: {} } }), "{ not json"]) {
      writeFileSync(config, body);
      const run = spawnSync(process.execPath, [floorCli, config], { encoding: "utf8" });
      assert.notEqual(run.status, 0, body);
      assert.equal(run.stdout, "", body);
      assert.match(run.stderr, /minimumSystemVersion/, body);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// /tmp and /var are symlinks on macOS, so an absolute path through one is an
// ordinary way to run the helper. It must still run, and still fail closed.
test("the deployment target CLI behaves the same when run through a symlinked directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "goop-macos-floor-link-"));
  try {
    mkdirSync(join(directory, "real"));
    copyFileSync(floorCli, join(directory, "real", "macos-deployment-target.mjs"));
    symlinkSync(join(directory, "real"), join(directory, "link"));
    const cli = join(directory, "link", "macos-deployment-target.mjs");
    const config = join(directory, "tauri.conf.json");
    writeFileSync(config, JSON.stringify({ bundle: { macOS: { minimumSystemVersion: declaredFloor } } }));
    const declared = spawnSync(process.execPath, [cli, config], { encoding: "utf8" });
    assert.equal(declared.status, 0, declared.stderr);
    assert.equal(declared.stdout, `${declaredFloor}\n`);
    writeFileSync(config, JSON.stringify({ bundle: { macOS: {} } }));
    const missing = spawnSync(process.execPath, [cli, config], { encoding: "utf8" });
    assert.notEqual(missing.status, 0, "a floorless config must not exit 0");
    assert.equal(missing.stdout, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the HEIC stack build stops before it downloads or reuses anything when no floor is declared", () => {
  for (const config of [{ version: "0.3.6" }, { bundle: { macOS: { minimumSystemVersion: "" } } }]) {
    withHeifDepsRepo(config, (root) => {
      const run = runHeifDeps(root);
      assert.notEqual(run.status, 0, run.log);
      assert.match(run.log, /bundle\.macOS\.minimumSystemVersion/);
      assert.equal(run.downloaded, false, run.log);
      assert.equal(existsSync(join(root, ".heif-deps")), false);
    });
    // A stack that is already present must not be waved through either:
    // nothing can say which macOS it was meant for.
    withHeifDepsRepo(config, (root) => {
      const lib = join(root, ".heif-deps", "lib");
      mkdirSync(join(lib, "pkgconfig"), { recursive: true });
      for (const name of ["libde265.a", "libheif.a", "pkgconfig/libheif.pc"]) writeFileSync(join(lib, name), "");
      const run = runHeifDeps(root);
      assert.notEqual(run.status, 0, run.log);
      assert.match(run.log, /bundle\.macOS\.minimumSystemVersion/);
      assert.doesNotMatch(run.log, /already present/);
    });
  }
  // Nor when the helper exits 0 having printed nothing: an empty floor would
  // configure cmake with no target and judge every object stale.
  withHeifDepsRepo({ bundle: { macOS: { minimumSystemVersion: declaredFloor } } }, (root) => {
    writeFileSync(join(root, "scripts", "macos-deployment-target.mjs"), "// prints nothing, exits 0\n");
    const run = runHeifDeps(root);
    assert.notEqual(run.status, 0, run.log);
    assert.match(run.log, /macOS floor/);
    assert.equal(run.downloaded, false, run.log);
  });
});

test("the old HEIC stack is discarded only once both sources are verified and cmake is present", () => {
  const discard = heifDepsScript.indexOf('\nrm -rf "${PREFIX}"\n');
  assert.notEqual(discard, -1);
  const lastFetch = heifDepsScript.lastIndexOf('fetch_verify "${HEIF_URL}"');
  assert.ok(heifDepsScript.indexOf('fetch_verify "${DE265_URL}"') < discard, "libde265 fetched first");
  assert.ok(lastFetch !== -1 && lastFetch < discard, "libheif fetched first");
  assert.match(heifDepsScript.slice(0, discard), /\ncommand -v cmake >\/dev\/null/);
  assert.ok(discard < heifDepsScript.indexOf("\ncmake -S "), "nothing configured before the discard");
});

test("both HEIC cmake configures target the declared floor and the archives are checked against it", () => {
  const configures = heifDepsScript.match(/^cmake -S [\s\S]*?>\/dev\/null$/gm) ?? [];
  assert.equal(configures.length, 2, "expected the libde265 and libheif configures");
  for (const configure of configures) {
    assert.match(configure, /^ {2}-DCMAKE_OSX_DEPLOYMENT_TARGET="\$\{MACOS_FLOOR\}" \\$/m);
  }
  const lastInstall = heifDepsScript.lastIndexOf('cmake --install "${WORK}/heif-build"');
  assert.notEqual(lastInstall, -1);
  assert.match(heifDepsScript.slice(lastInstall), /\nstale="\$\(floor_report\)" \|\| \{[\s\S]*?\n {2}exit 1\n\}\nif \[ -n "\$\{stale\}" \]; then\n[\s\S]*?\n {2}exit 1\nfi\n/);
});

test("both HEIC builds run one make job per core, never an unbounded make -j", () => {
  // `cmake --build --parallel` with no count runs `make -j`, which starts
  // every compile at once.
  const builds = heifDepsScript.match(/^cmake --build .*$/gm) ?? [];
  assert.equal(builds.length, 2, "expected the libde265 and libheif builds");
  for (const build of builds) assert.match(build, / --parallel "\$\{JOBS\}" /, build);
  assert.match(heifDepsScript, /^JOBS="\$\(build_jobs\)"$/m);
  const definition = heifDepsScript.match(/^build_jobs\(\) \{\n[\s\S]*?\n\}$/m)?.[0];
  assert.ok(definition, "missing build_jobs()");

  const jobsFor = (getconf) => {
    const root = mkdtempSync(join(tmpdir(), "goop-heif-jobs-"));
    try {
      mkdirSync(join(root, "stub"));
      stubCommand(root, "getconf", getconf);
      const run = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", `${definition}\nbuild_jobs`], {
        encoding: "utf8",
        env: envWithoutGit({ PATH: `${join(root, "stub")}:${process.env.PATH}` }),
      });
      assert.equal(run.status, 0, run.stderr);
      return run.stdout;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  // The stub answers only the variable the script must ask for, so a typo
  // in its name falls back to two jobs and fails here.
  const answering = (count) => `[ "$*" = _NPROCESSORS_ONLN ] || exit 2\necho ${count}`;
  assert.equal(jobsFor(answering(3)), "3\n");
  assert.equal(jobsFor(answering(16)), "16\n");
  // Anything but a positive count falls back to two jobs rather than none or
  // an unbounded number.
  for (const broken of ["exit 1", "echo", "echo 0", "echo undefined", "echo '3 4'"]) {
    assert.equal(jobsFor(broken), "2\n", broken);
  }
});

test(
  "a HEIC stack holding objects built for another macOS is rebuilt, not reused",
  { skip: process.platform !== "darwin" && "needs clang, ar and otool" },
  async (t) => {
    const newer = `${Number(declaredFloor.split(".")[0]) + 1}.0`;
    const compile = (root, name, minos) => {
      const source = join(root, `${name}.c`);
      writeFileSync(source, `int goop_${name.replace(/-/g, "_")}(void) { return 0; }\n`);
      const object = join(root, `${name}.o`);
      const run = spawnSync("clang", ["-c", `-mmacosx-version-min=${minos}`, source, "-o", object], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      return object;
    };
    const populate = (root, heifObjects) => {
      const lib = join(root, ".heif-deps", "lib");
      mkdirSync(join(lib, "pkgconfig"), { recursive: true });
      writeFileSync(join(lib, "pkgconfig", "libheif.pc"), "");
      const archive = (name, objects) => {
        const run = spawnSync("ar", ["rcs", join(lib, name), ...objects], { encoding: "utf8" });
        assert.equal(run.status, 0, run.stderr);
      };
      archive("libde265.a", [compile(root, "de265-at-floor", declaredFloor)]);
      archive("libheif.a", heifObjects);
    };
    const config = { bundle: { macOS: { minimumSystemVersion: declaredFloor } } };

    await t.test("every object at the floor: reused without a download", () => {
      withHeifDepsRepo(config, (root) => {
        populate(root, [compile(root, "heif-at-floor", declaredFloor)]);
        const run = runHeifDeps(root);
        assert.equal(run.status, 0, run.log);
        assert.match(run.log, /already present/);
        assert.equal(run.downloaded, false, run.log);
      });
    });

    await t.test(`one object built for macOS ${newer}: the stale stack is discarded and rebuilt`, () => {
      withHeifDepsRepo(config, (root) => {
        populate(root, [compile(root, "heif-at-floor", declaredFloor), compile(root, "heif-newer", newer)]);
        const run = runHeifDeps(root);
        assert.doesNotMatch(run.log, /already present/);
        assert.match(run.log, new RegExp(`libheif\\.a\\(heif-newer\\.o\\): minos ${newer.replace(".", "\\.")}`));
        assert.doesNotMatch(run.log, /heif-at-floor\.o\): minos/);
        assert.equal(run.downloaded, true, run.log);
        // The stub download fails, so the rebuild stops there, and a failed
        // download must not cost the developer the stack they already had.
        assert.notEqual(run.status, 0, run.log);
        assert.equal(existsSync(join(root, ".heif-deps", "lib", "libheif.a")), true);
      });
    });

    await t.test("otool that cannot run: fail, keeping the stack, rather than rebuild with a broken toolchain", () => {
      withHeifDepsRepo(config, (root) => {
        populate(root, [compile(root, "heif-at-floor", declaredFloor)]);
        stubCommand(root, "otool", "echo 'otool: unusable toolchain' >&2\nexit 69");
        const run = runHeifDeps(root);
        assert.notEqual(run.status, 0, run.log);
        assert.match(run.log, /otool/);
        assert.doesNotMatch(run.log, /already present/);
        assert.equal(run.downloaded, false, run.log);
        assert.equal(existsSync(join(root, ".heif-deps", "lib", "libheif.a")), true);
      });
    });
  },
);
