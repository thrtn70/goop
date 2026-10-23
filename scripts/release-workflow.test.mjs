import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const auditWorkflow = readFileSync(new URL("../.github/workflows/audit.yml", import.meta.url), "utf8");
const lines = workflow.split("\n");
const auditLines = auditWorkflow.split("\n");
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const tauriVersion = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).version;
const cargoManifest = readFileSync(new URL("../Cargo.toml", import.meta.url), "utf8");
const cargoVersion = cargoManifest.split("[workspace.package]", 2)[1]?.match(/^version = "([^"]+)"$/m)?.[1];
const galleryDlMacosRequirements = readFileSync(
  new URL("./gallery-dl-macos-requirements.txt", import.meta.url),
  "utf8",
);
const siteScript = readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
const siteHtml = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const windowsHeifInstaller = readFileSync(
  new URL("./install-windows-heif-deps.sh", import.meta.url),
  "utf8",
);
const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(workflowDirectory)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, body: readFileSync(new URL(name, workflowDirectory), "utf8") }));
const checkoutNode24Ref = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const setupNode24Ref = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";

function job(name) {
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z][a-z0-9-]*:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function auditJob(name) {
  const start = auditLines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `missing ${name} audit job`);
  const end = auditLines.findIndex((line, index) => index > start && /^ {2}[a-z][a-z0-9-]*:$/.test(line));
  return auditLines.slice(start, end === -1 ? undefined : end).join("\n");
}

function namedStep(body, name) {
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const match=body.match(new RegExp(` {6}- name: ${escaped}\\n([\\s\\S]*?)(?=\\n {6}- (?:name:|uses:)|$)`));
  assert.ok(match,`missing ${name} step`);
  return match[0];
}

test("both native platforms execute completed video receipt fixtures", () => {
  const smoke = auditJob("sidecar-smoke");
  const receipt = namedStep(smoke, "Video completion receipts (real ffmpeg)");
  assert.match(receipt, /cargo test -p goop-core --test video_attempt/);
  assert.match(receipt, /cargo test -p goop-converter --test video_attempts -- --list/);
  assert.match(receipt, /bundled_ffmpeg_reports_completed_software_encode_and_video_copy/);
  assert.match(receipt, /cargo test -p goop-converter --test video_attempts -- --ignored --test-threads=1/);
});

test("all workflows pin the current Node 24 checkout and setup-node actions", () => {
  let checkoutCount = 0;
  let setupNodeCount = 0;

  for (const { name, body } of workflows) {
    for (const match of body.matchAll(/actions\/checkout@[^\s]+/g)) {
      checkoutCount += 1;
      assert.equal(match[0], checkoutNode24Ref, `${name} has a stale or mutable checkout action`);
    }
    for (const match of body.matchAll(/actions\/setup-node@[^\s]+/g)) {
      setupNodeCount += 1;
      assert.equal(match[0], setupNode24Ref, `${name} has a stale or mutable setup-node action`);
    }
  }

  assert.ok(checkoutCount > 0, "no checkout actions found to validate");
  assert.ok(setupNodeCount > 0, "no setup-node actions found to validate");
});

test("audit runs the PERF-01 synthetic harness smoke on both supported platforms", () => {
  const smoke = auditJob("sidecar-smoke");
  const portable = smoke.match(
    / {6}- name: PERF-01 portable harness tests\n([\s\S]*?)\n {6}- name: PERF-01 harness synthetic smoke/,
  );
  assert.ok(portable, "missing portable PERF-01 harness tests");
  assert.doesNotMatch(portable[0], /^\s*if:/m);
  assert.match(portable[0], /node --test scripts\/performance-portable\.test\.mjs/);
  const step = smoke.match(
    / {6}- name: PERF-01 harness synthetic smoke\n([\s\S]*?)\n {6}- uses: actions\/setup-python/,
  );
  assert.ok(step, "missing portable PERF-01 synthetic smoke before platform-only setup");
  assert.doesNotMatch(step[0], /^\s*if:/m);
  assert.match(step[0], /shell: bash/);
  assert.match(
    step[0],
    /node scripts\/performance-suite\.mjs --synthetic-smoke --output "\$RUNNER_TEMP\/goop-perf-smoke"/,
  );
});

test("audit runs portable PERF-02 contract tests on both supported platforms", () => {
  const smoke = auditJob("sidecar-smoke");
  const step = namedStep(smoke, "PERF-02 portable responsiveness contracts");
  assert.doesNotMatch(step, /^\s*if:/m);
  assert.match(step, /shell: bash/);
  assert.match(step, /node --test scripts\/responsiveness-baseline\.test\.mjs/);
});

test("Linux audit compiles and tests PERF-01 drivers without executing unavailable sidecars", () => {
  const rust = auditJob("rust");
  assert.match(rust, /cargo test -p goop-converter --example performance_workload --all-features/);
  assert.doesNotMatch(
    rust,
    /scripts\/performance-suite\.mjs --rust-contract-smoke/,
    "Linux bootstrap sidecars are intentional availability stubs; real runtime-sidecar execution belongs to the macOS/Windows matrix",
  );
});

test("hosted PERF-01 contract stages exact runtime sidecar names on macOS and Windows", () => {
  const smoke = auditJob("sidecar-smoke");
  assert.match(smoke,/os: \[macos-14, windows-latest\]/);
  const step=namedStep(smoke,"PERF-01 exact runtime-sidecar contract");
  assert.doesNotMatch(step,/^\s*if:/m);
  assert.match(step, /cargo build -p goop-converter --example performance_baseline --example performance_workload --all-features/);
  assert.match(step, /RUNTIME_FFMPEG="ffmpeg\$\{RUNTIME_EXT\}"/);
  assert.match(
    step,
    /PATH="\$POISON_PATH:\$PATH" "\$NODE_BINARY" scripts\/performance-suite\.mjs --rust-contract-smoke/,
    "the hosted smoke must keep Windows cleanup tools reachable while measured children receive the runtime-only PATH",
  );
  assert.match(step, /RUNTIME_FFPROBE="ffprobe\$\{RUNTIME_EXT\}"/);
  assert.match(step, /SINGLE_DRIVER="target\/debug\/examples\/performance_baseline\$\{RUNTIME_EXT\}"/);
  assert.match(step, /WORKLOAD_DRIVER="target\/debug\/examples\/performance_workload\$\{RUNTIME_EXT\}"/);
  assert.match(step, /POISON_PATH=/);
  assert.match(step, /--single-driver "\$SINGLE_DRIVER"/);
  assert.match(step, /--workload-driver "\$WORKLOAD_DRIVER"/);
  assert.match(step, /--runtime-sidecars "\$RUNNER_TEMP\/goop-runtime-sidecars"/);
});

test("release builds run read-only and without persisted checkout credentials", () => {
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(workflow, /^permissions:\n {2}contents: write$/m);
  for (const name of ["validate", "legal", "build"]) {
    const body = job(name);
    assert.doesNotMatch(body, /contents: write/);
    if (body.includes("actions/checkout@")) assert.match(body, /persist-credentials: false/);
  }

  const build = job("build");
  assert.match(build, /tauri-apps\/tauri-action@[0-9a-f]{40}/);
  assert.doesNotMatch(build, /GITHUB_TOKEN|releaseId:|tagName:/);
});

test("only the no-build publish job can write release state", () => {
  const publish = job("publish");
  assert.match(publish, /permissions:\n {6}contents: write/);
  assert.match(publish, /needs: \[validate, legal, build\]/);
  assert.match(publish, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.doesNotMatch(publish, /actions\/checkout|npm |cargo |rust-toolchain|tauri-action|fetch-sidecars|\.\/scripts\//);
  assert.match(publish, /draft: true/);
  assert.doesNotMatch(publish, /draft: false/);
});

// The repository's default workflow token can write, and main has no branch
// protection, so a workflow that names no permissions inherits a token that
// can push to main. Audit compiles freshly resolved crates (Cargo.lock is not
// committed), so any build script it runs could read a token left behind.
// YAML allows blank lines and comments inside the block, so read past them
// rather than stopping early and missing a scope added after one.
function topLevelPermissions(body) {
  const block = body.match(/^permissions:[ \t]*\n((?:(?:[ \t]+.*|#.*)?\n)*)/m)?.[1];
  return block?.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

// Every checkout `uses:` line, counted from the raw text so that a step the
// parser below misreads still counts against it.
function checkoutUses(body) {
  return body.match(/\buses:\s*["']?actions\/checkout@/g)?.length ?? 0;
}

function checkoutSteps(body) {
  return steps(body).filter((step) => /^ {6}- uses: actions\/checkout@|^ {8}uses: actions\/checkout@/m.test(step));
}

test("every workflow declares its own token permissions", () => {
  for (const { name, body } of workflows) {
    assert.ok(/^permissions:/m.test(body), `${name} inherits the repository's default token`);
  }
  const pages = workflows.find(({ name }) => name === "pages.yml");
  assert.deepEqual(topLevelPermissions(pages.body), ["contents: read", "pages: write", "id-token: write"]);
});

test("audit runs with a read-only token", () => {
  assert.deepEqual(topLevelPermissions(auditWorkflow), ["contents: read"]);
  assert.doesNotMatch(auditWorkflow, /^ +permissions:/m, "no audit job may widen the token");
});

test("no workflow leaves its token in the checkout's git config", () => {
  let checked = 0;
  for (const { name, body } of workflows) {
    const checkouts = checkoutSteps(body);
    assert.equal(checkouts.length, checkoutUses(body), `${name}: a checkout step the parser missed`);
    for (const step of checkouts) {
      // Deliberately exact: block-style `with:`, the form release.yml uses.
      assert.match(step, /^ {8}with:\n(?: {10}.*\n)*? {10}persist-credentials: false$/m, `${name}:\n${step}`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "no checkout steps found to validate");
});

test("every workflow pins each action to a full commit SHA", () => {
  let pinned = 0;
  for (const { name, body } of workflows) {
    const refs = [...body.matchAll(/^[ -]*uses: (\S+)$/gm)].map((match) => match[1]);
    assert.equal(refs.length, body.match(/\buses:/g)?.length ?? 0, `${name}: a uses: line the parser missed (the ref must end the line)`);
    for (const ref of refs) {
      if (ref.startsWith("./")) continue;
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${name} uses ${ref} by a mutable ref`);
      pinned += 1;
    }
  }
  assert.ok(pinned > 0, "no actions found to validate");
});

test("the macOS arm64 build stages one immutable workflow artifact before publication", () => {
  const build = job("build");
  assert.match(build, /os: macos-14/);
  assert.match(build, /target: aarch64-apple-darwin/);
  assert.match(build, /bundle: "app,dmg"/);
  assert.doesNotMatch(build, /windows-latest|x86_64-pc-windows-msvc|nsis|msi/);
  assert.match(build, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(build, /name: release-assets-\$\{\{ matrix\.target \}\}/);
  assert.match(build, /if-no-files-found: error/);
  assert.match(build, /overwrite: true/);
  const publish = job("publish");
  assert.equal((publish.match(/actions\/download-artifact@/g) ?? []).length, 1);
  assert.match(publish, /name: release-assets-aarch64-apple-darwin/);
  assert.doesNotMatch(publish, /release-assets-x86_64-pc-windows-msvc|release-input\/windows/);
  assert.match(workflow, /group: release-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("the macOS release keeps version, licensing, entitlement, and in-bundle smoke gates", () => {
  const validate = job("validate");
  assert.match(validate, /Release version matches every manifest/);
  assert.match(validate, /package\.json/);
  assert.match(validate, /src-tauri\/tauri\.conf\.json/);
  assert.match(validate, /Cargo\.toml \[workspace\.package\]/);

  const legal = job("legal");
  assert.match(legal, /Rust dep graph clear of mupdf-\*/);
  assert.match(legal, /Frontend free of mupdf\.js \/ mupdf\.wasm imports/);

  const build = job("build");
  assert.match(build, /\.\/scripts\/fetch-sidecars\.sh "\$\{\{ matrix\.target \}\}"/);
  assert.match(build, /Verify macOS entitlements file is present/);
  assert.match(build, /Verify signed sidecars run \(macOS\)/);
  assert.match(build, /for bin in gallery-dl yt-dlp tesseract gs ffmpeg ffprobe mutool/);
  assert.match(build, /Contents\/Resources\/gs-resources/);
  assert.match(build, /GS_LIB="\$GSRES"/);
});

test("the macOS gallery-dl recipe excludes vulnerable urllib3 releases", () => {
  const lines = galleryDlMacosRequirements.split("\n");
  const urllib3Lines = lines.filter((line) => line.startsWith("urllib3=="));
  assert.equal(urllib3Lines.length, 1, "expected exactly one urllib3 pin");

  const pin = /^urllib3==(\d+)\.(\d+)\.(\d+) \\$/.exec(urllib3Lines[0]);
  assert.ok(pin, "urllib3 must use a stable numeric pin with one hash stanza");
  const pinIndex = lines.indexOf(urllib3Lines[0]);
  assert.match(lines[pinIndex + 1], /^ {4}--hash=sha256:[0-9a-f]{64}$/);

  const major = Number(pin[1]);
  const minor = Number(pin[2]);
  assert.ok(major > 2 || (major === 2 && minor >= 8), "urllib3 must be at least 2.8.0");
});

// A source pin is not proof the frozen binary contains it. These checks run
// the built gallery-dl and compare what it reports against the recipe.
const galleryRuntimeCheck =
  /node scripts\/check-gallery-dl-runtime\.mjs --binary "([^"]+)" --python "\$GALLERY_DL_PYTHON"/;

function setupPythonStep(body) {
  const match = body.match(/ {6}- uses: actions\/setup-python@[0-9a-f]{40}\n((?: {8}.*\n)+)/);
  assert.ok(match, "missing setup-python step");
  return match[0];
}

test("audit proves the frozen gallery-dl runtime against the recipe pins on macOS", () => {
  const smoke = auditJob("sidecar-smoke");
  const python = setupPythonStep(smoke);
  assert.match(python, /^ {8}id: python$/m);
  assert.match(python, /python-version: "3\.14\.6"/);

  const step = namedStep(smoke, "gallery-dl runtime matches the recipe (macOS)");
  assert.match(step, /^ {8}if: matrix\.os == 'macos-14'$/m);
  assert.match(step, /^ {10}GALLERY_DL_PYTHON: \$\{\{ steps\.python\.outputs\.python-version \}\}$/m);
  assert.equal(step.match(galleryRuntimeCheck)?.[1], "./src-tauri/bin/gallery-dl-$TARGET");
  assert.ok(
    smoke.indexOf("- name: Fetch sidecars") < smoke.indexOf("- name: gallery-dl runtime matches the recipe (macOS)"),
    "the runtime check must run on the freshly frozen binary",
  );
});

test("the signed in-bundle gallery-dl must report the recipe's runtime before assets are staged", () => {
  const build = job("build");
  const python = setupPythonStep(build);
  assert.match(python, /^ {8}id: python$/m);

  const verify = namedStep(build, "Verify signed sidecars run (macOS)");
  assert.match(verify, /^ {10}GALLERY_DL_PYTHON: \$\{\{ steps\.python\.outputs\.python-version \}\}$/m);
  assert.equal(verify.match(galleryRuntimeCheck)?.[1], "$APP/Contents/MacOS/gallery-dl");
  assert.ok(
    build.indexOf("- name: Verify signed sidecars run (macOS)") < build.indexOf("- name: Stage release assets"),
    "assets must not be staged before the in-bundle runtime check",
  );
});

test("both quality gates run the gallery-dl runtime checker tests", () => {
  const prePush = readFileSync(new URL("./pre-push.sh", import.meta.url), "utf8");
  assert.match(prePush, /node --test scripts\/check-gallery-dl-runtime\.test\.mjs/);
  assert.match(auditJob("web"), /- run: node --test scripts\/check-gallery-dl-runtime\.test\.mjs/);
});

test("a manual rehearsal builds the signed package but can never publish", () => {
  const triggers = workflow.split("\npermissions:", 1)[0];
  assert.match(triggers, /^on:\n {2}push:\n {4}tags: \["v\*"\]\n(?: {2}#.*\n)* {2}workflow_dispatch:$/m);
  assert.doesNotMatch(triggers, /pull_request|schedule|workflow_run|repository_dispatch/);

  // A dispatch can target a tag ref, where github.ref_type is also 'tag', so
  // the ref type alone does not tell a rehearsal from a tag push.
  const publish = job("publish");
  assert.match(publish, /^ {4}if: github\.event_name == 'push' && github\.ref_type == 'tag'$/m);
  for (const name of ["validate", "legal", "build"]) {
    assert.doesNotMatch(job(name), /^ {4}if:/m, `${name} must run unchanged in a rehearsal`);
  }
});

test("rehearsal artifacts expire after 3 days; a tag push keeps 90", () => {
  const build = job("build");
  assert.match(build, /^ {10}retention-days: \$\{\{ github\.event_name == 'push' && 90 \|\| 3 \}\}$/m);
});

// A step's `run: |` block, unindented. It stops at the first line outside the
// block, so the comments that open the next step are not part of the script.
function runBlock(step) {
  const body = step.split("\n");
  const start = body.findIndex((line) => line === "        run: |");
  assert.notEqual(start, -1, "missing run block");
  const block = [];
  for (const line of body.slice(start + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    block.push(line.slice(10));
  }
  return block.join("\n");
}

function validateScript() {
  return runBlock(namedStep(job("validate"), "Release version matches every manifest"));
}

function runValidate({ eventName, refType, refName, pkg = "0.3.6", tauri = "0.3.6", cargo = "0.3.6" }) {
  const directory = mkdtempSync(join(tmpdir(), "goop-release-validate-"));
  try {
    mkdirSync(join(directory, "src-tauri"));
    writeFileSync(join(directory, "package.json"), pkg === null ? "{}" : JSON.stringify({ version: pkg }));
    writeFileSync(join(directory, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: tauri }));
    writeFileSync(
      join(directory, "Cargo.toml"),
      cargo === null ? "[workspace]\n" : `[workspace.package]\nversion = "${cargo}"\n`,
    );
    const output = join(directory, "github-output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", validateScript()], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_REF_TYPE: refType,
        GITHUB_REF_NAME: refName,
        GITHUB_OUTPUT: output,
      },
    });
    return { status: result.status, log: result.stdout + result.stderr, output: readFileSync(output, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("validate accepts a matching tag push or agreeing manifests, and nothing else", async (t) => {
  const tagPush = { eventName: "push", refType: "tag" };
  const rehearsal = { eventName: "workflow_dispatch", refType: "branch", refName: "main" };
  await t.test("tag push that matches every manifest", () => {
    const run = runValidate({ ...tagPush, refName: "v0.3.6" });
    assert.equal(run.status, 0, run.log);
    assert.equal(run.output, "version=0.3.6\n");
  });
  await t.test("tag push that disagrees with the manifests", () => {
    const run = runValidate({ ...tagPush, refName: "v0.3.7" });
    assert.equal(run.status, 1, run.log);
    assert.equal(run.output, "");
  });
  await t.test("rehearsal whose manifests agree", () => {
    const run = runValidate(rehearsal);
    assert.equal(run.status, 0, run.log);
    assert.equal(run.output, "version=0.3.6\n");
  });
  await t.test("rehearsal dispatched on a tag ref compares manifests, not the tag", () => {
    const run = runValidate({ eventName: "workflow_dispatch", refType: "tag", refName: "v0.3.7" });
    assert.equal(run.status, 0, run.log);
    assert.equal(run.output, "version=0.3.6\n");
  });
  await t.test("rehearsal whose manifests disagree", () => {
    const run = runValidate({ ...rehearsal, tauri: "0.3.5" });
    assert.equal(run.status, 1, run.log);
    assert.equal(run.output, "");
  });
  await t.test("rehearsal with an unreadable Cargo.toml", () => {
    const run = runValidate({ ...rehearsal, cargo: null });
    assert.equal(run.status, 1, run.log);
    assert.equal(run.output, "");
  });
  await t.test("rehearsal with an unreadable package.json", () => {
    const run = runValidate({ ...rehearsal, pkg: null });
    assert.equal(run.status, 1, run.log);
    assert.equal(run.output, "");
  });
});

test("audit executes the pinned static Little CMS transform on both release targets", () => {
  const smoke = auditJob("sidecar-smoke");
  assert.match(smoke, /os: \[macos-14, windows-latest\]/);
  const step = smoke.match(/ {6}- name: Portable color static link\n([\s\S]*?)\n {6}- name: Image conversion correctness/);
  assert.ok(step, "missing bounded portable color static-link step");
  assert.doesNotMatch(step[0], /^\s*if:/m);
  assert.match(step[0], /cargo tree -p lcms2@6\.2\.0 --depth 1 --prefix none/);
  assert.match(step[0], /grep -qx 'lcms2-sys v4\.0\.7'/);
  assert.match(step[0], /cargo clean -p lcms2-sys/);
  assert.match(step[0], /env -u LCMS2_LIB_DIR -u LCMS2_INCLUDE_DIR cargo test/);
  assert.match(step[0], /--test lcms_static/);
  assert.match(step[0], /otool -L "\$BIN"/);
  assert.match(step[0], /objdump\.exe -p "\$BIN"/);
  assert.match(step[0], /lcms2\[\^ \]\*\\\.dll/);
});

test("Windows audit keeps the immutable libheif 1.23 vcpkg tree outside the macOS release", () => {
  const installer = "./scripts/install-windows-heif-deps.sh";
  assert.equal(auditWorkflow.match(new RegExp(installer.replaceAll(".", "\\."), "g"))?.length, 1);
  assert.equal(workflow.match(new RegExp(installer.replaceAll(".", "\\."), "g"))?.length ?? 0, 0);
  assert.match(windowsHeifInstaller, /VCPKG_COMMIT="[0-9a-f]{40}"/);
  assert.match(windowsHeifInstaller, /checkout --detach "\$VCPKG_COMMIT"/);
  assert.match(windowsHeifInstaller, /libheif\[core\]:x64-windows-static/);
  assert.match(auditWorkflow, /hashFiles\('scripts\/install-windows-heif-deps\.sh'\)/);
  assert.doesNotMatch(workflow, /hashFiles\('scripts\/install-windows-heif-deps\.sh'\)/);
});

// libde265 and libheif are linked statically into the app and built for the
// macOS floor tauri.conf.json declares (see heif-deps.test.mjs). A cache
// restore must never hand a build the stack made for another floor.
const declaredFloor = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"))
  .bundle.macOS.minimumSystemVersion;
const floorCli = fileURLToPath(new URL("./macos-deployment-target.mjs", import.meta.url));
const heifCacheKey =
  "heif-deps-${{ runner.os }}-macos-${{ steps.macos-floor.outputs.version }}-" +
  "${{ hashFiles('scripts/build-static-heif-deps.sh') }}";

function steps(body) {
  return body.split(/\n(?= {6}- )/).filter((step) => step.startsWith("      - "));
}

function stepScript(step) {
  const body = step.split("\n");
  const start = body.findIndex((line) => line === "        run: |");
  assert.notEqual(start, -1, "missing run block");
  const block = [];
  for (const line of body.slice(start + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    block.push(line.slice(10));
  }
  return block.join("\n");
}

test("every HEIC cache key carries the macOS floor the stack was built for", () => {
  // Not hashFiles('src-tauri/tauri.conf.json'): that file also holds the app
  // version, so every release would throw away a stack that is still good.
  const jobs = [
    ["release build", job("build")],
    ["audit rust", auditJob("rust")],
    ["audit sidecar-smoke", auditJob("sidecar-smoke")],
  ];
  const floorScripts = new Set();
  for (const [name, body] of jobs) {
    const list = steps(body);
    const cacheAt = list.findIndex((step) => /^ {10}path: \.heif-deps$/m.test(step));
    assert.notEqual(cacheAt, -1, `${name} has no HEIC cache`);
    const cache = list[cacheAt];
    assert.ok(cache.split("\n").includes(`          key: ${heifCacheKey}`), `${name} cache key:\n${cache}`);
    const floorAt = list.findIndex((step) => /^ {8}id: macos-floor$/m.test(step));
    assert.ok(floorAt !== -1 && floorAt < cacheAt, `${name} must read the floor before restoring the cache`);
    const condition = (step) => step.match(/^ {8}if: (.*)$/m)?.[1];
    assert.equal(condition(list[floorAt]), condition(cache), `${name}: the floor step and the cache run together`);
    floorScripts.add(stepScript(list[floorAt]));
  }
  assert.equal(floorScripts.size, 1, "every job reads the floor the same way");
  const cached = `${workflow}\n${auditWorkflow}`.match(/^ {10}path: \.heif-deps$/gm) ?? [];
  assert.equal(cached.length, jobs.length, "a HEIC cache outside these jobs would need the same key");
});

test("the cache-key floor step fails closed when tauri.conf.json declares no floor", () => {
  const floorStep = steps(job("build")).find((step) => /^ {8}id: macos-floor$/m.test(step));
  assert.ok(floorStep, "missing macos-floor step");
  const script = stepScript(floorStep);
  const run = (config, helper = readFileSync(floorCli, "utf8")) => {
    const directory = mkdtempSync(join(tmpdir(), "goop-floor-step-"));
    try {
      for (const sub of ["scripts", "src-tauri"]) mkdirSync(join(directory, sub));
      writeFileSync(join(directory, "scripts", "macos-deployment-target.mjs"), helper);
      writeFileSync(join(directory, "src-tauri", "tauri.conf.json"), JSON.stringify(config));
      const output = join(directory, "github-output");
      writeFileSync(output, "");
      // Unspecified `shell:` on a Linux or macOS runner is `bash -e {0}`: no pipefail.
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: output },
      });
      return { status: result.status, log: result.stdout + result.stderr, output: readFileSync(output, "utf8") };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  const declared = run({ bundle: { macOS: { minimumSystemVersion: declaredFloor } } });
  assert.equal(declared.status, 0, declared.log);
  assert.equal(declared.output, `version=${declaredFloor}\n`);
  const missing = run({ bundle: { macOS: {} } });
  assert.notEqual(missing.status, 0, missing.log);
  assert.equal(missing.output, "", "an empty floor must never reach the cache key");
  const silent = run({ bundle: { macOS: { minimumSystemVersion: declaredFloor } } }, "// prints nothing, exits 0\n");
  assert.notEqual(silent.status, 0, silent.log);
  assert.equal(silent.output, "", "an empty floor must never reach the cache key");
});

// A rust-cache entry is 0.2-2.2 GB per job. One saved from a pull request is
// scoped to refs/pull/N/merge, where no other run can restore it, and a few
// open PRs filled the 10 GB repository quota until LRU eviction dropped
// main's caches, the only ones every run can restore. A tag's entry is
// scoped to that tag, where no later release or audit run can restore it.
const mainOnlySave = "${{ github.ref == 'refs/heads/main' }}";

// Every `uses:` line, counted from the raw text so that a step the parser
// below misreads still counts against it.
function rustCacheUses(body) {
  return body.match(/^[ -]*uses: Swatinem\/rust-cache@/gm)?.length ?? 0;
}

function rustCacheSteps(body) {
  return steps(body).filter((step) => /^ {6}- uses: Swatinem\/rust-cache@|^ {8}uses: Swatinem\/rust-cache@/m.test(step));
}

// Deliberately exact: block-style `with:`, the value as the workflows write it.
function saveIf(step) {
  return step.match(/^ {10}save-if: (.*)$/m)?.[1];
}

test("audit saves the Rust cache from main only, so PR runs restore main's", () => {
  const jobs = ["rust", "legal", "sidecar-smoke"];
  for (const name of jobs) {
    const cached = rustCacheSteps(auditJob(name));
    assert.equal(cached.length, 1, `audit ${name} has one rust-cache step`);
    assert.equal(saveIf(cached[0]), mainOnlySave, `audit ${name}:\n${cached[0]}`);
  }
  assert.equal(rustCacheUses(auditWorkflow), jobs.length, "a rust-cache step outside these jobs needs the same save-if");
});

test("release restores the Rust cache but never saves one", () => {
  const jobs = ["build", "legal"];
  for (const name of jobs) {
    const cached = rustCacheSteps(job(name));
    assert.equal(cached.length, 1, `release ${name} has one rust-cache step`);
    assert.equal(saveIf(cached[0]), '"false"', `release ${name}:\n${cached[0]}`);
  }
  assert.equal(rustCacheUses(workflow), jobs.length, "a rust-cache step outside these jobs needs the same save-if");
});

test("no workflow saves a Rust cache outside main", () => {
  for (const { name, body } of workflows) {
    assert.equal(rustCacheSteps(body).length, rustCacheUses(body), `${name}: a rust-cache step the parser missed`);
    for (const step of rustCacheSteps(body)) {
      assert.ok([mainOnlySave, '"false"'].includes(saveIf(step)), `${name}:\n${step}`);
    }
  }
});

test("both quality gates run the HEIC stack tests, and audit runs them on macOS too", () => {
  const prePush = readFileSync(new URL("./pre-push.sh", import.meta.url), "utf8");
  assert.match(prePush, /node --test scripts\/heif-deps\.test\.mjs/);
  assert.match(auditJob("web"), /- run: node --test scripts\/heif-deps\.test\.mjs/);
  // The web job is Linux, where the tests that build real archives skip.
  const step = namedStep(auditJob("sidecar-smoke"), "HEIC stack tests (macOS)");
  assert.match(step, /^ {8}if: matrix\.os == 'macos-14'$/m);
  assert.match(step, /^ {8}run: node --test scripts\/heif-deps\.test\.mjs$/m);
});

test("Windows audit records fresh-process HEIC preview memory evidence", () => {
  const smoke = auditJob("sidecar-smoke");
  const handoff = smoke.match(
    / {6}- name: Cargo check \(Windows-only paths\)\n([\s\S]*?)\n {6}- name: HEIC preview fresh-process memory \(Windows\)/,
  );
  assert.ok(handoff, "missing Windows HEIC preview executable handoff");
  assert.match(
    handoff[0],
    /CARGO_INCREMENTAL=0 cargo test -p goop-converter --release --features heic-thumbnail-preview --lib --no-run --message-format=json/,
  );
  assert.match(handoff[0], /printf 'HEIC_PREVIEW_TEST_BINARY=%s\\n' "\$BIN" >> "\$GITHUB_ENV"/);

  const step = smoke.match(
    / {6}- name: HEIC preview fresh-process memory \(Windows\)\n([\s\S]*?)\n {6}- name: Lossy WebP static link/,
  );
  assert.ok(step, "missing Windows HEIC preview memory evidence step");
  assert.match(step[0], /if: matrix\.os == 'windows-latest'/);
  assert.match(step[0], /shell: pwsh/);
  assert.match(step[0], /memory_probe_baseline_without_decode/);
  assert.match(step[0], /memory_probe_12mp_primary_with_512x384_thumbnail/);
  assert.match(step[0], /memory_probe_48mp_primary_with_512x384_thumbnail/);
  assert.match(step[0], /memory_probe_exact_4mp_thumbnail/);
  assert.match(step[0], /\$binary = \$env:HEIC_PREVIEW_TEST_BINARY/);
  assert.match(step[0], /for \(\$iteration = 0; \$iteration -lt 6; \$iteration\+\+\)/);
  assert.match(step[0], /@\("--quiet", "--exact", \$case\.Value, "--ignored"\)/);
  assert.match(step[0], /if \(\$process\.ExitCode -ne 0\)/);
  assert.match(step[0], /PeakWorkingSet64/);
  assert.match(step[0], /if \(\$peak -le 0\)/);
  assert.match(step[0], /if \(\$iteration -gt 0\)/);
  assert.match(step[0], /\$median = \[long\]\$ordered\[2\]/);
  assert.match(step[0], /HEIC_PREVIEW_MEMORY/);
  assert.match(step[0], /if \(\$primaryDelta -gt 16MB\)/);
});

const version = "0.3.6";
const replacementCandidateVersion = "0.3.6";
const installers = [
  `Goop_${version}_aarch64.dmg`,
  "Goop_aarch64.app.tar.gz",
];
const expectedAssets = [...installers, ...installers.map((name) => `${name}.sha256`)].sort();
const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test("candidate manifests agree on the release version", () => {
  assert.equal(packageVersion, version);
  assert.equal(packageLock.version, version);
  assert.equal(packageLock.packages[""].version, version);
  assert.equal(tauriVersion, version);
  assert.equal(cargoVersion, version);
});

test("replacement candidate advances every release version authority to v0.3.6", () => {
  assert.deepEqual(
    {
      workspaceCargo: cargoVersion,
      packageJson: packageVersion,
      packageLockTopLevel: packageLock.version,
      packageLockRootPackage: packageLock.packages[""].version,
      tauriConfig: tauriVersion,
      releaseWorkflowFixture: version,
    },
    {
      workspaceCargo: replacementCandidateVersion,
      packageJson: replacementCandidateVersion,
      packageLockTopLevel: replacementCandidateVersion,
      packageLockRootPackage: replacementCandidateVersion,
      tauriConfig: replacementCandidateVersion,
      releaseWorkflowFixture: replacementCandidateVersion,
    },
  );
});

test("static website offers only a macOS installer at or above the minimum safe version", () => {
  assert.doesNotMatch(siteHtml, /data-download-paused|temporarily paused/i);
  assert.match(siteHtml, /data-cta="mac"/);
  assert.doesNotMatch(siteHtml, /data-win-url|\.msi\b|\.exe\b|Download for Windows/);
  // v0.3.6 is the first build whose bundled gallery-dl carries the patched
  // urllib3; the site must never promote an older one as current.
  assert.match(siteScript, /MIN_MAC_VERSION\s*=\s*\[\s*0\s*,\s*3\s*,\s*6\s*\]/);
  assert.doesNotMatch(siteScript, /\.msi\b|\.exe\b|data-win-url/);
  assert.match(siteScript, /makeLink\(notesURL, 'Release page'\)/);
});

function inlinePublishScript() {
  const body = job("publish").split("\n");
  const start = body.findIndex((line) => line === "          script: |");
  assert.notEqual(start, -1, "missing inline publish script");
  return body.slice(start + 1).map((line) => line.startsWith("            ") ? line.slice(12) : line).join("\n");
}

async function exercisePublish({
  releases = [],
  initialAssets = [],
  missingAsset = null,
  extraAssets = [],
  duplicateAsset = null,
  corruptChecksum = false,
  failFirstUpload = null,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "goop-release-contract-"));
  const previous = process.cwd();
  const previousVersion = process.env.RELEASE_VERSION;
  const state = {
    releases: releases.map((release) => ({ ...release })),
    assets: initialAssets.map((name, index) => ({ id: index + 1, name })),
    created: 0,
    deleted: [],
    uploads: [],
    failures: [],
    failedOnce: false,
  };
  try {
    const root = "release-input/macos";
    mkdirSync(join(directory, root), { recursive: true });
    for (const [index, name] of installers.entries()) {
      const bytes = Buffer.from(`installer:${name}`);
      if (missingAsset !== name) writeFileSync(join(directory, root, name), bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const writtenHash = corruptChecksum && index === 0 ? "0".repeat(64) : hash;
      if (missingAsset !== `${name}.sha256`) {
        writeFileSync(join(directory, root, `${name}.sha256`), `${writtenHash}  ${name}\n`);
      }
    }
    for (const name of extraAssets) {
      writeFileSync(join(directory, root, name), `extra:${name}`);
    }
    if (duplicateAsset) {
      const duplicateRoot = "release-input/duplicate";
      mkdirSync(join(directory, duplicateRoot), { recursive: true });
      writeFileSync(join(directory, duplicateRoot, duplicateAsset), `duplicate:${duplicateAsset}`);
    }
    process.chdir(directory);
    process.env.RELEASE_VERSION = version;

    const listReleases = async () => ({ data: state.releases });
    const listReleaseAssets = async () => ({ data: state.assets });
    const github = {
      paginate: async (method) => method === listReleases ? state.releases : state.assets,
      rest: { repos: {
        listReleases,
        listReleaseAssets,
        createRelease: async ({ tag_name, name, draft, prerelease }) => {
          state.created += 1;
          const release = { id: 77, tag_name, name, draft, prerelease };
          state.releases.push(release);
          return { data: release };
        },
        getRelease: async ({ release_id }) => ({ data: state.releases.find((release) => release.id === release_id) ?? { id: release_id, draft: true } }),
        deleteReleaseAsset: async ({ asset_id }) => {
          state.deleted.push(asset_id);
          state.assets = state.assets.filter((asset) => asset.id !== asset_id);
        },
        uploadReleaseAsset: async ({ name, data }) => {
          for await (const _chunk of data) { /* drain the exact stream shape used by github-script */ }
          state.uploads.push(name);
          state.assets.push({ id: 100 + state.uploads.length, name });
          if (name === failFirstUpload && !state.failedOnce) {
            state.failedOnce = true;
            throw new Error("ambiguous upload failure");
          }
          return { data: { name } };
        },
      } },
    };
    const core = {
      info: () => {},
      setFailed: (message) => state.failures.push(message),
    };
    const context = { ref: `refs/tags/v${version}`, repo: { owner: "thrtn70", repo: "goop" } };
    await new AsyncFunction("github", "context", "core", "require", inlinePublishScript())(github, context, core, require);
    return state;
  } finally {
    process.chdir(previous);
    if (previousVersion === undefined) delete process.env.RELEASE_VERSION;
    else process.env.RELEASE_VERSION = previousVersion;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("inline publisher validates bytes and release state before mutating a draft", async (t) => {
  await t.test("creates one draft with the exact four-asset allowlist", async () => {
    const state = await exercisePublish();
    assert.deepEqual(state.failures, []);
    assert.equal(state.created, 1);
    assert.deepEqual(state.assets.map((asset) => asset.name).sort(), expectedAssets);
  });

  await t.test("refuses missing and extra inputs before any release API mutation", async () => {
    const missing = await exercisePublish({ missingAsset: expectedAssets[0] });
    assert.match(missing.failures[0], /allowlist mismatch/);
    assert.equal(missing.created, 0);
    assert.deepEqual(missing.uploads, []);

    const extra = await exercisePublish({ extraAssets: ["unexpected.zip"] });
    assert.match(extra.failures[0], /allowlist mismatch/);
    assert.equal(extra.created, 0);
    assert.deepEqual(extra.uploads, []);
  });

  await t.test("refuses Windows release inputs and duplicate asset names", async () => {
    const windows = await exercisePublish({ extraAssets: [`Goop_${version}_x64-setup.exe`] });
    assert.match(windows.failures[0], /allowlist mismatch/);
    assert.match(windows.failures[0], /x64-setup\.exe/);
    assert.equal(windows.created, 0);
    assert.deepEqual(windows.uploads, []);

    const duplicate = await exercisePublish({ duplicateAsset: expectedAssets[0] });
    assert.match(duplicate.failures[0], /duplicate release asset name/);
    assert.equal(duplicate.created, 0);
    assert.deepEqual(duplicate.uploads, []);
  });

  await t.test("refuses a checksum mismatch before any release API mutation", async () => {
    const state = await exercisePublish({ corruptChecksum: true });
    assert.match(state.failures[0], /checksum mismatch/);
    assert.equal(state.created, 0);
    assert.deepEqual(state.uploads, []);
  });

  await t.test("refuses published releases and stale draft assets", async () => {
    const published = await exercisePublish({ releases: [{ id: 8, tag_name: `v${version}`, draft: false }] });
    assert.match(published.failures[0], /already published/);
    assert.deepEqual(published.uploads, []);

    const stale = await exercisePublish({
      releases: [{ id: 9, tag_name: `v${version}`, draft: true }],
      initialAssets: ["unexpected.zip"],
    });
    assert.match(stale.failures[0], /unexpected assets: unexpected\.zip/);
    assert.deepEqual(stale.deleted, []);
    assert.deepEqual(stale.uploads, []);
  });

  await t.test("recovers an ambiguous upload by replacing the persisted duplicate", async () => {
    const state = await exercisePublish({
      releases: [{ id: 10, tag_name: `v${version}`, draft: true }],
      failFirstUpload: expectedAssets[0],
    });
    assert.deepEqual(state.failures, []);
    assert.equal(state.uploads.length, expectedAssets.length + 1);
    assert.equal(state.deleted.length, 1);
    assert.deepEqual(state.assets.map((asset) => asset.name).sort(), expectedAssets);
  });
});

test("the macOS bundle declares the floor its bundled tools need", () => {
  // Tailwind 4's output relies on cascade layers, color-mix() and @property,
  // all present from Safari 16.4, which macOS 13.3's system WebKit matches.
  // The bundled PDF tools set the higher floor: gs, mutool and their
  // libraries are built for macOS 14.0. The bundled tesseract is built for
  // 14.8.5, so OCR on earlier 14.x releases remains a known gap.
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.equal(config.bundle.macOS.minimumSystemVersion, "14.0");
});

const floorStep = "Verify the macOS deployment floor";

test("the signed bundle must carry the declared macOS floor before assets are staged", () => {
  const build = job("build");
  const step = namedStep(build, floorStep);
  assert.match(step, /^ {8}if: matrix\.os == 'macos-14'$/m);
  assert.match(step, /^ {8}shell: bash$/m);
  assert.match(step, /^ {10}TARGET: \$\{\{ matrix\.target \}\}$/m);
  const script = runBlock(step);
  assert.doesNotMatch(script, /\$\{\{/, "the script takes the target from env, not from an interpolated expression");
  assert.match(script, /minimumSystemVersion/);
  assert.match(script, /\/usr\/libexec\/PlistBuddy -c 'Print :LSMinimumSystemVersion'/);
  assert.match(script, /vtool -show-build/);

  const at = (needle) => {
    const index = build.indexOf(needle);
    assert.notEqual(index, -1, `missing ${needle}`);
    return index;
  };
  assert.ok(at("tauri-apps/tauri-action@") < at(`- name: ${floorStep}`), "the check reads the bundle tauri-action built");
  assert.ok(
    at(`- name: ${floorStep}`) < at("- name: Verify signed sidecars run (macOS)"),
    "a failing sidecar smoke test must not swallow the minos report",
  );
  assert.ok(at(`- name: ${floorStep}`) < at("- name: Stage release assets"), "assets must not be staged before the check");
});

// Mach-O fixtures hold only a header and the one load command vtool reads, so
// each case states its minimum macOS directly.
const cpuTypes = { arm64: [0x0100000c, 0], x86_64: [0x01000007, 3], x86_64h: [0x01000007, 8] };

function packVersion(version) {
  const [major, minor = 0, patch = 0] = version.split(".").map(Number);
  return (major << 16) | (minor << 8) | patch;
}

// Real binaries carry an SDK newer than the macOS they require, so every
// fixture does too: a check that read the SDK instead of the minimum would
// then report 26.0 and fail, rather than pass by coincidence.
const FIXTURE_SDK = "26.0";

// [arch, version] writes LC_BUILD_VERSION; [arch, version, "min"] writes the
// LC_VERSION_MIN_MACOSX that x86_64 slices built for macOS 10.13 still carry.
function machSlice([arch, version, command = "build"]) {
  const load = Buffer.alloc(command === "build" ? 24 : 16);
  load.writeUInt32LE(command === "build" ? 0x32 : 0x24, 0);
  load.writeUInt32LE(load.length, 4);
  if (command === "build") {
    load.writeUInt32LE(1, 8); // PLATFORM_MACOS
    load.writeUInt32LE(packVersion(version), 12); // minos
    load.writeUInt32LE(packVersion(FIXTURE_SDK), 16); // sdk
  } else {
    load.writeUInt32LE(packVersion(version), 8); // version
    load.writeUInt32LE(packVersion(FIXTURE_SDK), 12); // sdk
  }
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  header.writeUInt32LE(cpuTypes[arch][0], 4);
  header.writeUInt32LE(cpuTypes[arch][1], 8);
  header.writeUInt32LE(2, 12); // MH_EXECUTE
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(load.length, 20);
  return Buffer.concat([header, load]);
}

function machO(slices) {
  if (slices.length === 1) return machSlice(slices[0]);
  const page = 4096;
  const fat = Buffer.alloc(page * (slices.length + 1));
  fat.writeUInt32BE(0xcafebabe, 0); // FAT_MAGIC
  fat.writeUInt32BE(slices.length, 4);
  slices.forEach((slice, index) => {
    const bytes = machSlice(slice);
    const entry = 8 + 20 * index;
    const offset = page * (index + 1);
    fat.writeUInt32BE(cpuTypes[slice[0]][0], entry);
    fat.writeUInt32BE(cpuTypes[slice[0]][1], entry + 4);
    fat.writeUInt32BE(offset, entry + 8);
    fat.writeUInt32BE(bytes.length, entry + 12);
    fat.writeUInt32BE(12, entry + 16);
    bytes.copy(fat, offset);
  });
  return fat;
}

function infoPlist(entries) {
  const body = Object.entries(entries)
    .map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

// Shaped like the shipped bundle: a static upstream build, a universal
// PyInstaller binary and Homebrew bottles built on the macOS 14 runner.
const bundledBinaries = {
  ffmpeg: [["arm64", "12.0"]],
  "yt-dlp": [["x86_64", "10.13", "min"], ["arm64", "11.0"]],
  gs: [["arm64", "14.0"]],
  "libtiff.6.dylib": [["arm64", "14.0"]],
};

function runFloorCheck({
  floor = "13.3",
  plist = { LSMinimumSystemVersion: "13.3" },
  main = [["arm64", "13.3"]],
  bundled = bundledBinaries,
  bundle = true,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "goop-release-floor-"));
  try {
    mkdirSync(join(directory, "src-tauri"));
    const macOS = floor === null ? {} : { minimumSystemVersion: floor };
    writeFileSync(join(directory, "src-tauri", "tauri.conf.json"), JSON.stringify({ bundle: { macOS } }));
    if (bundle) {
      const contents = join(directory, "target", "aarch64-apple-darwin", "release", "bundle", "macos", "Goop.app", "Contents");
      mkdirSync(join(contents, "MacOS"), { recursive: true });
      writeFileSync(join(contents, "Info.plist"), infoPlist({ CFBundleExecutable: "goop", ...plist }));
      writeFileSync(join(contents, "MacOS", "goop"), Array.isArray(main) ? machO(main) : main);
      for (const [name, slices] of Object.entries(bundled)) {
        writeFileSync(join(contents, "MacOS", name), Array.isArray(slices) ? machO(slices) : slices);
      }
    }
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", runBlock(namedStep(job("build"), floorStep))],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, TARGET: "aarch64-apple-darwin", PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
      },
    );
    return { status: result.status, log: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const needsMacTools = process.platform === "darwin" ? {} : { skip: "runs the real vtool and PlistBuddy, which only macOS has" };

test("the floor check passes a bundle at the declared floor and reports every other binary", needsMacTools, () => {
  const run = runFloorCheck();
  assert.equal(run.status, 0, run.log);
  assert.doesNotMatch(run.log, /::error::/);
  assert.match(run.log, /^ffmpeg +12\.0$/m);
  assert.match(run.log, /^yt-dlp +x86_64 10\.13, arm64 11\.0$/m);
  assert.match(run.log, /^gs +14\.0 +above the 13\.3 floor$/m);
  assert.match(run.log, /^libtiff\.6\.dylib +14\.0 +above the 13\.3 floor$/m);
  assert.doesNotMatch(run.log, /^goop /m, "the main executable is checked, not listed with the sidecars");
  const warnings = run.log.split("\n").filter((line) => line.startsWith("::warning::"));
  assert.equal(warnings.length, 1, run.log);
  assert.match(warnings[0], /declared 13\.3/);
  assert.match(warnings[0], /gs \(14\.0\), libtiff\.6\.dylib \(14\.0\)$/);
});

test("the floor check says nothing above the floor when no bundled binary needs more", needsMacTools, () => {
  const run = runFloorCheck({ bundled: { ffmpeg: bundledBinaries.ffmpeg, "yt-dlp": bundledBinaries["yt-dlp"] } });
  assert.equal(run.status, 0, run.log);
  assert.doesNotMatch(run.log, /::warning::|above the/);
});

test("the floor check fails a bundle that does not carry the declared floor", needsMacTools, async (t) => {
  const fails = (options, pattern) => {
    const run = runFloorCheck(options);
    assert.equal(run.status, 1, run.log);
    assert.match(run.log, pattern);
    return run;
  };
  await t.test("Info.plist keeps Tauri's 10.13 default", () => {
    fails({ plist: { LSMinimumSystemVersion: "10.13" } }, /::error::.*LSMinimumSystemVersion.*10\.13.*13\.3/);
  });
  await t.test("Info.plist has no LSMinimumSystemVersion", () => {
    fails({ plist: {} }, /::error::.*LSMinimumSystemVersion/);
  });
  await t.test("Info.plist names a later point release than the floor", () => {
    fails({ plist: { LSMinimumSystemVersion: "13.3.1" } }, /::error::.*LSMinimumSystemVersion.*13\.3\.1.*13\.3/);
  });
  await t.test("the executable was linked at Rust's 11.0 default", () => {
    fails({ main: [["arm64", "11.0"]] }, /::error::goop .*11\.0.*13\.3/);
  });
  await t.test("the executable was linked above the declared floor", () => {
    fails({ main: [["arm64", "14.0"]] }, /::error::goop .*14\.0.*13\.3/);
  });
  await t.test("one slice of a universal executable misses the floor", () => {
    fails({ main: [["x86_64", "13.3"], ["arm64", "11.0"]] }, /::error::goop arm64 .*11\.0/);
  });
  await t.test("the executable carries no build version", () => {
    fails({ main: "#!/bin/sh\n" }, /::error::.*goop.*no macOS build version/);
  });
  await t.test("tauri.conf.json declares no floor", () => {
    fails({ floor: null }, /::error::bundle\.macOS\.minimumSystemVersion is unset/);
  });
  await t.test("no bundle was built", () => {
    fails({ bundle: false }, /::error::no \.app bundle found/);
  });
  await t.test("the sidecar report survives a failing check", () => {
    for (const options of [{ plist: { LSMinimumSystemVersion: "10.13" } }, { main: [["arm64", "11.0"]] }]) {
      const run = fails(options, /^gs +14\.0 +above the 13\.3 floor$/m);
      assert.match(run.log, /^::warning::.*gs \(14\.0\)/m);
    }
  });
});

test("only a slice that runs on Apple Silicon can raise the floor warning", needsMacTools, () => {
  const run = runFloorCheck({
    bundled: {
      universal: [["arm64", "11.0"], ["x86_64", "14.0"]],
      "intel-only": [["x86_64", "14.0"], ["x86_64h", "14.0"]],
    },
  });
  assert.equal(run.status, 0, run.log);
  assert.match(run.log, /^universal +arm64 11\.0, x86_64 14\.0$/m);
  assert.match(run.log, /^intel-only +x86_64 14\.0, x86_64h 14\.0 +above the 13\.3 floor$/m);
  assert.match(run.log, /^::warning::.*: intel-only \(14\.0\)$/m);
});

test("audit runs the floor check's tests on macOS, where they are not skipped", () => {
  const step = namedStep(auditJob("sidecar-smoke"), "Release workflow tests (macOS)");
  assert.match(step, /^ {8}if: matrix\.os == 'macos-14'$/m);
  assert.match(step, /node --test scripts\/release-workflow\.test\.mjs/);
});

test("an unreadable bundled file is reported, never fatal", needsMacTools, () => {
  const run = runFloorCheck({ bundled: { ...bundledBinaries, "notes.txt": "not a binary\n" } });
  assert.equal(run.status, 0, run.log);
  assert.match(run.log, /^notes\.txt +no macOS build version$/m);
});
